#!/usr/bin/env bash
# S8 부하 실측을 한 번에 돌린다 (PER-005·006·007·008). 부하 서버(앱 서버와 다른 클라우드 서버)에서 실행한다.
#
#   PERF_TARGET=https://시험서버 PERF_ORIGIN=https://시험서버 perf/run-s8.sh [all|connections|locations]
#
# 접근 토큰은 15분이면 끝나서, 시나리오마다 '준비 스크립트 → 바로 실행'을 이어서 한다.
#   connections : 병원 PC 1,230 + 대원 앱 3,300 연결을 유지하는 동안(PER-005) 이송 300건을 돌린다(PER-006·007)
#   locations   : 이동 중 300건이 5초마다 위치 기록 (PER-008)
#   all         : 위 둘을 차례로 (기본)
#
# 준비 스크립트(npm run perf:*)는 DB 와 서버의 JWT_SECRET 이 있는 곳에서 돌아야 한다.
#   - PREP_SSH 가 비어 있으면 이 컴퓨터의 저장소에서 바로 돌린다 (내 컴퓨터 연습, 또는 부하 서버에 DB 가 보일 때)
#   - PREP_SSH=ubuntu@시험서버 이면 그 서버의 PREP_DIR 저장소에서 돌리고 만든 CSV 를 scp 로 가져온다
# 준비 스크립트는 NODE_ENV=production 이면 거부한다. 부하는 반드시 시험용 DB 를 쓰는 서버에 준다.
# 결과는 perf/results/s8-날짜시각/ 에 모인다 (git 에 올리지 않음). 요약은 docs/perf/ 에 손으로 쓴다.
set -euo pipefail

# ---- 바꿀 수 있는 값 (환경 변수로 덮어쓴다) ----
PCS="${PCS:-1230}"                 # 병원 PC 연결 수 (전국 병원 약 410곳 × 3대)
MEDICS="${MEDICS:-3300}"           # 대원 앱 연결 수
HOSPITALS="${HOSPITALS:-10}"       # 이송 요청을 받는 병원 수 (병원 봇)
TRANSPORTS="${TRANSPORTS:-300}"    # 동시 이송 건수 (30초에 걸쳐 들어온다)
RAMP="${RAMP:-30}"                 # 연결을 늘리는 시간(초)
HOLD="${HOLD:-300}"                # 연결 유지 시간(초). 이송 시나리오(약 3분)가 끝날 때까지 유지돼야 한다
BOT_SECONDS="${BOT_SECONDS:-200}"  # 병원 봇이 요청을 받는 시간(초)
PREP_SSH="${PREP_SSH:-}"
PREP_DIR="${PREP_DIR:-~/Savetime}"
ARTILLERY="${ARTILLERY:-npx --yes artillery@2.0.34}"
TRANSPORT_RAMP=30                  # transports.yml 의 phases.duration 과 같다

: "${PERF_TARGET:?PERF_TARGET 에 시험 서버 주소를 주세요 (예: https://perf.example.com)}"
export PERF_TARGET
export PERF_ORIGIN="${PERF_ORIGIN:-$PERF_TARGET}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RESULTS="perf/results/s8-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS"
STATUS=()

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RESULTS/run.log"; }

# 가상 사용자 수 = 초당 도착 × 시간. 준비한 줄보다 많으면 남는 사용자가 실패하므로 내림으로 나눈다
rate() { local n=$(( $1 / $2 )); (( n < 1 )) && n=1; echo "$n"; }

