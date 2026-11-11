# 부하 테스트 (Artillery)

PER-005·006·007·008을 확인하는 시나리오예요. 기술정의서에 따라 **실측은 S8에 클라우드 서버에서** 해요(노트북 한 대로는 동시 연결 5,000개를 만들기 어려워요). S1에는 내 컴퓨터에서 작은 숫자로 연습했어요. 결과 요약은 `docs/perf/`에 남겨요.

| 요구사항 | 목표 (S8) | 시나리오 | 상태 |
|---|---|---|---|
| PER-005 동시 연결 | 5,000개 (병원 PC 약 1,230 + 대원 앱 약 3,300 + 여유) | `hospital-connections.yml` (병원 PC 쪽), `app-connections.yml` (대원 앱 쪽) | 둘 다 연습 완료 |
| PER-006 요청 → 알림 | 각 3초 이내 | `hospital-bot.mjs` (요청 → 병원), `transports.yml` (병원 응답 → 대원 앱) | 연습 완료. 알림은 통과, **이송 만들기 응답이 느림** (아래 결과) |
| PER-007 동시 이송 | 300건 | `transports.yml` | 연습 완료 (300건 모두 도착까지) |
| PER-008 위치 기록 | 초당 60건, 95%를 1초 안에 저장 | `locations.yml` | 연습 완료. 확정 요청·이상치 판정 넣고 재측정 (`docs/perf/S7-위치기록-재측정.md`) |
| (참고) 병원 웹 REST | 다시 연결될 때 몰리는 호출 | `hospital-api.yml` | 연습 완료 |

## 준비
Artillery는 서버·웹 실행에 필요 없고 크기가 커서 프로젝트에 설치하지 않아요. `npx`로 **버전을 고정해서** 실행해요.

1. DB·Redis 켜기: `docker compose up -d`
2. 부하 테스트용 병원 PC 만들기 (개발 DB에서만, 운영에서는 실행되지 않아요)
   ```bash
   npm run perf:pcs -w server -- 200
   ```
   - 병원당 PC 3대씩 `PERF-H0001…` 병원을 만들고, 쿠키를 `perf/.pcs.csv`에 써요
   - 다시 돌리면 앞서 만든 부하 테스트 PC는 해제하고 새로 만들어요
   - `.pcs.csv`(PC 인증 값)와 `results/`는 git에 올리지 않아요
3. 부하 테스트용 대원 만들기 (대원 앱 연결·위치 기록용, 개발 DB에서만)
   ```bash
   npm run perf:medics -w server -- 300 300
   ```
   - 첫 숫자는 대원 수, 둘째는 그중 '이동 중' 이송 건을 가진 대원 수예요
   - 대원 `perf-m0001…`(소방서 `PERF-AG`)마다 팀 1개를 만들고, 접근 토큰을 `perf/.medics.csv`에 써요
   - 이동 중 이송 건은 목적지 `PERF-DEST` 병원으로 넣고, 경로 안내 담당 단말(`perf-device-N`)도 정해 둬요. 담당이 아니면 위치 기록이 `NOT_NAV_DEVICE`로 막혀요(SFR-132). 토큰·이송 ID·단말 ID는 `perf/.moving.csv`에 써요
   - 로그인 API는 비밀번호 확인이 일부러 느려서, 로그인 대신 서버와 **같은 `JWT_SECRET`** 으로 토큰을 바로 만들어요. 그래서 서버와 같은 `server/.env`로 실행해야 해요
   - **토큰은 15분이면 끝나요.** 만든 뒤 15분 안에 돌리고, `TOKEN_EXPIRED`가 보이면 다시 만들어요
4. 요청 받는 병원 만들기 (`transports.yml`용, 개발 DB에서만)
   ```bash
   npm run perf:dispatch -w server -- 10
   ```
   - 대원 출발 위치(천안) 반경 1~6km에 `PERF-D001…` 병원을 만들고, 병원마다 PC 1대와 진행 중 근무를 둬요
   - 서버는 '알림을 켠 근무가 있는 PC'가 있는 병원에만 요청을 보내요. 그래서 근무까지 만들어 둬요. 알림은 병원 봇이 붙을 때 켜요
   - 쿠키와 근무 id는 `perf/.dispatch-pcs.csv`에 써요 (git에 안 올려요)
   - `transports.yml`용 대원은 진행 중 이송 없이 만들어요: `npm run perf:medics -w server -- 300 0`
