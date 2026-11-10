-- S7 도착 예정 목록 (SFR-121, SFR-132, SFR-144): 앱 안 내비(KNSDK)가 계산한 남은 시간을 담당 단말이 위치와 같이 보낸다.
-- nav_eta_at 은 서버가 받은 DB 시각. 보여 줄 때는 받은 뒤 지난 분을 뺀다 (2분 넘게 안 와도 줄어들게)
-- near_entrance_at: 확정 병원 응급실 입구 200m 안에 처음 들어온 시각 → 병원 웹에 incoming.near 한 번만
-- Up Migration
ALTER TABLE transport
  ADD COLUMN nav_eta_min smallint CHECK (nav_eta_min BETWEEN 0 AND 600),
  ADD COLUMN nav_eta_at timestamptz,
  ADD COLUMN near_entrance_at timestamptz;

-- Down Migration
ALTER TABLE transport DROP COLUMN near_entrance_at, DROP COLUMN nav_eta_at, DROP COLUMN nav_eta_min;
