# 세이브타임 API 명세 v0.2

요구사항분석서 v0.115 · 상태 전이표 v0.2 · DB 스키마 v0.2 · 실시간 통신 설계 v0.2 기준 · 상세 스키마는 `openapi.yaml` / `API명세_문서.html`

## v0.1 → v0.2 바뀐 점

| 바뀐 점 | 근거 |
|---|---|
| 목적지 변경: 새 병원을 고르지 않고 `{reason, version}`만 → 이송 건이 요청 중으로 돌아가 현재 위치 기준 새 요청 | 부록 A21, SFR-077 |
| 전화 확인 상태 복원: `phone-check/start` 추가, 결과에 `dismissed`(결과 미선택) 추가, 거절 시 다음 후보 자동 | 부록 A13~18, SFR-075 |
| `rounds`를 `kind: expand | re_request`로 나눔. 이동 중 다시 요청은 확정 병원이 승인 취소했을 때만 | 부록 A12·A20, SFR-131·128 |
| `POST /transports` 대상 0곳 → 오류 대신 201 + fallback. `finishPrevious`로 '이전 이송 끝내기' | SFR-109·104 |
| `/fallback`·`/phone-checks`·`/arrive`·병원 응답 전부 version 필수, 오류 코드를 상태 전이표와 통일 + `error.details` | SFR-160 |
| 팀 작성 중 정보: 버전이 달라도 409 대신 항목 단위 병합, 덮어쓴 항목 알려줌 | SFR-114 |
| 새 API 8개: 반려 후 재신청, 주소→좌표, 예비 추천 반경 넓히기, 전화 확인 시작, 경로 안내 담당 단말, 관리자 OTP 첫 연결, 키 폐기(사유), 초대 수락 역할 | SFR-083·009·029·132·152·146·159 |
| 근무 종료·로그아웃·탈퇴·정지: 진행 중 이송이 있으면 확인 → 마지막 1명이면 취소 (탈퇴는 막지 않음) | SFR-113·070·071·151 |
| 병원 '도착 확인': 위치 있는 건은 바로 도착, 위치 없는 건은 대원 앱에 확인 요청 | SFR-144 |
| 보안: 내 것이 아니면 404, 요청마다 계정 상태 확인, 병원 쿠키 SameSite=Strict + Origin 검사, 사진 `no-store`, 닫힌 요청은 목록에서도 환자 정보 null | SER-010·013·014·016 |
| 화면 필드: 지도 좌표·진료가능 항목 수·추가 메모·serverNow, 사유는 정해진 목록(enum), 목록 API는 limit·cursor | SFR-002·027·149·140·110 |
| 과승인 확인 428 → 409, 탈퇴 SFR-071·로그아웃 SFR-070 번호 바로잡음 | - |

## 공통 규칙

- 기본 주소: `/api/v1` · 형식: JSON (가입 신청·재신청만 multipart)
- 시간: ISO 8601, 모두 **서버 시각**. 모든 응답 헤더에 `X-Server-Now`, 시간이 중요한 응답 본문에는 `serverNow`. 2분·5분은 서버 수신 시각으로 판정
- 인증: 대원·관리자 = `Authorization: Bearer <accessToken>`(15분) + refreshToken(30일, 폐기 가능) / 병원 웹 = 등록 PC 쿠키 `st_pc`(httpOnly · Secure · SameSite=Strict)
- **계정 상태는 요청마다 확인** (정지·탈퇴·PC 해제 후 10초 안 모든 요청 거부, SER-016). 토큰이 살아 있어도 401·403
- 병원·관리자 웹: 상태를 바꾸는 요청은 `Origin` 헤더가 허용 목록일 때만 (CSRF 방어)
- **내 것이 아니면 404**: 다른 팀 이송 건, 다른 병원 요청, 남의 초대·메모 (SER-010·013)
- 상태 변경: 상태 전이표 v0.2의 전이 함수를 거친다. 사용자 요청에는 `version` 필수(SFR-160). 검사 순서 = 표 → 상태 → 시간·사유 → 버전. 실패하면 409와 `error.details.current`(최신 상태)
- 확정은 `Idempotency-Key` 헤더, 이송 건 생성은 앱 UUID, 오프라인 기록은 `clientRecordId`로 중복 방지
- 목록은 `limit`·`cursor`로 나눠 받음 (`nextCursor`)
- 오류 형식: `{"error": {"code": "...", "message": "...", "details": {...}}}`
- 각 API의 `x-state-events`는 거치는 상태 전이 사건 이름 (stateMachine.ts)
- 실시간 알림(웹소켓 이벤트)은 실시간 통신 설계 v0.2·events.ts에서 정의. 이벤트에는 환자 정보가 없으니 받으면 이 API로 상세를 가져온다

