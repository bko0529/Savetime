-- S8 대학병원급 반경 넓히기 (D-141, SFR-012·162): 대학병원급(권역응급의료센터)은 전국 40여 곳뿐이라
-- 대학병원급을 고른 이송은 60·80km 까지 넓힐 수 있다. 등급별 최대(일반 40km)는 서버 코드가 판정하고,
-- DB 는 쓸 수 있는 반경 값만 막는다
-- Up Migration
ALTER TABLE transport DROP CONSTRAINT transport_request_radius_km_check;
ALTER TABLE transport ADD CONSTRAINT transport_request_radius_km_check
  CHECK (request_radius_km IN (10,20,30,40,60,80));
ALTER TABLE transport DROP CONSTRAINT transport_fallback_radius_km_check;
ALTER TABLE transport ADD CONSTRAINT transport_fallback_radius_km_check
  CHECK (fallback_radius_km IN (10,20,30,40,60,80));
ALTER TABLE request_round DROP CONSTRAINT request_round_radius_km_check;
ALTER TABLE request_round ADD CONSTRAINT request_round_radius_km_check
  CHECK (radius_km IN (10,20,30,40,60,80));

-- Down Migration
ALTER TABLE request_round DROP CONSTRAINT request_round_radius_km_check;
ALTER TABLE request_round ADD CONSTRAINT request_round_radius_km_check CHECK (radius_km IN (10,20,30,40));
ALTER TABLE transport DROP CONSTRAINT transport_fallback_radius_km_check;
ALTER TABLE transport ADD CONSTRAINT transport_fallback_radius_km_check
  CHECK (fallback_radius_km IN (10,20,30,40));
ALTER TABLE transport DROP CONSTRAINT transport_request_radius_km_check;
ALTER TABLE transport ADD CONSTRAINT transport_request_radius_km_check
  CHECK (request_radius_km IN (10,20,30,40));
