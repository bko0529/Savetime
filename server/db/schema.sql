-- =====================================================================
-- 세이브타임 DB 스키마 v0.2 (PostgreSQL 16)  ·  요구사항분석서 v0.115 · 상태 전이표 v0.2 기준
-- 그룹: A 계정·인증 / B 팀 / C 병원 / D 이송(핵심) / E 기록·통계 / F 관리자
-- 규칙: 시간은 모두 timestamptz(서버 시각), 삭제 대신 상태값·deleted_at 사용
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------- 상태값(enum) ----------
CREATE TYPE paramedic_status   AS ENUM ('pending','approved','rejected','suspended','withdrawn');
CREATE TYPE team_role          AS ENUM ('driver','care');
CREATE TYPE invite_status      AS ENUM ('sent','accepted','declined','expired');
CREATE TYPE transport_status   AS ENUM ('requesting','fallback','phone_check','moving','arrived','cancelled');  -- 상태 전이표 v0.2 (부록 A)
CREATE TYPE hreq_status        AS ENUM ('waiting','delivery_failed','approved','rejected','expired','closed','confirmed','arrived','unacceptable');
CREATE TYPE phone_result       AS ENUM ('accepted','rejected','no_answer','skipped','dismissed');  -- dismissed = 결과 미선택 (부록 A18)
CREATE TYPE platform_kind      AS ENUM ('android','ios');
CREATE TYPE owner_kind         AS ENUM ('paramedic','admin');

-- =====================================================================
-- F. 관리자 (A에서 참조하므로 먼저)
-- =====================================================================
CREATE TABLE admin (
  id            bigserial PRIMARY KEY,
  login_id      varchar(40)  NOT NULL UNIQUE,
  password_hash text         NOT NULL,
  otp_secret    text,                                  -- SFR-152 OTP (첫 로그인 때 연결)
  otp_enrolled_at timestamptz,
  name          varchar(40)  NOT NULL,
  failed_count  int          NOT NULL DEFAULT 0,       -- 5회 실패 10분 잠금
  locked_until  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now()    -- 초기 데이터로만 생성 (COR-007)
);

-- =====================================================================
-- A. 계정·인증
-- =====================================================================
CREATE TABLE agency (                                  -- 소속기관(소방서) 코드, 초기 데이터
  id         bigserial PRIMARY KEY,
  code       varchar(20)  NOT NULL UNIQUE,             -- 예: CN-SB-019
  name       varchar(60)  NOT NULL,                    -- 천안서북소방서
  region     varchar(40)  NOT NULL
);

CREATE TABLE paramedic (                               -- 구급대원
  id            bigserial PRIMARY KEY,
  login_id      varchar(40)  NOT NULL UNIQUE,
  password_hash text         NOT NULL,
  must_change_pw boolean     NOT NULL DEFAULT false,   -- 관리자 초기화 후 (SFR-021)
  name          varchar(40)  NOT NULL,
  rank          varchar(20)  NOT NULL,                 -- 계급
  agency_id     bigint       NOT NULL REFERENCES agency(id),
  safety_center varchar(60)  NOT NULL,                 -- 소속 안전센터
  employee_no   varchar(30)  NOT NULL,                 -- 사번 (동명이인 구분)
  status        paramedic_status NOT NULL DEFAULT 'pending',
  pin_hash      text,                                  -- 앱 잠금 PIN 6자리 (SFR-150)
  pin_failed    int          NOT NULL DEFAULT 0,
  failed_count  int          NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz
);