## API 목록 (83개)

### 1. 대원 인증·계정

| 메서드 | 주소 | 하는 일 | 인증 | 상태 전이 | 화면 | 요구사항 |
|---|---|---|---|---|---|---|
| GET | `/agencies/{code}` | 소속기관 코드 확인 | 없음 | - | S-02 가입 신청 | SFR-017 |
| POST | `/auth/signup` | 가입 신청 (공무원증 사진) | 없음 | - | S-02 가입 신청 | SFR-017, SER-015, DAR-012 |
| PUT | `/me/signup` | 반려 후 다시 신청 | 대원 | - | S-02 승인 대기 | SFR-083, SFR-017 |
| POST | `/auth/login` | 로그인 | 없음 | - | S-02 로그인 | SFR-018, SER-011 |
| POST | `/auth/refresh` | 토큰 재발급 | 없음 | - | (모든 화면) | SER-016 |
| POST | `/auth/logout` | 로그아웃 (팀에서 빠짐) | 대원 | CANCEL | S-12 설정 | SFR-070, SFR-113 |
| GET | `/me` | 내 정보 | 대원 | - | S-02 승인 대기 · 앱 시작 | SFR-022, SFR-083 |
| PUT | `/me/password` | 비밀번호 변경 (임시 비밀번호 후 필수) | 대원 | - | (비밀번호 변경) | SFR-021 |
| PUT | `/me/pin` | 앱 잠금 PIN 설정·변경 | 대원 | - | S-12 설정 | SFR-150 |
| POST | `/me/pin/verify` | PIN 확인 (5회 실패 시 로그아웃) | 대원 | CANCEL | S-02 앱 잠금 | SFR-150 |
| PUT | `/me/push-device` | 푸시 토큰 등록 | 대원 | - | 앱 시작 | SFR-130, COR-009 |
| DELETE | `/me` | 회원 탈퇴 | 대원 | CANCEL | S-12 설정 | SFR-071, SFR-113 |

### 2. 팀

| 메서드 | 주소 | 하는 일 | 인증 | 상태 전이 | 화면 | 요구사항 |
|---|---|---|---|---|---|---|
| POST | `/teams` | 팀 만들기 (근무 시작) | 대원 | - | S-03 근무 시작 | SFR-113 |
| POST | `/teams/join` | 코드·QR로 참여 | 대원 | - | S-03 근무 시작 | SFR-113 |
| GET | `/teams/current` | 내 팀 보기 | 대원 | - | S-03 근무 시작 | SFR-113 |
| PATCH | `/teams/current/members/me` | 내 역할 바꾸기 | 대원 | - | S-03 근무 시작 | SFR-113 |
| POST | `/teams/current/leave` | 근무 종료 (나만 팀에서 빠짐) | 대원 | CANCEL | S-03 · S-12 | SFR-113 |
| GET | `/paramedics/on-duty` | 같은 소방서 근무 중 대원 목록·이름 검색 | 대원 | - | S-03 팀원 목록 초대 | SFR-159, SFR-143 |
| POST | `/teams/current/invites` | 팀 초대 보내기 (5분 만료) | 대원 | - | S-03 팀원 목록 초대 | SFR-159 |
| POST | `/invites/{inviteId}/accept` | 초대 수락 (역할 선택) | 대원 | - | (초대 알림) | SFR-159, SFR-113 |
| POST | `/invites/{inviteId}/decline` | 초대 거절 | 대원 | - | (초대 알림) | SFR-159 |
| PUT | `/memos/{paramedicId}` | 나만 보는 한 줄 메모 | 대원 | - | S-03 팀원 목록 초대 | SFR-143 |
| GET | `/teams/current/draft` | 팀 작성 중 환자 정보 불러오기 | 대원 | - | S-04 환자 정보 입력 | SFR-114, SFR-157 |
| PATCH | `/teams/current/draft` | 팀 작성 중 환자 정보 고치기 (항목 단위 병합) | 대원 | - | S-04 환자 정보 입력 | SFR-114, SFR-115 |
| DELETE | `/teams/current/draft` | 직전 환자 정보 지우기 | 대원 | - | S-04 직전 환자 정보 | SFR-157 |

