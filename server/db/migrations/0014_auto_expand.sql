-- S8 자동 반경 넓히기 (D-142, SFR-131): 승인 0곳으로 요청이 모두 닫히면 서버가 다음 반경의 새 병원에만 다시 요청한다.
-- 대원이 '병원에 요청' 때 끌 수 있다 (기본 켬). 더 넓힐 반경·새 병원이 없으면 서버가 false 로 바꿔 다시 보지 않는다
-- Up Migration
ALTER TABLE transport ADD COLUMN auto_expand boolean NOT NULL DEFAULT true;

-- Down Migration
ALTER TABLE transport DROP COLUMN auto_expand;