5. 서버 켜기. `ALLOWED_ORIGINS`에 `PERF_ORIGIN`과 같은 주소가 있어야 해요

### 가상 사용자마다 다른 대원·PC 쓰기
Artillery는 가상 사용자를 작업자 여러 개(CPU 수 − 1)에 나눠 돌려요. `config.payload`의 `order: sequence`는 **작업자마다 첫 줄부터 다시 읽어서**, 7개 작업자면 대원 300명이 실제로는 약 60명만 쓰여요(같은 대원이 5번). 그래서 연결·위치·이송 시나리오는 `config.payload` 대신 `processor.mjs`의 `pickPc`·`pickMedic`·`pickMoving`이 한 줄씩 나눠 줘요. 줄마다 '찜' 폴더(`results/claims/`)를 만드는데, 폴더 만들기는 동시에 해도 한 곳만 성공해서 한 줄은 한 명만 써요. 준비한 줄보다 가상 사용자가 많으면 `payload.exhausted.*`가 세지고 그 사용자는 실패해요. (`hospital-api.yml`은 같은 PC를 반복해서 써도 되는 REST 호출이라 그대로 둬요)

## 실행
```bash
PERF_TARGET=http://localhost:4000 PERF_ORIGIN=http://localhost:3000 npx artillery@2.0.34 run perf/hospital-connections.yml --output perf/results/connections.json
```
```bash
PERF_TARGET=http://localhost:4000 PERF_ORIGIN=http://localhost:3000 npx artillery@2.0.34 run perf/hospital-api.yml --output perf/results/api.json
```
```bash
PERF_TARGET=http://localhost:4000 npx artillery@2.0.34 run perf/app-connections.yml --output perf/results/app-connections.json
```
```bash
PERF_TARGET=http://localhost:4000 npx artillery@2.0.34 run perf/locations.yml --output perf/results/locations.json
```
- `transports.yml`은 병원 봇을 **먼저** 켜고(다른 터미널), 몇 초 뒤 시나리오를 돌려요. 봇은 정한 시간(초)이 지나면 결과를 출력하고 `perf/results/hospital-bot.json`에 써요
  ```bash
  PERF_TARGET=http://localhost:4000 PERF_ORIGIN=http://localhost:3000 node perf/hospital-bot.mjs 170
  ```
  ```bash
  PERF_TARGET=http://localhost:4000 npx artillery@2.0.34 run perf/transports.yml --output perf/results/transports.json
  ```
- 단계(phases)를 바꿔 보려면 파일을 고치지 않고 `--overrides`를 써요. 예: PC 1,000대가 초당 50대씩 붙기
  ```bash
  npx artillery@2.0.34 run perf/hospital-connections.yml --overrides '{"config":{"phases":[{"duration":20,"arrivalRate":50}]}}'
  ```
  `npm run perf:pcs`로 만든 PC 수가 가상 사용자 수보다 적으면 쿠키를 처음부터 다시 써요(같은 PC가 두 번 붙어요)
- 결과 JSON을 보기 좋게 보려면 `npx artillery@2.0.34 report perf/results/connections.json`

## 시나리오가 하는 일
### `hospital-connections.yml` (PER-005)
- 가상 사용자 1명 = 병원 PC 1대. 사용자마다 다른 쿠키로 `/hospital` 실시간 연결을 맺고 `holdSeconds`(기본 60초) 동안 유지해요
- Artillery 내장 Socket.IO 엔진은 사용자마다 다른 쿠키 헤더를 붙이기 어려워요. 그래서 `processor.mjs`에서 프로젝트의 `socket.io-client`로 직접 붙어요
- 보는 값
  - `hospital.connect_ms`: 연결에 걸린 시간
  - `hospital.connected`: 붙은 PC 수
  - `hospital.connect_error.*`: 서버가 거절한 이유별 수
  - `hospital.dropped.*`: 유지하는 동안 끊긴 수