# 준비 스크립트 실행. $1 = npm 스크립트 이름, 그 뒤 = 인자. 끝에 만들어진 CSV 이름들을 --files 뒤에 준다
prep() {
  local script="$1"; shift
  local args=() files=()
  while (( $# )); do
    if [[ "$1" == "--files" ]]; then shift; files=("$@"); break; fi
    args+=("$1"); shift
  done
  log "준비: npm run $script -- ${args[*]}"
  if [[ -z "$PREP_SSH" ]]; then
    npm run -s "$script" -w server -- "${args[@]}" 2>&1 | tee -a "$RESULTS/run.log"
  else
    ssh "$PREP_SSH" "cd $PREP_DIR && npm run -s $script -w server -- ${args[*]}" 2>&1 | tee -a "$RESULTS/run.log"
    for f in "${files[@]}"; do scp -q "$PREP_SSH:$PREP_DIR/perf/$f" "perf/$f"; done
  fi
}

# Artillery 실행. $1 = 시나리오, $2 = 결과 이름, $3 = --overrides JSON
run_artillery() {
  local scenario="$1" name="$2" overrides="$3" code=0
  log "실행: $scenario"
  $ARTILLERY run "perf/$scenario" --overrides "$overrides" --output "$RESULTS/$name.json" \
    > "$RESULTS/$name.log" 2>&1 || code=$?
  log "끝: $scenario (exit $code) → $RESULTS/$name.log"
  STATUS+=("$name=$code")
}

# 준비한 첫 토큰으로 시험 서버에 한 번 물어본다. 준비한 곳의 JWT_SECRET·DB 가 시험 서버와 다르면
# 모든 요청이 401 TOKEN_REVOKED 가 되는데, 몇 분 돌린 뒤에야 알게 되니 여기서 멈춘다
check_token() {
  local token code
  token="$(sed -n 2p perf/.medics.csv | cut -d, -f1 | tr -d '\r')"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$PERF_TARGET/api/v1/me")"
  if [[ "$code" != "200" ]]; then
    log "멈춤: 준비한 토큰이 시험 서버에서 $code 예요. 준비한 곳의 JWT_SECRET·DATABASE_URL 이 시험 서버와 같은지 확인하세요"
    exit 1
  fi
}

check_machine() {
  # 연결 5,000개 = 열린 파일 5,000개 이상. 기본 1,024 면 연결이 EMFILE 로 실패한다
  local nofile; nofile="$(ulimit -n)"
  if [[ "$nofile" != "unlimited" ]] && (( nofile < 20000 )); then
    log "주의: 열린 파일 한도가 $nofile 이에요. 'ulimit -n 65535' 후 다시 실행하세요"
  fi
  # 알림 시간은 앱 서버 시각과 이 컴퓨터 시각의 차이로 잰다. 시계가 맞아야 한다
  if command -v timedatectl > /dev/null; then
    log "시계 동기화(NTP): $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo 알 수 없음)"
  fi
}

connections() {
  log "== PER-005 연결 유지 + PER-006·007 이송 =="
  prep perf:pcs "$PCS" --files .pcs.csv
  prep perf:dispatch "$HOSPITALS" --files .dispatch-pcs.csv
  # 이송 시나리오도 같은 파일의 앞쪽 대원을 쓴다. 연결만 해 둔 대원이 이송도 하는 것이라 괜찮다
  prep perf:medics "$MEDICS" 0 --files .medics.csv .moving.csv
  check_token

  # 두 연결 시나리오를 함께 띄워 동시 연결 PCS + MEDICS 개를 만든다
  run_artillery hospital-connections.yml hospital-connections \
    "{\"config\":{\"phases\":[{\"duration\":$RAMP,\"arrivalRate\":$(rate "$PCS" "$RAMP")}],\"variables\":{\"holdSeconds\":$HOLD}}}" &
  local pcs_pid=$!
  run_artillery app-connections.yml app-connections \
    "{\"config\":{\"phases\":[{\"duration\":$RAMP,\"arrivalRate\":$(rate "$MEDICS" "$RAMP")}],\"variables\":{\"holdSeconds\":$HOLD}}}" &
  local app_pid=$!

  # 연결이 다 붙은 뒤 병원 봇 → 이송 시나리오
  sleep $(( RAMP + 15 ))
  log "병원 봇 시작 ($BOT_SECONDS 초)"
  node perf/hospital-bot.mjs "$BOT_SECONDS" > "$RESULTS/hospital-bot.log" 2>&1 &
  local bot_pid=$!
  sleep 5
  run_artillery transports.yml transports \
    "{\"config\":{\"phases\":[{\"duration\":$TRANSPORT_RAMP,\"arrivalRate\":$(rate "$TRANSPORTS" "$TRANSPORT_RAMP")}]}}"

  local code=0
  wait "$bot_pid" || code=$?
  STATUS+=("hospital-bot=$code")
  cp perf/results/hospital-bot.json "$RESULTS/" 2> /dev/null || true
  log "연결 유지가 끝나기를 기다려요 (최대 $HOLD 초)"
  # 백그라운드 실행의 STATUS 는 이 셸에 안 남아서 종료 코드는 로그에서 읽는다
  wait "$pcs_pid" "$app_pid" || true
}

locations() {
  log "== PER-008 위치 기록 =="
  prep perf:medics "$TRANSPORTS" "$TRANSPORTS" --files .medics.csv .moving.csv
  check_token
  run_artillery locations.yml locations \
    "{\"config\":{\"phases\":[{\"duration\":5,\"arrivalRate\":$(rate "$TRANSPORTS" 5)}]}}"
}

check_machine
case "${1:-all}" in
  connections) connections ;;
  locations) locations ;;
  all) connections; locations ;;
  *) echo "사용법: $0 [all|connections|locations]"; exit 2 ;;
esac

log "== 요약 =="
for s in "${STATUS[@]}"; do log "  $s"; done
grep -h "^\[.*끝:" "$RESULTS/run.log" | tee "$RESULTS/exit-codes.txt" > /dev/null || true
log "결과: $RESULTS (Checks·vusers.failed·errors.* 를 각 .log 끝에서 확인)"
