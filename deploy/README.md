# 배포 (S7, 기술정의서 7장)

2026-11-09 결정: **앱 서버 1대 + 관리자 서버 1대 + 데이터 서버 1대** (Lightsail 서울). 로드밸런서는 쓰지 않는다.

```
 구급대원 웹앱(Lovable) ─┐
 병원 PC 브라우저 ───────┼─▶ [앱 서버]  Caddy(HTTPS) ─┬─ /api·/socket.io·/health → server (APP_ROLE=main)
                         │                              └─ 나머지                    → web    (APP_ROLE=hospital)
 관리자 (허용 IP만) ─────┴─▶ [관리자 서버] Caddy(HTTPS·IP 제한) ─┬─ /api → server (APP_ROLE=admin, 보내기 전용 실시간)
                                                                 └─ 나머지 → web (APP_ROLE=admin)
            두 서버 ──(사설 IP)──▶ [데이터 서버] PostgreSQL 16 · Redis 7
```

| 폴더 | 서버 | 들어 있는 것 |
|---|---|---|
| `deploy/data/` | 데이터 서버 | PostgreSQL·Redis. 사설 IP 에만 포트를 연다 |
| `deploy/app/` | 앱 서버 | Caddy + 서버(main) + 병원 웹. 주기 작업·타이머·실시간 연결은 여기서만 |
| `deploy/admin/` | 관리자 서버 | Caddy(허용 IP) + 서버(admin) + 관리자 웹 |

## 관리자 서버가 하는 일과 안 하는 일 (T-11)
- 관리자 API(`/api/v1/admin/*`)는 **관리자 서버에서만** 켜진다. 앱 서버에서는 404 (개발 모드 `NODE_ENV=development` 에서만 앱 서버에도 켬).
- 접속 IP 를 **두 번** 막는다: Caddy(`CADDY_ALLOWED_IPS`) + 서버(`ADMIN_ALLOWED_IPS`, 403 `IP_NOT_ALLOWED`). 운영 관리자 서버는 `ADMIN_ALLOWED_IPS` 가 비어 있으면 아예 켜지지 않는다.
- 실시간은 **보내기 전용**: 앱·병원 웹 연결을 받지 않고, 대원 정지·PC 해제·가입 결과를 Redis 를 거쳐 앱 서버에 붙은 연결로 보낸다. 2분 타이머 같은 작업은 돌리지 않는다.
- 그래서 두 서버의 `JWT_SECRET`·`REDIS_URL` 은 같아야 한다.

## 채울 값 체크리스트 (실제 값은 서버의 파일에만, 여기·채팅에 적지 않는다)
| 서버 | 파일 | 채울 것 | 메모 |
|---|---|---|---|
| 데이터 | `deploy/data/.env` | `PRIVATE_IP` | 데이터 서버 **사설** IP |
| | | `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 16` |
| 앱 | `deploy/app/.env` | `APP_DOMAIN` | 예: `savetime.example.kr` (DNS 가 이 서버 고정 IP 를 가리킨 뒤 켜야 인증서가 나온다) |
| | `deploy/app/server.env` | `DATABASE_URL`, `REDIS_URL` | 위 비밀번호 + 데이터 서버 사설 IP |
| | | `JWT_SECRET` | `openssl rand -base64 32`. **관리자 서버와 같은 값** |
| | | `ALLOWED_ORIGINS` | `https://앱 도메인,https://admin.앱 도메인` |
| | | `APP_ORIGINS` | Lovable 구급대원 웹앱 주소 (CR-010) |
| | | `PUBLIC_DATA_API_KEY`, `KAKAO_REST_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_BASE64` | 운영 키 |
| | | `S3_*`, `PHOTO_ENC_KEY` | 가입 사진 저장. 비우면 가입 신청이 503 |
| | | `AI_API_KEY`, `AI_MODEL` | AI 일지 정리. 시연 전 관리자 화면에서 `journal_ai` 켜기 |
| | | `ADMIN_ALLOWED_IPS` | **비워 둔다** (앱 서버) |
| 관리자 | `deploy/admin/.env` | `ADMIN_DOMAIN` | `admin.앱 도메인` |
| | | `CADDY_ALLOWED_IPS` | 관리자 접속 IP. 띄어쓰기로 여러 개, CIDR(`1.2.3.0/24`)도 됨 |
| | `deploy/admin/server.env` | 앱 서버 `server.env` 를 복사한 뒤 `ADMIN_ALLOWED_IPS` | 쉼표로 여러 개. **서버 쪽은 CIDR 을 모르고 정확한 IP 만** 받는다 |

- `server.env` 에서 **빈 값 뒤에 설명(`키=   # 설명`)을 붙이지 않는다.** docker compose 는 그 설명 글을 값으로 읽는다(배포 리허설에서 발견). 서버는 `#`로 시작하는 값이 있으면 이름을 알려 주고 켜지지 않는다
- 서버 로그의 `…가 없어 …` 경고(level 40)는 비워 둔 키 목록이다. 켜자마자 `docker compose logs server` 로 확인한다

## 처음 한 번 (강욱)
1. Lightsail 서울 리전에 인스턴스 3개 (Ubuntu, Docker·Docker Compose 설치). 고정 IP 를 앱·관리자 서버에 붙인다.
2. 도메인 DNS: `앱 도메인` → 앱 서버 고정 IP, `admin.앱 도메인` → 관리자 서버 고정 IP.
3. Lightsail 방화벽
   - 앱·관리자 서버: 80·443 열기, 22(SSH)는 내 IP 만
   - 데이터 서버: 5432·6379 는 **앱·관리자 서버 사설 IP 만**, 인터넷에는 열지 않는다
4. 세 서버에 저장소를 받는다: `git clone` 후 `main` 브랜치.
5. 데이터 서버
   ```bash
   cd deploy/data && cp .env.example .env   # PRIVATE_IP·비밀번호 채우기
   docker compose up -d
   ```
6. 앱 서버
   ```bash
   cd deploy/app && cp .env.example .env && cp ../server.env.example server.env   # 값 채우기 (ADMIN_ALLOWED_IPS 는 비워 둠)
   docker compose build
   docker compose run --rm server npm run migrate   # DB 구조 만들기 (처음·마이그레이션이 늘 때마다)
   docker compose up -d
   ```
7. 관리자 서버
   ```bash
   cd deploy/admin && cp .env.example .env && cp ../server.env.example server.env   # ADMIN_ALLOWED_IPS·CADDY_ALLOWED_IPS 같은 주소로
   docker compose build && docker compose up -d
   ```
8. 확인: `https://앱 도메인/health`, `https://admin.앱 도메인/health` 가 200. 허용하지 않은 곳(휴대폰 데이터)에서 `https://admin.앱 도메인` 은 403.

## 새 버전 올리기
```bash
git pull
docker compose build
docker compose run --rm server npm run migrate   # 앱 서버에서만. 새 마이그레이션이 있을 때
docker compose up -d
```
서버는 종료 신호를 받으면 처리 중인 요청을 끝내고(최대 30초) 내려간다. 서버가 1대라 다시 켜지는 몇 초 동안은 연결이 끊기고, 앱·병원 웹은 다시 붙어 놓친 이벤트를 받는다 (INR-003).

## 비밀 값
`server.env`·`.env` 는 커밋하지 않는다 (`.gitignore` 에 있음). 이미지에도 들어가지 않는다 (`.dockerignore`).