### `hospital-api.yml`
- 병원 PC가 새 요청 알림을 받거나 다시 연결될 때 부르는 `GET /hw/session`, `GET /hw/requests`를 반복해요
- `ensure`: p95가 500ms를 넘거나 200 응답이 하나도 없으면 실패로 끝나요. S1 연습 값이라 느슨하게 뒀고, S8에서 PER-001 기준으로 조여요

### `app-connections.yml` (PER-005 대원 앱 쪽)
- 가상 사용자 1명 = 대원 앱 1대. `.medics.csv`의 토큰으로 `/app` 실시간 연결을 맺고 `holdSeconds`(기본 60초) 동안 유지해요
- 보는 값: `app.connect_ms`, `app.connected`, `app.connect_error.*`, `app.dropped.*` (병원 PC 쪽과 같은 뜻)

### `locations.yml` (PER-008)
- 가상 사용자 1명 = 이동 중 이송 건의 경로 안내 담당 단말 1대. 5초마다 `POST /transports/{id}/locations`로 '지금' 위치 1점을 24번(2분) 보내요
- 300건이 5초에 걸쳐 출발하니 계속 초당 약 60건이 들어와요
- 서버는 같은 시각의 점을 한 번만 저장하므로 `processor.mjs`의 `locationBody`가 요청마다 지금 시각을 넣어요
- `expect`: 204가 아니면 실패로 세요. `ensure`: p95가 1,000ms를 넘으면 실패로 끝나요
- 결과에서 `vusers.failed`와 `errors.*`가 없는지도 꼭 봐요 (`ensure`는 응답 시간만 봐요)
- `ensure`는 `config.plugins`에 `ensure: {}`를 켜야 판정해요. 빠지면 기준을 넘어도 exit 0이에요

### `hospital-bot.mjs` + `transports.yml` (PER-006, PER-007)
- **병원 봇**: `.dispatch-pcs.csv`의 PC마다 `/hospital`에 붙어 알림을 켜요(`alarm.resume`). `request.new`를 받으면 바로 '받았음'(ack)을 보내고, 1~3초 뒤(사람이 보고 누르는 시간) 요청 상세를 읽고 승인해요
  - `notifyMs`: 요청 → 병원 알림 시간 (PER-006 앞쪽 절반). 회차의 응답 마감은 DB가 '보낸 시각 + 2분'으로 정하니, 받은 시각 − (마감 − 2분)으로 재요. 이송 만들기 트랜잭션 → 커밋 → 전송이 모두 들어가요
  - `approve`: 승인 응답별 수. 대원이 다른 병원을 먼저 확정하면 나머지는 `REQUEST_CLOSED`(409)가 정상이에요
  - **모든 요청을 승인**해요. 실제보다 무거운 최악의 경우예요
- **대원 300명**(`runTransport`): 30초에 걸쳐 각자 `/app` 연결 → 이송 만들기(반경 10km, 병원 10곳에 동시 요청) → 첫 승인 알림 → 확정 → 이동 중 60초 → 도착
  - 30초 동안 300건이 들어오고 각자 60초 머무니 한동안 300건이 동시에 진행 중이에요 (PER-007)
  - `transport.approved_notify_ms`: 병원이 승인한 DB 시각(`occurredAt`) → 대원 앱이 받은 시각 (PER-006 뒤쪽 절반)
  - `transport.create_ms`·`confirm_ms`·`arrive_ms`: API 응답 시간. `transport.moving`·`transport.done`: 이동 중·도착까지 간 수. `transport.fail.<단계>.<코드>`: 멈춘 곳
  - `ensure`: 승인 알림·이송 만들기 p95가 3초를 넘으면 실패
- 시계: 같은 컴퓨터면 같은 시계예요. S8에서는 부하 서버와 앱 서버가 NTP로 맞춘 시계를 써요(오차 수 ms)

