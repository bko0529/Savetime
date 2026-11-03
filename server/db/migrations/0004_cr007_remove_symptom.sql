-- v1.5 (CR-007): 증상 버튼·증상 선택지 삭제 (D-130), 음성 입력 삭제 (D-133)
-- 통계는 증상 코드 대신 대원이 고른 병원 등급으로 본다 (SFR-126)
-- Up Migration
ALTER TABLE assessment DROP COLUMN symptom_code;
ALTER TABLE rejection_record DROP COLUMN symptom_code;
ALTER TABLE response_stat DROP COLUMN symptom_code;
ALTER TABLE response_stat ADD COLUMN requested_grade smallint CHECK (requested_grade IN (1,2,3));
DROP TABLE symptom_capability;
DROP TABLE symptom;
DELETE FROM feature_flag WHERE key = 'voice_input';

-- Down Migration
INSERT INTO feature_flag (key, enabled) VALUES ('voice_input', true) ON CONFLICT (key) DO NOTHING;
CREATE TABLE symptom (
  code          char(3)     PRIMARY KEY,
  name          varchar(60) NOT NULL,
  required_beds varchar(3)[] NOT NULL CHECK (required_beds <@ ARRAY['er','icu','or']::varchar[])
);
CREATE TABLE symptom_capability (
  symptom_code char(3)     NOT NULL REFERENCES symptom(code),
  item_code    varchar(20) NOT NULL REFERENCES capability_item(code),
  PRIMARY KEY (symptom_code, item_code)
);
ALTER TABLE response_stat DROP COLUMN requested_grade;
ALTER TABLE response_stat ADD COLUMN symptom_code char(3);
ALTER TABLE rejection_record ADD COLUMN symptom_code char(3);
ALTER TABLE assessment ADD COLUMN symptom_code char(3) REFERENCES symptom(code);
