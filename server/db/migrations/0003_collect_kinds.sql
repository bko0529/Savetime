-- 수집 종류 구분과 진료가능 항목 27개 (INR-001, SFR-007)
-- Up Migration
ALTER TABLE collect_log ADD COLUMN kind varchar(20) NOT NULL DEFAULT 'beds'
  CHECK (kind IN ('beds','hospitals','capabilities'));
DROP INDEX collect_log_region_started_at_idx;
CREATE INDEX ON collect_log (kind, region, started_at DESC);

INSERT INTO capability_item (code, name) VALUES
  ('mkioskty1', '[재관류중재술] 심근경색'),
  ('mkioskty2', '[재관류중재술] 뇌경색'),
  ('mkioskty3', '[뇌출혈수술] 거미막하출혈'),
  ('mkioskty4', '[뇌출혈수술] 거미막하출혈 외'),
  ('mkioskty5', '[대동맥응급] 흉부'),
  ('mkioskty6', '[대동맥응급] 복부'),
  ('mkioskty7', '[담낭담관질환] 담낭질환'),
  ('mkioskty8', '[담낭담관질환] 담도포함질환'),
  ('mkioskty9', '[복부응급수술] 비외상'),
  ('mkioskty10', '[장중첩/폐색] 영유아'),
  ('mkioskty11', '[응급내시경] 성인 위장관'),
  ('mkioskty12', '[응급내시경] 영유아 위장관'),
  ('mkioskty13', '[응급내시경] 성인 기관지'),
  ('mkioskty14', '[응급내시경] 영유아 기관지'),
  ('mkioskty15', '[저체중출생아] 집중치료'),
  ('mkioskty16', '[산부인과응급] 분만'),
  ('mkioskty17', '[산부인과응급] 산과수술'),
  ('mkioskty18', '[산부인과응급] 부인과수술'),
  ('mkioskty19', '[중증화상] 전문치료'),
  ('mkioskty20', '[사지접합] 수족지접합'),
  ('mkioskty21', '[사지접합] 수족지접합 외'),
  ('mkioskty22', '[응급투석] HD'),
  ('mkioskty23', '[응급투석] CRRT'),
  ('mkioskty24', '[정신과적응급] 폐쇄병동입원'),
  ('mkioskty25', '[안과적수술] 응급'),
  ('mkioskty26', '[영상의학혈관중재] 성인'),
  ('mkioskty27', '[영상의학혈관중재] 영유아');

-- Down Migration
DELETE FROM hospital_capability;
DELETE FROM capability_item;
DROP INDEX collect_log_kind_region_started_at_idx;
ALTER TABLE collect_log DROP COLUMN kind;
CREATE INDEX ON collect_log (region, started_at DESC);
