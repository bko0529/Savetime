-- S6 경로 안내 담당 단말 (SFR-132): 운전 단말이 10초 안에 응답하지 않으면 넘길 단말(병원을 확정한 대원의 단말)
-- Up Migration
ALTER TABLE transport ADD COLUMN nav_fallback_device_id varchar(80);

-- Down Migration
ALTER TABLE transport DROP COLUMN nav_fallback_device_id;