### 3. 병원 정보·위치 (대원 앱)

| 메서드 | 주소 | 하는 일 | 인증 | 상태 전이 | 화면 | 요구사항 |
|---|---|---|---|---|---|---|
| GET | `/symptoms` | 증상 버튼 목록 S01~S16 | 대원 | - | S-04 환자 정보 입력 | SFR-108, 부록 B |
| GET | `/geocode` | 주소 → 좌표 (위치 실패·미동의) | 대원 | - | S-04 · S-06 주소 입력 | SFR-009, INR-004 |
| GET | `/hospitals/nearby` | 주변 병원 (지도·오프라인 저장용) | 대원 | - | S-06 지도 · S-11 오프라인 | SFR-027, SFR-059, SFR-061, SFR-064 |
| GET | `/hospitals/{hospitalId}` | 병원 상세 | 대원 | - | S-07 병원 상세 | SFR-007, SFR-081 |

### 4. 이송 (대원 앱 · 핵심)

| 메서드 | 주소 | 하는 일 | 인증 | 상태 전이 | 화면 | 요구사항 |
|---|---|---|---|---|---|---|
| POST | `/transports` | 이송 건 만들기 + 병원에 동시 요청 | 대원 | CREATE_WITH_TARGETS, CREATE_NO_TARGET, FINISH_PREVIOUS | S-04 → S-05 응답 대기 / S-06 | SFR-109, SFR-104, SFR-129, SFR-157, SFR-161 |
| GET | `/transports/current` | 진행 중 이송 불러오기 (앱 재실행 복구) | 대원 | - | 앱 시작 · 모든 이송 화면 | SFR-133 |
| GET | `/transports/{transportId}` | 이송 건 보기 | 대원 | - | S-05 · S-09 | SFR-110 |
| POST | `/transports/{transportId}/confirm` | 승인 병원 확정 | 대원 | CONFIRM | S-05 확정 확인 | SFR-111, SFR-134, SFR-160, SFR-125 |
| POST | `/transports/{transportId}/fallback` | 기다리지 않고 예비로 | 대원 | GO_FALLBACK | S-05 응답 대기 | SFR-112 |
| GET | `/transports/{transportId}/recommendations` | 예비 추천 목록 | 대원 | - | S-06 예비 추천 | SFR-112, SFR-098, SFR-027, SFR-030, SFR-002 |
| PUT | `/transports/{transportId}/fallback-radius` | 예비 추천 반경 넓히기 (요청은 안 보냄) | 대원 | - | S-06 예비 추천 | SFR-029, SFR-012 |
| POST | `/transports/{transportId}/rounds` | 다시 요청 (반경 넓히기 · 승인 취소 후) | 대원 | EXPAND_ROUND, RE_REQUEST | S-06 · S-09 승인 취소 경보 | SFR-131, SFR-128, SFR-156 |
| POST | `/transports/{transportId}/phone-check/start` | 추천 병원으로 전화 확인 시작 | 대원 | START_PHONE_CHECK | S-06 → S-08 전화 확인 | SFR-032, SFR-031 |
| POST | `/transports/{transportId}/phone-checks` | 전화 확인 결과 기록 | 대원 | PHONE_ACCEPTED, PHONE_PROCEED, PHONE_REJECTED_NEXT, PHONE_REJECTED_LAST, PHONE_DISMISSED | S-08 전화 확인 | SFR-032, SFR-033, SFR-034, SFR-074, SFR-075 |
| POST | `/transports/{transportId}/nav-device` | 경로 안내 담당 단말 응답 | 대원 | - | S-09 경로 안내 | SFR-132, SFR-133 |
| POST | `/transports/{transportId}/assessments` | 변경 사항 보내기 | 대원 | ASSESSMENT_UPDATED | S-05 · S-09 | SFR-121, SFR-105 |
| POST | `/transports/{transportId}/locations` | 위치 올리기 (5초마다, 담당 단말만) | 대원 | - | S-09 경로 안내 | SFR-037, SFR-079, SER-002 |
| POST | `/transports/{transportId}/destination` | 목적지 변경 (이송 건당 1번) | 대원 | CHANGE_DESTINATION | S-09 경로 안내 | SFR-077, SFR-156 |
| POST | `/transports/{transportId}/arrive` | 도착 처리 | 대원 | ARRIVE | S-10 도착 처리 | SFR-038, SFR-080, SFR-039, SFR-144 |
| POST | `/transports/{transportId}/cancel` | 이송 취소 | 대원 | CANCEL | S-05 · S-06 · S-08 · S-09 | SFR-076 |
| POST | `/transports/sync` | 통신 두절 중 기록 올리기 | 대원 | CREATE_NO_TARGET, PHONE_ACCEPTED, PHONE_PROCEED, PHONE_REJECTED_NEXT, PHONE_REJECTED_LAST, PHONE_DISMISSED, ARRIVE | S-11 오프라인 → 복구 | SFR-099, SFR-068, SFR-160 |

