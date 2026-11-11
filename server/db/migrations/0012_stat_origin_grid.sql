-- S7 현장 주소 익명화 (SER-012, SER-002): 이송이 끝나면 현장 주소(transport.address)도 출발 좌표처럼 지운다.
-- 대신 익명 소요시간 통계(transport_stat, 이송 건·계정 연결 없음)에 출발 위치를 소수 셋째 자리(약 100m 격자)로 뭉개서 남긴다.
-- '이 동네 → 이 병원, 몇 분' 데이터를 나중에 구급차 내비 연구에 쓰려는 것. 특정 집·특정 출동과는 이어지지 않는다
-- Up Migration
ALTER TABLE transport_stat
  ADD COLUMN origin_grid_lat numeric(6,3),
  ADD COLUMN origin_grid_lng numeric(6,3);

-- Down Migration
ALTER TABLE transport_stat DROP COLUMN origin_grid_lng, DROP COLUMN origin_grid_lat;
