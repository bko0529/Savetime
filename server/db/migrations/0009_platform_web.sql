-- S7 구급대원 앱 웹앱 전환 (CR-010): 브라우저 웹 푸시 토큰도 push_device 에 받는다
-- Up Migration
ALTER TYPE platform_kind ADD VALUE IF NOT EXISTS 'web';

-- Down Migration
-- enum 값은 바로 뺄 수 없어서, 웹 토큰을 지우고 타입을 다시 만든다
DELETE FROM push_device WHERE platform = 'web';
ALTER TYPE platform_kind RENAME TO platform_kind_old;
CREATE TYPE platform_kind AS ENUM ('android','ios');
ALTER TABLE push_device ALTER COLUMN platform TYPE platform_kind USING platform::text::platform_kind;
DROP TYPE platform_kind_old;