### 5. 병원 웹

| 메서드 | 주소 | 하는 일 | 인증 | 상태 전이 | 화면 | 요구사항 |
|---|---|---|---|---|---|---|
| POST | `/hw/pc/register` | 라이선스 키로 PC 등록 | 없음 | - | H-01 PC 등록 | SFR-116, SFR-147, COR-012 |
| GET | `/hw/session` | 현재 PC·병원 정보 | 병원 PC | - | H-01 · 상단 바 | SFR-116, SFR-146, SFR-139 |
| POST | `/hw/shifts` | 근무 시작 (담당자 이름) | 병원 PC | - | H-01 근무 시작 | SFR-117 |
| POST | `/hw/shifts/current/alarm-on` | 알림 켜기 (이때부터 요청 대상) | 병원 PC | - | H-01 근무 시작 | SFR-117, SFR-136 |
| POST | `/hw/shifts/current/end` | 근무 종료 | 병원 PC | - | H-02 | SFR-117 |
| PUT | `/hw/pause` | 잠시 요청 중지 / 다시 받기 | 병원 PC | PAUSE_AUTO_REJECT | H-02 탭 | SFR-139 |
| GET | `/hw/requests` | 요청 목록 (남은 시간 짧은 순) | 병원 PC | - | H-02 요청 목록 | SFR-135, SFR-155, SER-014 |
| GET | `/hw/requests/{requestId}` | 요청 상세 (열람 기록 남김) | 병원 PC | - | H-02 요청 상세 | SFR-118, SFR-137, SER-014 |
| POST | `/hw/requests/{requestId}/approve` | 승인 (+메모) | 병원 PC | APPROVE | H-02 요청 상세 | SFR-119, SFR-140, SFR-154, SFR-153, SFR-160 |
| POST | `/hw/requests/{requestId}/reject` | 거절 (사유 필수) | 병원 PC | REJECT | H-02 거절 사유 | SFR-119, SFR-126 |
| POST | `/hw/requests/{requestId}/cancel-approval` | 승인 취소 (사유 필수) | 병원 PC | CANCEL_APPROVAL | H-02 · H-03 | SFR-128, SFR-130 |
| GET | `/hw/incoming` | 도착 예정 환자 | 병원 PC | - | H-03 도착 예정 | SFR-121, SFR-105, SFR-158 |
| POST | `/hw/requests/{requestId}/extra-memo` | 추가 메모 (1번) | 병원 PC | - | H-03 도착 예정 | SFR-140 |
| POST | `/hw/requests/{requestId}/confirm-arrival` | 병원에서 도착 확인 | 병원 PC | ARRIVE | H-03 도착 예정 | SFR-144 |
| POST | `/hw/requests/{requestId}/unacceptable` | 도착 후 수용 불가 (10분 안) | 병원 PC | UNACCEPTABLE | H-03 도착 예정 | SFR-158 |

