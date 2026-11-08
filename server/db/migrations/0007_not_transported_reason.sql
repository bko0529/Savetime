-- S6 구급활동일지 미이송 사유 (SFR-164, SFR-076): 대원이 이송을 취소할 때 고른 사유
-- Up Migration
ALTER TABLE transport
  ADD COLUMN not_transported_reason varchar(16)
    CHECK (not_transported_reason IN ('refused','death','on_scene','other_agency','etc')),
  ADD COLUMN not_transported_text varchar(30);

-- Down Migration
ALTER TABLE transport DROP COLUMN not_transported_text, DROP COLUMN not_transported_reason;
