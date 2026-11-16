# 시연 영상 찍기 (노트북에서, 배포 없이)

2026-11-11 결정: 기말 발표는 **시연 영상**으로 한다. 서버를 Lightsail 에 올리지 않고 노트북에서 DB·서버·병원 웹을 띄우고, 구급대원 앱(진아, Lovable)이 노트북 서버에 붙는다.

## 준비물
| 화면 | 어디서 | 누가 |
|---|---|---|
| 병원 웹 (승인·도착 예정) | 노트북 브라우저 `http://localhost:3000/hospital` | 강욱 |
| 구급대원 앱 2대 (김구조=운전, 이구급=처치) | 휴대폰 2대 또는 휴대폰 1대 + 브라우저 | 진아·승언 |
| 서버·DB | 노트북 | 강욱 |

## 1. 처음 한 번
```bash
docker compose up -d
```
```bash
docker exec -it $(docker compose ps -q db) psql -U savetime -d savetime -c "CREATE DATABASE savetime_demo"
```
```bash
DATABASE_URL=postgres://savetime:savetime_local@localhost:5432/savetime_demo npm run migrate -w server
```
```bash
DATABASE_URL=postgres://savetime:savetime_local@localhost:5432/savetime_demo npm run demo -w server -- setup
```
- 시연 병원 5곳(천안, 이름에 '(시연)'), 병원 라이선스 키 5개, 대원 계정 2개(`demo-kim`, `demo-lee`)를 만든다
- **키·비밀번호는 이 화면에 한 번만 나온다.** 비밀번호를 정해 두고 싶으면 앞에 `DEMO_PASSWORD=원하는값`(영문+숫자 8자 이상)을 붙인다
- 시연 스크립트는 **이름이 `_demo` 로 끝나는 DB 에서만** 돈다. 개발 DB 를 실수로 지우지 않게 하기 위해서다
- `DATABASE_URL=…` 을 앞에 붙이면 `server/.env` 의 값보다 우선한다. 나머지 설정(키 등)은 `server/.env` 그대로 쓴다

## 2. 켜기 (찍을 때마다)
터미널 3개 (서버 · 병원 웹 · 구급대원 앱). 구급대원 앱은 진아 저장소(`savetime-life-canvas`)를 받아 둔 폴더에서 켠다:
```bash
DATABASE_URL=postgres://savetime:savetime_local@localhost:5432/savetime_demo APP_ORIGINS=http://localhost:8080 npm run dev -w server
```
```bash
NEXT_PUBLIC_SOCKET_ORIGIN=http://localhost:4000 npm run dev -w web
```
```bash
VITE_API_BASE_URL=http://localhost:4000 VITE_FIXED_LAT=36.815 VITE_FIXED_LNG=127.1139 npx vite dev --port 8080
```
- 병원 웹: `http://localhost:3000/hospital` → (처음 한 번) 라이선스 키로 **PC 등록** → **근무 시작** → **알림 켜기**
- `NEXT_PUBLIC_SOCKET_ORIGIN` 이 없으면 병원 웹 실시간 연결이 안 붙어 **알림 켜기**가 눌리지 않는다
- 서버를 껐다 켜면 병원 웹에서 **알림 켜기**를 다시 눌러야 요청이 온다
- 구급대원 앱: `http://localhost:8080` (브라우저 개발자 도구에서 휴대폰 크기로 보면 영상에 좋다). `VITE_FIXED_*` 로 어디서 찍어도 천안 시연 병원 근처로 보이고, 이동 중에는 병원 입구까지 달리는 것을 흉내 낸다
- 병원 PC 를 여러 곳 켜 두려면 병원마다 **다른 브라우저(또는 시크릿 창)** 에서 등록한다. 같은 브라우저는 PC 1대로 본다. 알림 켠 병원이 1곳뿐이면 그 병원이 거절한 뒤 '다시 요청'·'목적지 변경'은 "요청할 병원이 없어요"가 된다
- 김구조·이구급 두 명을 동시에 보려면 브라우저 2개(또는 시크릿 창)나 휴대폰 2대. 같은 브라우저 탭 두 개는 로그인을 같이 쓴다