### 6. 관리자 웹

| 메서드 | 주소 | 하는 일 | 인증 | 상태 전이 | 화면 | 요구사항 |
|---|---|---|---|---|---|---|
| POST | `/admin/auth/login` | 관리자 로그인 (비밀번호 + OTP) | 없음 | - | A-01 로그인 | SFR-082, SFR-152 |
| POST | `/admin/auth/otp/enroll` | 첫 로그인 OTP 앱 연결 | 없음 | - | A-01 로그인 | SFR-152 |
| GET | `/admin/signups` | 가입 승인 대기 목록 | 관리자 | - | A-01 가입 승인 | SFR-083 |
| GET | `/admin/signups/{id}/photo` | 공무원증 사진 보기 (열람 기록) | 관리자 | - | A-01 가입 승인 | SFR-083, DAR-012, SER-015 |
| POST | `/admin/signups/{id}/approve` | 가입 승인 | 관리자 | - | A-01 가입 승인 | SFR-083, SFR-091 |
| POST | `/admin/signups/{id}/reject` | 가입 반려 | 관리자 | - | A-01 가입 승인 | SFR-083 |
| GET | `/admin/paramedics` | 대원 계정 검색 | 관리자 | - | A-01 대원 계정 | SFR-151 |
| POST | `/admin/paramedics/{id}/suspend` | 대원 계정 정지 (즉시 로그아웃) | 관리자 | CANCEL | A-01 대원 계정 | SFR-151, SER-016 |
| POST | `/admin/paramedics/{id}/unsuspend` | 정지 해제 | 관리자 | - | A-01 대원 계정 | SFR-151 |
| POST | `/admin/paramedics/{id}/reset-password` | 비밀번호 초기화 | 관리자 | - | A-01 대원 계정 | SFR-021 |
| GET | `/admin/hospitals` | 병원 검색 (공공 데이터) | 관리자 | - | A-03 병원 관리 | SFR-123 |
| POST | `/admin/hospitals/{id}/account` | 병원 계정 + 라이선스 키 발급 | 관리자 | - | A-03 병원 관리 | SFR-123, COR-013 |
| POST | `/admin/hospitals/{id}/license-keys` | 키 재발급 (사유) | 관리자 | - | A-03 병원 관리 | SFR-146 |
| POST | `/admin/license-keys/{id}/revoke` | 키 폐기 (사유) | 관리자 | - | A-03 병원 관리 | SFR-146 |
| POST | `/admin/hospitals/{id}/suspend` | 병원 계정 정지 (모든 PC 차단) | 관리자 | - | A-03 병원 관리 | SFR-123 |
| GET | `/admin/hospitals/{id}/pcs` | 등록 PC 목록 | 관리자 | - | A-03 병원 관리 | SFR-147 |
| DELETE | `/admin/pcs/{id}` | PC 해제 | 관리자 | - | A-03 병원 관리 | SFR-147 |
| PUT | `/admin/hospitals/{id}/entrance` | 응급실 입구 좌표 지정 | 관리자 | - | A-03 병원 관리 | SFR-145 |
| GET | `/admin/notifications` | 관리자 알림 | 관리자 | - | A-02 모니터링 | SFR-100, SFR-148 |
| POST | `/admin/notifications/{id}/read` | 알림 읽음 | 관리자 | - | A-02 모니터링 | SFR-100 |
| GET | `/admin/audit-logs` | 작업 이력 (수정·삭제 불가) | 관리자 | - | A-02 모니터링 | SFR-091 |
| GET | `/admin/stats/hospitals` | 병원 응답 통계 | 관리자 | - | A-02 모니터링 | SFR-106, SFR-126 |

