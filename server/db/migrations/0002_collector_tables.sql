-- 수집기가 쓸 기록 테이블과 컬럼 (SFR-007, 023, 088, 090)
-- Up Migration
ALTER TABLE hospital ADD COLUMN departments text[] NOT NULL DEFAULT '{}';  -- 진료과 (SFR-007)
ALTER TABLE bed_current ADD COLUMN excluded boolean NOT NULL DEFAULT false;  -- 이상치라 추천에서 제외 (SFR-088)

CREATE TABLE collect_log (                             -- 시·도별 수집 결과 1회 1행 (SFR-023)
  id             bigserial   PRIMARY KEY,
  region         varchar(20) NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  success        boolean     NOT NULL,
  source_time    timestamptz,                          -- 공공 데이터 기준 시각. 실패하면 비움
  hospital_count int,
  error_code     varchar(40)                           -- 오류 문구는 넣지 않음: 요청 주소에 API 키가 들어 있을 수 있음 (SER-001)
);
CREATE INDEX ON collect_log (region, started_at DESC);

CREATE TABLE bed_anomaly_log (                         -- 이상치 기록 (SFR-088)
  id          bigserial   PRIMARY KEY,
  public_id   varchar(20) NOT NULL,                    -- 좌표가 없으면 hospital 행을 못 만들어서 공공 기관 ID로 남김 (DAR-009)
  reason      varchar(20) NOT NULL CHECK (reason IN ('avail_over_total','negative','no_coords')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  detail      jsonb
);
CREATE INDEX ON bed_anomaly_log (detected_at);

CREATE TABLE api_call_daily (                          -- 외부 API 하루 호출 수 (SFR-090). 실시간 값은 Redis, 여기는 기록용
  api        varchar(20) NOT NULL,
  day        date        NOT NULL,
  calls      int         NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api, day)
);

-- Down Migration
DROP TABLE api_call_daily;
DROP TABLE bed_anomaly_log;
DROP TABLE collect_log;
ALTER TABLE bed_current DROP COLUMN excluded;
ALTER TABLE hospital DROP COLUMN departments;