## S7 연습 결과 (내 컴퓨터, 서버 1대, Docker의 DB)
| 시나리오 | 부하 | 결과 |
|---|---|---|
| `app-connections.yml` (PER-005) | 대원 앱 200대 (20초에 걸쳐 붙고 60초 유지) | 200대 모두 연결, 실패·끊김 0. 연결 시간 중앙값 8.9ms, p95 13.9ms |
| `locations.yml` (PER-008) | 이동 중 300건 × 5초 간격, 2분 (초당 약 60건) | 7,200건 모두 204, 응답 p95 37ms, p99 61ms (목표 1,000ms) |
| `hospital-bot.mjs` (PER-006 앞) | 병원 10곳 × 이송 300건 = 알림 3,000건 | 4번 모두 3,000건 전달·3초 넘은 것 0. p95 88ms ~ 2,200ms |
| `transports.yml` (PER-006 뒤, PER-007) | 대원 300명, 동시 진행 최대 약 300건 | 4번 모두 300건 도착까지 성공. 승인 알림 p95 60~162ms. **이송 만들기 p95는 1번 123ms, 3번 10.6~17.5초** |

- 처음 연습은 위 '가상 사용자마다 다른 대원·PC' 문제로 같은 대원이 여러 번 쓰여 숫자가 틀렸어요. 고친 뒤 다시 잰 값이에요

### 이송 만들기가 느린 이유 (백강욱 님 확인 부탁, D-109 튜닝)
같은 코드로 4번 돌렸는데 이송 만들기 p95가 123ms(1번)와 10~17초(3번)로 갈렸어요. 확정도 같이 느려졌어요(p95 4~8초).
- **느린 실행에서는 병원 승인이 많이 성공했어요**(약 2,600~2,850건). 빠른 실행에서는 대원이 금방 확정해서 나머지 요청이 닫혀 승인 성공이 383건뿐이었어요
- 이벤트를 쓰는 트랜잭션은 모두 `appendEvents`에서 **전역 잠금 하나**(`pg_advisory_xact_lock`, `server/src/modules/realtime/eventLog.ts`)를 잡고 **커밋(디스크 기록 확인)까지** 쥐고 있어요. 그래서 이송 만들기·승인·확정이 서버 전체에서 한 줄로 서요
- 승인이 한 줄 서기가 감당할 수 있는 양을 넘으면 이송 만들기·확정도 줄 뒤에서 기다려요 → 느려진 사이 요청이 열려 있는 시간이 길어져 승인이 더 몰려요 → 더 느려져요 (눈덩이)
- 빠른 실행 동안 DB 연결 상태를 1초마다 봤을 때 기다리는 이유가 `Lock/advisory`(위 잠금)와 `IO/WALSync`·`LWLock/WALWrite`(커밋 디스크 기록)였어요
- 서버의 DB 연결은 pg 기본값 10개예요(`new pg.Pool`에 `max` 없음). 줄 서기가 길어지면 연결 10개가 모두 잠금을 기다리며 묶여요
- 내 컴퓨터는 Docker(WSL) 디스크라 커밋 기록이 클라우드보다 느릴 수 있어요. S8에서 같은 시나리오로 다시 보고, 그래도 느리면 잠금 범위(이벤트 번호만 잠그고 커밋 전에 풀기 등)나 연결 수를 조정해야 해요
- PER-006 목표 자체(알림 3초)는 4번 모두 통과했지만, 대원이 '요청 보내기'를 누르고 응답을 받기까지가 10초를 넘으면 현장에서는 실패로 느껴져요

## S8 클라우드 실측 때 할 일
S7 연습 결과 요약: `docs/perf/S7-연습.md`. S8 결과도 같은 형식으로 `docs/perf/S8-실측.md`에 써요.