## 오류 코드

| HTTP | 코드 | 뜻 · 앱이 할 일 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 입력 형식이 틀림 (details.fields) |
| 400 | `VERSION_REQUIRED` | 상태를 바꾸는 요청에 version이 없음 (개발 실수) |
| 401 | `INVALID_CREDENTIALS` | 아이디·비밀번호가 틀림 |
| 401 | `INVALID_LICENSE` | 라이선스 키가 틀림 |
| 401 | `INVALID_OTP` | OTP가 틀림 |
| 401 | `PC_NOT_REGISTERED` | 등록 PC 쿠키 없음·무효 → PC 등록 화면 |
| 401 | `TOKEN_EXPIRED` | 토큰 만료 → refresh |
| 401 | `TOKEN_REVOKED` | 토큰 폐기 → 다시 로그인 |
| 403 | `ACCOUNT_SUSPENDED` | 정지된 계정 |
| 403 | `DRIVER_INPUT_LOCKED` | 운전 중 입력 잠금 |
| 403 | `LICENSE_EXPIRED` | 라이선스 키 만료 → 관리자에게 재발급 요청 |
| 403 | `NOT_APPROVED` | 가입 승인 전 계정 |
| 403 | `NOT_NAV_DEVICE` | 경로 안내 담당 단말이 아님 → 보기 전용 |
| 403 | `ORIGIN_NOT_ALLOWED` | 허용되지 않은 Origin (CSRF 방어) |
| 403 | `OTP_SETUP_REQUIRED` | OTP 첫 연결 필요 (details.setupToken·otpauthUrl) |
| 404 | `ADDRESS_NOT_FOUND` | 주소를 좌표로 못 바꿈 |
| 404 | `AGENCY_NOT_FOUND` | 소속기관 코드 없음 |
| 404 | `NOT_FOUND` | 없거나 **내 것이 아님** (다른 팀 이송 건·다른 병원 요청·남의 초대도 404로 숨김, SER-010·013) |
| 404 | `NOT_IN_TEAM` | 근무 중인 팀이 없음 → 근무 시작 화면 |
| 404 | `NO_ACTIVE_TRANSPORT` | 진행 중 이송 없음 → 환자 정보 입력 |
| 404 | `TEAM_NOT_FOUND` | 팀 코드·QR 없음 |
| 409 | `ACCOUNT_EXISTS` | 이미 병원 계정 있음 |
| 409 | `ACTIVE_TRANSPORT_CONFIRM_REQUIRED` | 근무 종료·로그아웃·탈퇴·정지 전 '진행 중 이송 1건이 있어요' 확인 필요 |
| 409 | `ACTIVE_TRANSPORT_EXISTS` | 팀에 진행 중 이송이 있음 (details.activeTransport) → 그 화면으로, moving이면 '이전 이송 끝내기' 확인 |
| 409 | `ALREADY_IN_TEAM` | 이미 팀에 있음 |
| 409 | `ALREADY_RESPONDED` | 다른 PC가 먼저 응답함 (details.respondedBy·pcName) |
| 409 | `AMBULANCE_NOT_NEAR` | 구급차가 입구 200m 밖 |
| 409 | `APPROVAL_CANCELLED` | 병원이 승인을 취소함 |
| 409 | `APPROVAL_EXPIRED` | 승인 5분이 지남 |
| 409 | `DESTINATION_CHANGE_USED` | 목적지 변경 1번 이미 씀 → 이송 취소 후 새로 |
| 409 | `DRIVER_TAKEN` | 운전 역할이 이미 있음 |
| 409 | `EXTRA_MEMO_USED` | 추가 메모 1번 이미 씀 |
| 409 | `INVALID_TRANSITION` | 지금 상태에서 할 수 없는 동작 (상태 전이표에 없음) → details.current로 화면 갱신 |
| 409 | `INVITE_EXPIRED` | 초대 5분 만료 |
| 409 | `LOGIN_ID_TAKEN` | 이미 쓰는 아이디 |
| 409 | `MAX_RADIUS` | 이미 40km → '가까운 병원에 전화로 확인하세요' |
| 409 | `NAV_DEVICE_ASSIGNED` | 경로 안내 담당이 이미 다른 단말 → 보기 전용 |
| 409 | `NOTHING_TO_SEND` | 보낼 변경 사항 없음 |
| 409 | `OVER_APPROVAL_CONFIRM_REQUIRED` | 병상보다 많이 승인 (details.validApprovals·erAvail) → 확인 후 overApprovalConfirmed=true로 다시 |
| 409 | `PC_LIMIT_REACHED` | PC 3대 꽉 참 (details.pcs) → 바꿀 PC 선택 |
| 409 | `REQUEST_CLOSED` | 닫힌 요청 (환자 정보도 안 줌) |
| 409 | `REQUEST_EXPIRED` | 2분이 지나 응답할 수 없음 |
| 409 | `REQUEST_NOT_APPROVED` | 승인 상태가 아닌 요청 |
| 409 | `RE_REQUEST_NOT_ALLOWED` | 다시 요청은 확정 병원이 승인 취소했을 때만 |
| 409 | `SIGNUP_NOT_REJECTED` | 반려된 계정만 재신청 가능 |
| 409 | `TARGET_IN_TEAM` | 초대 대상이 이미 다른 팀 |
| 409 | `TEAM_FULL` | 팀 4명 꽉 참 |
| 409 | `VERSION_CONFLICT` | 그사이 다른 사람이 바꿈 → details.current로 화면 갱신 |
| 409 | `WINDOW_PASSED` | 도착 후 10분이 지나 수용 불가를 못 누름 |
| 410 | `PHOTO_DELETED` | 공무원증 사진이 이미 삭제됨 |
| 422 | `ASSESSMENT_INCOMPLETE` | 주 증상 등 필수 항목 비어 있음 |
| 422 | `CONSENT_REQUIRED` | 사진 동의 필수 |
| 422 | `NO_REQUEST_TARGET` | 반경 넓히기 대상 0곳 (상태 그대로) → 다음 단계 반경 안내 |
| 422 | `REASON_REQUIRED` | 사유 필수 |
| 423 | `ACCOUNT_LOCKED` | 5번 실패 → 10분 잠금 |
| 423 | `PIN_LOCKED_OUT` | PIN 5번 실패 → 로그아웃 |
| 423 | `TOO_MANY_ATTEMPTS` | 라이선스 키 5번 실패 → 잠금 |

