# 부하 테스트 (Artillery)

PER-005·006·007·008을 확인하는 시나리오예요. 기술정의서에 따라 **실측은 S8에 클라우드 서버에서** 해요(노트북 한 대로는 동시 연결 5,000개를 만들기 어려워요). S1에는 내 컴퓨터에서 작은 숫자로 연습했어요. 결과 요약은 `docs/perf/`에 남겨요.

| 요구사항 | 목표 (S8) | 시나리오 | 상태 |
|---|---|---|---|
| PER-005 동시 연결 | 5,000개 (병원 PC 약 1,230 + 대원 앱 약 3,300 + 여유) | `hospital-connections.yml` (병원 PC 쪽), `app-connections.yml` (대원 앱 쪽) | 둘 다 연습 완료 |
| PER-006 요청 → 알림 | 각 3초 이내 | (S8 전에 작성) | 이송 요청 → 병원 알림 시나리오가 필요 |
| PER-007 동시 이송 | 300건 | (S8 전에 작성) | 위와 같음 |
| PER-008 위치 기록 | 초당 60건, 95%를 1초 안에 저장 | `locations.yml` | 연습 완료 |
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
4. 서버 켜기. `ALLOWED_ORIGINS`에 `PERF_ORIGIN`과 같은 주소가 있어야 해요

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

## S7 연습 결과 (내 컴퓨터, 서버 1대)
| 시나리오 | 부하 | 결과 |
|---|---|---|
| `app-connections.yml` | 대원 앱 200대 (20초에 걸쳐 붙고 60초 유지) | 200대 모두 연결, 실패·끊김 0. 연결 시간 중앙값 13.9ms, p95 22ms |
| `locations.yml` | 이동 중 300건 × 5초 간격 (초당 약 53~60건) | 약 75초 동안 4,478건 모두 204, 응답 p95 18ms, p99 23.8ms (목표 1,000ms) |

- `locations.yml`은 75초쯤에 **내 컴퓨터의 Docker Desktop이 멈춰서**(DB 연결 끊김) 남은 요청이 `ERR_SOCKET_TIMEOUT`이 됐어요. 서버 문제가 아니라 연습 환경 문제라, 목표 부하(300건 동시)에 도달한 뒤의 구간만 결과로 적었어요. S8 클라우드에서 2분 전체를 다시 재요

## S8 클라우드 실측 때 할 일
- 부하는 **서버와 다른 클라우드 서버**에서 만들어요(기술정의서 "부하 발생 위치")
- 연결 5,000개를 만들려면 부하 서버의 열린 파일 수 한도(`ulimit -n`)를 늘려요
- 서버 2대 + 로드밸런서 구성에서 `PERF_TARGET`은 로드밸런서 주소예요
- 결과 분석·튜닝·서버 1대 장애 테스트는 백강욱 담당이에요(D-109). 작성·실행 담당은 윤승언이에요