### 한 번에 돌리기 (`perf/run-s8.sh`)
토큰이 15분이면 끝나서 '준비 → 바로 실행'을 스크립트가 이어서 해요.
```bash
PERF_TARGET=https://시험서버주소 PREP_SSH=ubuntu@시험서버 perf/run-s8.sh all
```
| 단계 | 하는 일 | 재는 것 |
|---|---|---|
| `connections` | 병원 PC 1,230 + 대원 앱 3,300 연결을 함께 띄워 `HOLD`초(기본 300) 유지. 붙은 뒤 병원 봇 + 이송 300건 | PER-005 (끊김 0), 그 부하 속 PER-006·007 |
| `locations` | 이동 중 300건이 5초마다 위치 기록 2분 | PER-008 |
- 숫자는 환경 변수로 바꿔요: `PCS`·`MEDICS`·`HOSPITALS`·`TRANSPORTS`·`RAMP`·`HOLD`·`BOT_SECONDS`
- 준비 스크립트는 DB와 서버의 `JWT_SECRET`이 있는 곳에서 돌아야 해요
  - `PREP_SSH`가 비어 있으면 이 컴퓨터의 저장소에서 바로 돌려요 (내 컴퓨터 연습)
  - `PREP_SSH=사용자@서버`면 그 서버의 `PREP_DIR`(기본 `~/Savetime`) 저장소에서 돌리고 CSV를 `scp`로 가져와요. 그 서버에는 Node 24와 `npm ci`, 시험용 DB를 가리키는 `server/.env`가 있어야 해요
- 대원 준비 직후 첫 토큰으로 `GET /me`를 불러 봐요. 200이 아니면 바로 멈춰요(준비한 곳의 `JWT_SECRET`·DB가 시험 서버와 다르면 모든 요청이 401이 돼서). 내 컴퓨터 연습 때 4000 포트를 다른 개발 서버가 쓰고 있어서 실제로 이렇게 됐어요
- 결과는 `perf/results/s8-날짜시각/`에 모여요. 각 `.log` 끝의 `Checks`, `vusers.failed`, `errors.*`, `payload.exhausted.*`를 봐요
- 같은 대원 파일을 연결·이송이 함께 써요(앞쪽 300명은 연결만 한 앱과 이송하는 앱이 둘 다 붙어요). 대원 한 명이 기기 두 대를 쓰는 것과 같아 괜찮아요

### 준비 체크리스트
- [ ] **시험 환경 정하기 (백강욱 님과)**: 준비 스크립트는 `NODE_ENV=production`이면 거부해요. 운영 DB에 부하용 병원(`PERF-D…`, 천안 근처·알림 켬)이 생기면 실제 대원의 요청이 그 병원으로 갈 수 있어요. 시험용 DB를 쓰는 서버(예: 같은 구성의 시험용 인스턴스, 또는 출시 전 앱 서버를 `NODE_ENV=development`·시험 DB로)에 부하를 줘요
- [ ] 부하 서버는 **앱 서버와 다른 클라우드 서버**(기술정의서 '부하 발생 위치'). Node 24 설치, 저장소 받고 `npm ci`
- [ ] 열린 파일 수 한도: `ulimit -n 65535` (연결 5,000개 = 열린 파일 5,000개 이상. 스크립트가 낮으면 알려 줘요)
- [ ] 시계: 알림 시간은 앱 서버 시각과 부하 서버 시각의 차이로 재요. 두 서버 모두 `timedatectl`에서 `NTPSynchronized=yes`인지 확인
- [ ] 시험 서버의 `ALLOWED_ORIGINS`에 `PERF_ORIGIN`(기본 `PERF_TARGET`과 같음)이 있어야 병원 PC 쪽 요청이 통과해요
- [ ] 운영 서버는 1대(로드밸런서 없음, 2026-11-09 결정)라 `PERF_TARGET`은 앱 서버 주소예요
- [ ] 실행 중 앱 서버의 CPU·메모리(`docker stats`)와 DB 연결 대기(`pg_stat_activity`의 `wait_event`)를 같이 기록해요 → 이송 만들기 지연 분석용 (`docs/perf/S7-연습.md`)
- [ ] 결과 분석·튜닝·서버 장애 테스트는 백강욱 담당이에요(D-109). 작성·실행 담당은 윤승언이에요