## 화면 → API 대조표

| 화면 | 부르는 API |
|---|---|
| S-01 | (서버 호출 없음 · 폰 권한만) |
| S-02 | `GET /agencies/{code}` · `POST /auth/signup` · `PUT /me/signup` · `POST /auth/login` · `GET /me` · `POST /me/pin/verify` |
| S-03 | `POST /teams` · `POST /teams/join` · `GET /teams/current` · `PATCH /teams/current/members/me` · `POST /teams/current/leave` · `GET /paramedics/on-duty` · `POST /teams/current/invites` · `PUT /memos/{paramedicId}` |
| S-04 | `GET /teams/current/draft` · `PATCH /teams/current/draft` · `DELETE /teams/current/draft` · `GET /symptoms` · `GET /geocode` · `POST /transports` |
| S-05 | `POST /transports` · `GET /transports/{transportId}` · `POST /transports/{transportId}/confirm` · `POST /transports/{transportId}/fallback` · `POST /transports/{transportId}/assessments` · `POST /transports/{transportId}/cancel` |
| S-06 | `GET /geocode` · `GET /hospitals/nearby` · `POST /transports` · `GET /transports/{transportId}/recommendations` · `PUT /transports/{transportId}/fallback-radius` · `POST /transports/{transportId}/rounds` · `POST /transports/{transportId}/phone-check/start` · `POST /transports/{transportId}/cancel` |
| S-07 | `GET /hospitals/{hospitalId}` |
| S-08 | `POST /transports/{transportId}/phone-check/start` · `POST /transports/{transportId}/phone-checks` · `POST /transports/{transportId}/cancel` |
| S-09 | `GET /transports/{transportId}` · `POST /transports/{transportId}/rounds` · `POST /transports/{transportId}/nav-device` · `POST /transports/{transportId}/assessments` · `POST /transports/{transportId}/locations` · `POST /transports/{transportId}/destination` · `POST /transports/{transportId}/cancel` |
| S-10 | `POST /transports/{transportId}/arrive` |
| S-11 | `GET /hospitals/nearby` · `POST /transports/sync` |
| S-12 | `POST /auth/logout` · `PUT /me/pin` · `DELETE /me` · `POST /teams/current/leave` |
| H-01 | `POST /hw/pc/register` · `GET /hw/session` · `POST /hw/shifts` · `POST /hw/shifts/current/alarm-on` |
| H-02 | `POST /hw/shifts/current/end` · `PUT /hw/pause` · `GET /hw/requests` · `GET /hw/requests/{requestId}` · `POST /hw/requests/{requestId}/approve` · `POST /hw/requests/{requestId}/reject` · `POST /hw/requests/{requestId}/cancel-approval` |
| H-03 | `POST /hw/requests/{requestId}/cancel-approval` · `GET /hw/incoming` · `POST /hw/requests/{requestId}/extra-memo` · `POST /hw/requests/{requestId}/confirm-arrival` · `POST /hw/requests/{requestId}/unacceptable` |
| A-01 | `POST /admin/auth/login` · `POST /admin/auth/otp/enroll` · `GET /admin/signups` · `GET /admin/signups/{id}/photo` · `POST /admin/signups/{id}/approve` · `POST /admin/signups/{id}/reject` · `GET /admin/paramedics` · `POST /admin/paramedics/{id}/suspend` · `POST /admin/paramedics/{id}/unsuspend` · `POST /admin/paramedics/{id}/reset-password` |
| A-02 | `GET /admin/notifications` · `POST /admin/notifications/{id}/read` · `GET /admin/audit-logs` · `GET /admin/stats/hospitals` |
| A-03 | `GET /admin/hospitals` · `POST /admin/hospitals/{id}/account` · `POST /admin/hospitals/{id}/license-keys` · `POST /admin/license-keys/{id}/revoke` · `POST /admin/hospitals/{id}/suspend` · `GET /admin/hospitals/{id}/pcs` · `DELETE /admin/pcs/{id}` · `PUT /admin/hospitals/{id}/entrance` |

## 예시: 핵심 한 바퀴

```http
POST /api/v1/transports            {id, radiusKm:20, assessment...}   # ① 201 requesting (대상 0곳이면 201 fallback)
GET  /api/v1/hw/requests            # ② 병원: request.new ack 후 목록
POST /api/v1/hw/requests/102/approve  {"memo":"3번 출입구로 오세요","version":1}
POST /api/v1/transports/{id}/confirm  Idempotency-Key: 7f3c...  {"hospitalRequestId":102,"version":3}
POST /api/v1/transports/{id}/nav-device {"deviceId":"...","version":4}   # 운전 단말 10초 안
POST /api/v1/transports/{id}/locations  (5초마다, 담당 단말만)
POST /api/v1/transports/{id}/arrive   {"method":"button","version":4}
```

## 예시: 예비 흐름

```http
GET  /api/v1/transports/{id}/recommendations
POST /api/v1/transports/{id}/phone-check/start {"hospitalId":7,"version":2}      # fallback → phone_check
POST /api/v1/transports/{id}/phone-checks {"hospitalId":7,"result":"rejected","version":3}  # 다음 후보 or fallback
POST /api/v1/transports/{id}/rounds {"kind":"expand","radiusKm":30,"version":4}  # fallback → requesting
```
