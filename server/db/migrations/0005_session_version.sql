-- S2 로그인 (SFR-018, SER-016): 계정 세션 번호. 정지·로그아웃 때 1 올리면 그 전에 받은 접근 토큰이 모두 무효가 된다
-- Up Migration
ALTER TABLE paramedic ADD COLUMN session_version int NOT NULL DEFAULT 1;

-- Down Migration
ALTER TABLE paramedic DROP COLUMN session_version;
