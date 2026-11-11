-- S7 위치 이상치 제외 (SFR-040): 직전 정상 좌표에서 초속 60m 넘게 움직인 것으로 계산되는 좌표는 GPS 튐으로 본다.
-- 지우지 않고 표시만 한다. 다음 좌표는 '직전 정상 좌표'와 비교해야 하고, 늦게 온 좌표가 끼면 다시 계산해야 해서다.
-- 입구 200m 판정·이동 거리·익명 경로는 outlier = false 좌표만 쓴다
-- Up Migration
ALTER TABLE location_point ADD COLUMN outlier boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE location_point DROP COLUMN outlier;
