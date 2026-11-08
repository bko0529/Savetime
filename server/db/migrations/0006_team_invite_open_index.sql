-- S5 팀원 목록 초대 (SFR-159): 아직 답이 없는 초대를 팀·받는 사람으로 바로 찾는다 (같은 초대 두 번 막기·목록의 '초대함' 표시)
-- Up Migration
CREATE INDEX team_invite_open ON team_invite (team_id, to_id) WHERE status = 'sent';

-- Down Migration
DROP INDEX team_invite_open;