CREATE TABLE signup_request (                          -- 공무원증 가입 신청 (SFR-017, SFR-083)
  id            bigserial PRIMARY KEY,
  paramedic_id  bigint      NOT NULL REFERENCES paramedic(id),
  photo_key     text,                                  -- 저장소 키. 승인/반려 즉시 NULL (DAR-012)
  consent_at    timestamptz NOT NULL,                  -- 사진 수집·이용 동의
  decided_by    bigint      REFERENCES admin(id),
  decided_at    timestamptz,
  result        varchar(10) CHECK (result IN ('approved','rejected')),
  reject_reason varchar(20) CHECK (reject_reason IN ('photo_unclear','info_mismatch','agency_unverified','photo_expired','etc')),
  created_at    timestamptz NOT NULL DEFAULT now()   -- 반려 뒤 재신청하면 같은 대원에 새 행 (SFR-083)
);

CREATE TABLE refresh_token (                           -- 폐기 가능한 로그인 토큰 (SER-016)
  id          bigserial PRIMARY KEY,
  owner_type  owner_kind  NOT NULL,
  owner_id    bigint      NOT NULL,
  token_hash  text        NOT NULL UNIQUE,
  device_id   varchar(80),
  expires_at  timestamptz NOT NULL,                    -- 30일 (SER-007)
  revoked_at  timestamptz,                             -- 정지·로그아웃·PIN 5회 실패 시
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_token (owner_type, owner_id) WHERE revoked_at IS NULL;

CREATE TABLE push_device (                             -- FCM 토큰 (iOS는 FCM→APNs)
  id            bigserial PRIMARY KEY,
  paramedic_id  bigint        NOT NULL REFERENCES paramedic(id),
  device_id     varchar(80)   NOT NULL,
  platform      platform_kind NOT NULL,
  fcm_token     text          NOT NULL,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (paramedic_id, device_id)
);

-- =====================================================================
-- B. 팀
-- =====================================================================
CREATE TABLE team (
  id          bigserial PRIMARY KEY,
  code        char(4)     NOT NULL,                    -- 팀 코드 4821 (활성 팀끼리만 유일)
  qr_token    text        NOT NULL,
  created_by  bigint      NOT NULL REFERENCES paramedic(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE UNIQUE INDEX team_code_active ON team (code) WHERE ended_at IS NULL;

CREATE TABLE team_member (
  team_id       bigint      NOT NULL REFERENCES team(id),
  paramedic_id  bigint      NOT NULL REFERENCES paramedic(id),
  role          team_role   NOT NULL,
  device_id     varchar(80),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  joined_seq    bigint,                                 -- 팀에 들어온 시점의 event_log.seq (그 전 이벤트는 다시 보내지 않음)
  left_reason   varchar(12) CHECK (left_reason IN ('duty_end','logout','auto_14h','withdrawal','suspended')),
  left_at       timestamptz,                            -- 근무 종료·로그아웃·14시간 자동 종료
  PRIMARY KEY (team_id, paramedic_id, joined_at)
);
CREATE UNIQUE INDEX one_active_team_per_user ON team_member (paramedic_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX one_driver_per_team     ON team_member (team_id) WHERE left_at IS NULL AND role = 'driver';

CREATE TABLE team_invite (                             -- 목록 초대 (SFR-159), 5분 만료
  id          bigserial PRIMARY KEY,
  team_id     bigint        NOT NULL REFERENCES team(id),
  from_id     bigint        NOT NULL REFERENCES paramedic(id),
  to_id       bigint        NOT NULL REFERENCES paramedic(id),
  status      invite_status NOT NULL DEFAULT 'sent',
  expires_at  timestamptz   NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE paramedic_memo (                          -- 나만 보는 한 줄 메모 (SFR-143)
  owner_id   bigint      NOT NULL REFERENCES paramedic(id),
  target_id  bigint      NOT NULL REFERENCES paramedic(id),
  memo       varchar(20) NOT NULL,
  PRIMARY KEY (owner_id, target_id)
);

CREATE TABLE team_draft (                              -- 팀 작성 중 환자 정보, 서버에 1개 (SFR-114)
  team_id     bigint      PRIMARY KEY REFERENCES team(id),
  data        jsonb       NOT NULL DEFAULT '{}',       -- 환자 평가 항목 (아래 assessment와 같은 키)
  field_meta  jsonb       NOT NULL DEFAULT '{}',       -- 항목별 {by, at}: 같은 항목 동시 수정은 나중 값 저장 + 알림 (SFR-114)
  version     int         NOT NULL DEFAULT 1,          -- 항목 병합 후 +1 (충돌로 거부하지 않음)
  updated_by  bigint      REFERENCES paramedic(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- C. 병원
-- =====================================================================
CREATE TABLE hospital (
  id              bigserial PRIMARY KEY,
  public_id       varchar(20)   NOT NULL UNIQUE,       -- 공공 데이터 기관 ID
  name            varchar(80)   NOT NULL,
  address         text,
  lat             numeric(9,6)  NOT NULL,
  lng             numeric(9,6)  NOT NULL,
  er_phone        varchar(20),                         -- 응급실 직통 (대원 전화용)
  main_phone      varchar(20),
  entrance_lat    numeric(9,6),                        -- 응급실 입구 좌표 (SFR-145)
  entrance_lng    numeric(9,6),
  in_region       boolean       NOT NULL DEFAULT true, -- 수집 지역 밖이면 '병상 정보 없음'
  account_active  boolean       NOT NULL DEFAULT false,-- 병원 계정 발급·정지
  requests_paused boolean       NOT NULL DEFAULT false,-- 잠시 요청 중지 (SFR-139, 병원 전체에 적용)
  paused_at       timestamptz                          -- 2시간 알림용
);

CREATE TABLE license_key (                             -- 라이선스 키 (SFR-123, 146)
  id            bigserial PRIMARY KEY,
  hospital_id   bigint      NOT NULL REFERENCES hospital(id),
  key_hash      text        NOT NULL UNIQUE,
  key_prefix    char(4)     NOT NULL,                  -- 화면에는 앞 4자리만
  issued_by     bigint      NOT NULL REFERENCES admin(id),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,                  -- 1년
  revoked_at    timestamptz,
  revoke_reason varchar(60)
);

CREATE TABLE hospital_pc (                             -- 등록 PC (병원당 3대, SFR-116, 147)
  id            bigserial PRIMARY KEY,
  hospital_id   bigint      NOT NULL REFERENCES hospital(id),
  name          varchar(40) NOT NULL,                  -- 응급실 접수대
  token_hash    text        NOT NULL UNIQUE,           -- httpOnly 쿠키 토큰 (COR-012)
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz                            -- 교체·해제·90일 미사용
);

CREATE TABLE hospital_shift (                          -- 근무 시작 · 알림 켜기 (SFR-117)
  id          bigserial PRIMARY KEY,
  pc_id       bigint      NOT NULL REFERENCES hospital_pc(id),
  staff_name  varchar(40) NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  alarm_on_at timestamptz,                             -- NULL이면 요청 대상 아님
  ended_at    timestamptz
);

CREATE TABLE bed_current (                             -- 병상 캐시: 병원당 최신 1행 (수집기가 3분마다 덮어씀)
  hospital_id  bigint      PRIMARY KEY REFERENCES hospital(id),
  er_avail int, er_total int, icu_avail int, icu_total int, or_avail int, or_total int,
  source_time  timestamptz NOT NULL,                   -- 공공 데이터 기준 시각 ('기준 14:02')
  collected_at timestamptz NOT NULL DEFAULT now(),
  raw          jsonb
);

CREATE TABLE bed_history (                             -- 병상 이력 30일 (DAR-007, 2단계 분석용)
  hospital_id  bigint      NOT NULL REFERENCES hospital(id),
  collected_at timestamptz NOT NULL,
  er_avail int, er_total int, icu_avail int, icu_total int, or_avail int, or_total int,
  PRIMARY KEY (hospital_id, collected_at)
);

CREATE TABLE capability_item (                         -- 중증질환 진료가능 항목 (공공 데이터 표기 그대로)
  code  varchar(20) PRIMARY KEY,
  name  varchar(80) NOT NULL
);

CREATE TABLE hospital_capability (
  hospital_id  bigint      NOT NULL REFERENCES hospital(id),
  item_code    varchar(20) NOT NULL REFERENCES capability_item(code),
  available    boolean     NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (hospital_id, item_code)
);

CREATE TABLE symptom (                                 -- 증상 버튼 S01~S16 (부록 B)
  code          char(3)     PRIMARY KEY,
  name          varchar(60) NOT NULL,
  required_beds varchar(3)[] NOT NULL CHECK (required_beds <@ ARRAY['er','icu','or']::varchar[])  -- 필수 병상 게이트, 여러 개 가능 (부록 C, DAR-001)
);

CREATE TABLE symptom_capability (                      -- 증상 ↔ 진료가능 항목 (여러 개 가능)
  symptom_code char(3)     NOT NULL REFERENCES symptom(code),
  item_code    varchar(20) NOT NULL REFERENCES capability_item(code),
  PRIMARY KEY (symptom_code, item_code)
);

-- =====================================================================
-- D. 이송 (핵심)   이송 건 1 : N 요청 회차 1 : N 병원 요청  (부록 A-2)
-- =====================================================================
CREATE TABLE transport (                               -- 이송 건
  id                    uuid             PRIMARY KEY,  -- 처음 만든 단말이 정함 (오프라인 복구 시 같은 ID)
  team_id               bigint           REFERENCES team(id),          -- 종료 뒤 팀 연결 끊음 (SFR-086, DAR-013)
  prev_transport_id     uuid             REFERENCES transport(id),  -- 직전 건 (제외 병원 이어받기)
  status                transport_status NOT NULL DEFAULT 'requesting',
  request_radius_km     smallint         NOT NULL DEFAULT 20 CHECK (request_radius_km IN (10,20,30,40)),
  fallback_radius_km    smallint         NOT NULL DEFAULT 20 CHECK (fallback_radius_km IN (10,20,30,40)),
  origin_lat            numeric(9,6),                   -- 원본 위치: 이송 끝나면 NULL
  origin_lng            numeric(9,6),
  location_consent      boolean          NOT NULL,
  address               varchar(120),                   -- 위치 미동의 시 주소 (SFR-009)
  offline_created       boolean          NOT NULL DEFAULT false, -- 통신 두절 중 만든 건 (SFR-099)
  phone_target_hospital_id bigint        REFERENCES hospital(id), -- 전화 확인 대상 병원 (부록 A13·A16)
  fallback_reason       varchar(24),                    -- 예비 추천 전환 사유 (마지막)
  confirmed_hospital_id bigint           REFERENCES hospital(id),
  nav_device_id         varchar(80),                    -- 경로 안내 담당 단말
  version               int              NOT NULL DEFAULT 1,  -- 이송 건 행이 바뀔 때만 +1 (병원 응답은 안 올림)
  confirmed_at          timestamptz,
  departed_at           timestamptz,                    -- 처음 출발 시각, 다시 요청·목적지 변경 뒤에도 유지 (SFR-036)
  last_activity_at      timestamptz      NOT NULL DEFAULT now(), -- 2시간 활동 없음 자동 종료 (SFR-086, 위치 기록 제외)
  arrived_at            timestamptz,
  arrival_method        varchar(16) CHECK (arrival_method IN ('button','menu','hospital','finish_previous')),
  cancelled_at          timestamptz,
  cancel_reason         varchar(20) CHECK (cancel_reason IN ('user','auto_inactive','duty_end','logout','withdrawal','suspended','offline_superseded')),
  dest_changed_at       timestamptz,                   -- 목적지 변경은 1번만 (SFR-077)
  dest_changed_from_hospital_id bigint REFERENCES hospital(id),
  dest_change_reason    varchar(16) CHECK (dest_change_reason IN ('patient_change','road','hospital','etc')),
  created_at            timestamptz      NOT NULL DEFAULT now()
);
-- 팀당 진행 중 이송 1건 (서버가 강제)
CREATE UNIQUE INDEX one_active_transport_per_team ON transport (team_id)
  WHERE status IN ('requesting','fallback','phone_check','moving');

CREATE TABLE transport_status_history (              -- 상태마다 변경 시각·사유 (SFR-086, 부록 A '기록하는 것')
  id           bigserial        PRIMARY KEY,
  transport_id uuid             NOT NULL REFERENCES transport(id),
  from_status  transport_status,
  to_status    transport_status NOT NULL,
  event        varchar(32)      NOT NULL,             -- stateMachine.ts TransportEvent
  reason       varchar(24),
  at           timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX ON transport_status_history (transport_id, at);

CREATE TABLE assessment (                              -- 병원에 보낸 환자 평가 (보낼 때마다 1행, SFR-108·121)
  id              bigserial   PRIMARY KEY,
  transport_id    uuid        NOT NULL REFERENCES transport(id),
  seq             int         NOT NULL,                -- 1 = 첫 요청, 2.. = 변경 사항 보내기
  chief_complaint varchar(100),                        -- 주 증상 (직접 입력)
  symptom_code    char(3)     REFERENCES symptom(code),-- 버튼으로 골랐을 때만, 아니면 NULL('미선택')
  sex             char(1)     CHECK (sex IN ('M','F','U')),            -- U = 확인 불가
  age_band        varchar(10),
  consciousness   varchar(12) CHECK (consciousness IN ('alert','verbal','pain','unresponsive','unknown')),
  bp              varchar(10), pulse smallint, resp smallint, spo2 smallint,
  pain_site       varchar(30), pain_score smallint CHECK (pain_score BETWEEN 0 AND 10),
  onset           varchar(30),
  trauma          varchar(7)  CHECK (trauma IN ('yes','no','unknown')),
  trauma_cause    varchar(12) CHECK (trauma_cause IN ('traffic','fall_high','fall','penetrating','burn','etc')),
  history         text,        temp numeric(3,1), glucose smallint, ktas smallint,
  unknown_fields  text[]      NOT NULL DEFAULT '{}',   -- '확인 불가'로 보낸 항목
  -- 보낸 대원 칸 없음: 이송 건 기록은 계정과 연결하지 않음 (DAR-013). '누가 보냈는지'는 실시간 이벤트에만 이름으로
  sent_at        timestamptz NOT NULL DEFAULT now(),
  purged_at       timestamptz,                         -- 보관 기간 뒤 항목 삭제 (DAR-010)
  UNIQUE (transport_id, seq)
);

CREATE TABLE request_round (                           -- 요청 회차 (첫 요청, 반경 넓혀 다시 요청, 다시 요청)
  id                  bigserial   PRIMARY KEY,
  transport_id        uuid        NOT NULL REFERENCES transport(id),
  round_no            smallint    NOT NULL,
  kind                varchar(12) NOT NULL DEFAULT 'first' CHECK (kind IN ('first','expand','re_request','dest_change')),  -- 회차 종류 (round.started.kind)
  radius_km           smallint    NOT NULL CHECK (radius_km IN (10,20,30,40)),
  sent_at             timestamptz NOT NULL DEFAULT now(),
  respond_until       timestamptz NOT NULL,            -- sent_at + 2분
  approval_valid_until timestamptz NOT NULL,           -- sent_at + 5분
  UNIQUE (transport_id, round_no)
);

CREATE TABLE hospital_request (                        -- 병원 요청: 회차 하나에서 병원 한 곳에 보낸 요청
  id                bigserial   PRIMARY KEY,
  round_id          bigint      NOT NULL REFERENCES request_round(id),
  hospital_id       bigint      NOT NULL REFERENCES hospital(id),
  status            hreq_status NOT NULL DEFAULT 'waiting',
  eta_min           smallint,
  eta_source        varchar(10) CHECK (eta_source IN ('straight','route')),  -- 직선 추정 → 길찾기
  delivered_at      timestamptz,                       -- '받았음' (5초 안)
  responded_at      timestamptz,
  responder_name    varchar(40),
  responder_pc_id   bigint      REFERENCES hospital_pc(id),
  memo              varchar(50),                       -- 승인 메모 (SFR-140)
  extra_memo        varchar(50),                       -- 확정 뒤 추가 메모 1번 (SFR-140)
  extra_memo_at     timestamptz,
  prev_approved_recheck boolean NOT NULL DEFAULT false, -- '직전 승인 · 재확인' (SFR-156)
  reason            varchar(20) CHECK (reason IN ('er_bed','icu_or','no_specialist','equipment','overcrowded','etc','paused')),  -- 거절·승인 취소·수용 불가 사유 (paused = 요청 중지 자동 거절)
  reason_text       varchar(20),                       -- '기타' 글 (SFR-119)
  closed_reason     varchar(20) CHECK (closed_reason IN ('other_hospital','fallback','cancelled','expired_approval','approval_cancelled','dest_changed')),
  arrived_at        timestamptz,                       -- 열람 1시간·수용 불가 10분 기준
  in_stats          boolean     NOT NULL DEFAULT true, -- '잠시 요청 중지' 자동 거절은 false
  version           int         NOT NULL DEFAULT 1,    -- 두 PC 동시 응답 시 먼저 온 것만
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, hospital_id)
);
CREATE INDEX ON hospital_request (hospital_id, status);

CREATE TABLE excluded_hospital (                       -- 이번 이송의 제외 병원 (SFR-086 한 규칙)
  transport_id uuid        NOT NULL REFERENCES transport(id),
  hospital_id  bigint      NOT NULL REFERENCES hospital(id),
  reason       varchar(20) NOT NULL CHECK (reason IN ('rejected','approval_cancelled','phone_rejected','dest_changed','unacceptable_prev')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transport_id, hospital_id)
);

CREATE TABLE phone_check (                             -- 예비 흐름 전화 확인 결과 (SFR-032~034)
  id           bigserial    PRIMARY KEY,
  transport_id uuid         NOT NULL REFERENCES transport(id),
  hospital_id  bigint       NOT NULL REFERENCES hospital(id),
  result       phone_result NOT NULL,
  reason       varchar(16) CHECK (reason IN ('no_answer','busy','urgent','etc')),  -- 연결 실패·확인 생략 사유
  reject_reason varchar(16) CHECK (reject_reason IN ('er_bed','icu_or','no_specialist','equipment','overcrowded','etc')),  -- 거절 사유 (선택, SFR-044)
  reason_text  varchar(30),                            -- '기타' 글
  -- 기록한 대원 칸 없음: 전화 결과·거절 기록은 계정과 연결하지 않음 (DAR-004)
  offline     boolean      NOT NULL DEFAULT false,  -- 통신 두절 중 기록 후 복구 때 전송
  client_record_id uuid      UNIQUE,                  -- 앱이 만든 기록 ID: 다시 보내도 한 번만 저장
  created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE location_point (                          -- 이송 중 위치 (담당 단말, 5초마다). 이송 끝나면 바로 삭제
  transport_id uuid         NOT NULL REFERENCES transport(id) ON DELETE CASCADE,
  device_id    varchar(80)  NOT NULL,
  lat          numeric(9,6) NOT NULL,
  lng          numeric(9,6) NOT NULL,
  speed_kmh    numeric(5,1),
  recorded_at  timestamptz  NOT NULL,
  PRIMARY KEY (transport_id, recorded_at)
);

CREATE TABLE idempotency_key (                         -- 같은 확정을 여러 번 보내도 한 번만 (SFR-111)
  key          varchar(64) PRIMARY KEY,
  transport_id uuid        NOT NULL REFERENCES transport(id),
  response     jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- E. 기록·통계 (대원 계정과 연결하지 않음, SER-009·DAR-004)
-- =====================================================================
CREATE TABLE request_view_log (                        -- 병원 열람 기록 (SFR-137)
  id                  bigserial   PRIMARY KEY,
  hospital_request_id bigint      NOT NULL REFERENCES hospital_request(id),
  pc_id               bigint      NOT NULL REFERENCES hospital_pc(id),
  staff_name          varchar(40) NOT NULL,
  viewed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE response_stat (                           -- 응답·거절 통계 행 (환자 정보 삭제 뒤에도 보관)
  id            bigserial   PRIMARY KEY,
  hospital_id   bigint      NOT NULL REFERENCES hospital(id),
  symptom_code  char(3),                               -- NULL = 미선택
  result        varchar(20) NOT NULL CHECK (result IN ('approved','rejected','expired','approval_cancelled','unacceptable')),
  reason        varchar(40),
  response_sec  int,
  round_sent_at timestamptz NOT NULL
);

CREATE TABLE transport_stat (                          -- 익명 소요시간 (원본 위치 대신)
  id                 bigserial   PRIMARY KEY,
  hospital_id        bigint      REFERENCES hospital(id),
  request_to_approve_sec int,
  request_to_depart_sec  int,                          -- 핵심 지표 '요청 → 출발'
  departed_at        timestamptz,
  arrived_at         timestamptz,
  duration_sec       int
);

-- =====================================================================
-- F. 관리자 (계속)
-- =====================================================================
CREATE TABLE admin_audit_log (                         -- 작업 이력: 수정·삭제 불가 (SFR-091)
  id          bigserial   PRIMARY KEY,
  admin_id    bigint      NOT NULL REFERENCES admin(id),
  action      varchar(30) NOT NULL,                    -- approve_signup / view_photo / suspend / issue_key / reset_pw ...
  target_type varchar(20) NOT NULL,
  target_id   bigint,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE RULE audit_no_update AS ON UPDATE TO admin_audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO admin_audit_log DO INSTEAD NOTHING;
CREATE RULE view_log_no_update AS ON UPDATE TO request_view_log DO INSTEAD NOTHING;  -- 열람 기록 수정·삭제 불가 (DAR-011)
CREATE RULE view_log_no_delete AS ON DELETE TO request_view_log DO INSTEAD NOTHING;

CREATE TABLE admin_notification (                      -- 관리자 알림 (같은 종류 30분 안 재발생은 횟수만)
  id          bigserial   PRIMARY KEY,
  kind        varchar(30) NOT NULL,                    -- collect_fail / signup / pc_change / key_expiring / odd_pc
  ref_id      bigint,
  occurrences int         NOT NULL DEFAULT 1,
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);

-- =====================================================================
-- G. 실시간 이벤트 기록 (1-4 실시간 통신 설계) — 끊겼다 다시 붙을 때 놓친 이벤트 다시 보내기
-- =====================================================================
-- 순서 보장: 이벤트를 쓰는 트랜잭션은 INSERT 직전에 pg_advisory_xact_lock(7401)을 잡는다
--          → seq 번호 순서 = 커밋 순서 (빈틈 없이 다시 보내기 가능). 전송은 커밋 후 (outbox)
CREATE TABLE event_log (
  seq          bigserial   PRIMARY KEY,                -- 전체에서 계속 늘어나는 번호 (클라이언트는 마지막 seq를 기억)
  entity_type  varchar(20),                            -- transport / hospital_request / team ...
  entity_id    varchar(40),
  entity_version int,                                  -- 오래된 이벤트가 최신 상태를 덮지 않게
  room         varchar(40) NOT NULL,                   -- team:12 / hospital:3 / paramedic:7 / admin
  name         varchar(40) NOT NULL,                   -- request.approved ...
  payload      jsonb       NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON event_log (room, seq);
-- 24시간 지난 행은 수집기가 지움. payload에는 환자 평가 정보를 넣지 않음 (ID·개수·시각만, SER-014)