## 3. 찍기 직전: 초기화
```bash
DATABASE_URL=postgres://savetime:savetime_local@localhost:5432/savetime_demo npm run demo -w server -- reset
```
- 이송 건과 그 기록·알림을 모두 지우고, 병상 값을 '방금 수집'으로 되돌린다 (10분이 지나면 앱에 '갱신 지연'이 뜨므로 찍기 직전에)
- 계정·병원 PC 등록·대원 팀은 남는다. 마지막 줄에 **요청을 받을 수 있는 병원 PC 수**가 나온다. 0이면 병원 웹에서 알림 켜기

## 4. 휴대폰으로 찍고 싶을 때
2번처럼 노트북에서 앱을 띄우면 추가 도구가 필요 없다. 휴대폰 실물로 찍으려면:

| 방법 | 하는 일 | 메모 |
|---|---|---|
| 터널 | 노트북 서버(4000)·앱(8080)에 임시 https 주소를 붙인다 (예: Cloudflare Tunnel) | **기술정의서에 없는 도구라 쓰기 전에 팀 확인** |
| 같은 와이파이 | 휴대폰을 노트북과 같은 와이파이에 두고 `http://노트북IP:8080` | https 가 아니라 위치·알림 권한이 막힐 수 있음 |

- 어느 쪽이든 서버를 켤 때 `APP_ORIGINS` 에 그 앱 주소를, 앱을 켤 때 `VITE_API_BASE_URL` 에 그 서버 주소를 넣는다
- Lovable 미리보기 주소(https)에서 노트북 `localhost` 를 부르면 브라우저가 막는다(로컬 네트워크 접근 차단)

## 5. 시연 대본 (약 3분)
| # | 화면 | 하는 일 | 보여 줄 점 (요구사항) |
|---|---|---|---|
| 1 | 앱 2대 | 김구조·이구급 로그인 → 팀 맺기(코드 4자리) | 팀 공동 입력 (SFR-113·114) |
| 2 | 앱 | 환자 평가 입력(흉통, 남·60대) → 주변 응급실 추천 5곳 | 병상·거리 기준 추천 (SFR-001·027) |
| 3 | 앱 | 등급 선택 → 'n곳에 요청합니다' 미리보기 → 요청 | 동시 요청 (SFR-109·163) |
| 4 | 병원 웹 | 새 요청 알림음·창 → 상세 → 승인(메모) | 실시간 알림 3초 안 (PER-006), 구급대 소속은 안 보임 |
| 5 | 앱 | 승인 병원 목록·지도 → 확정 | 2분 응답·5분 승인 유효 (SFR-110·111) |
| 6 | 앱·병원 웹 | 이동 중 남은 시간 → 병원 '도착 예정'에 표시 → 입구 200m 안 '도착 확인' | 내비 남은 시간·도착 판정 (SFR-121·144) |
| 7 | 앱 | 도착 → 구급활동일지 초안 (AI 정리 켜져 있으면 한 번) | 일지 초안 (SFR-164·167) |
| (선택) | 앱·병원 웹 | 병원 거절(사유) / 2분 무응답 → 전화 확인 흐름 | 예비 흐름 (SFR-112·032) |

- AI 일지 정리를 보여 주려면 `server/.env` 에 `AI_API_KEY`·`AI_MODEL` 을 넣고, 관리자 화면(`http://localhost:3000/admin`, 계정은 `DATABASE_URL=…savetime_demo npm run admin:dev -w server`, 첫 로그인 때 OTP 연결)에서 `journal_ai` 를 켠다
- 길찾기 남은 시간(카카오)·병상 수집(공공데이터)은 키가 없어도 시연 값으로 돈다

## 끝나고
- 시연 DB 는 지워도 된다: `docker exec -it $(docker compose ps -q db) psql -U savetime -d savetime -c "DROP DATABASE savetime_demo"`
