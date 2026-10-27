# 세이브타임 — Claude Code 규칙

## 프로젝트
119 구급대원이 응급실에 이송을 동시 요청하고 병원이 웹에서 승인·거절하는 시스템 (졸업 프로젝트, 8주).
- server/ : Node.js 24 · Express 5 · Socket.IO 4 · PostgreSQL 16 · Redis 7 · BullMQ (담당 백강욱)
- app/ : React Native(Expo) 구급대원 앱 (담당 최진아)
- web/ : Next.js 16 병원·관리자 웹 (담당 윤승언)
- shared/ : 공통 타입

## 먼저 읽을 문서 (작업 전에 관련 부분 확인)
- docs/개발준비.md : 작업 규칙, 스프린트별 할 일
- docs/기술정의서.md : 쓰는 라이브러리·버전 (여기 없는 라이브러리는 추가하기 전에 나에게 먼저 물어볼 것)
- docs/design-v0.2/ : 상태 전이표, DB 설명, 실시간 설계, API 명세(openapi.yaml)
- docs/요구사항분석서.xlsx : 요구사항 원장 (SFR·SER·DAR 등 ID)

## 절대 규칙
1. API 키·비밀번호는 server/.env 에만. .env 를 읽거나 출력하거나 커밋하지 말 것. 새 키는 .env.example 에 이름만 추가
2. 환자 이름·주민번호·전화번호·주소를 서버 DB·로그·이벤트에 저장하지 말 것 (SER-012)
3. 병원 웹에 요청한 구급대 소속을 보여주지 말 것
4. 이송 건·병원 요청의 상태 변경은 반드시 server/src/domain/stateMachine.ts 를 거칠 것
5. 실시간 이벤트(Socket.IO·FCM)에는 ID·개수·시각만 넣을 것
6. 시간 판정(2분·5분·5초)은 DB now() 기준
7. 서버 메모리에 상태를 두지 말 것 (서버 2대 대비: Redis 또는 DB)
8. DB 접근은 pg 로 직접 SQL (ORM 금지). 상태 변경은 트랜잭션 + SELECT ... FOR UPDATE + version 비교

## 작업 방식
- 한 번에 요구사항 1~2개만. 시작 전에 계획을 먼저 보여주고 내 확인을 받을 것
- main 에 직접 커밋 금지. 브랜치 이름: 파트/스프린트-요구사항-설명 (예: server/S1-SFR023-collector)
- 커밋 메시지: [파트] 무엇을 했는지 (요구사항 ID)
- 코드를 바꾸면 테스트도 추가하고 npm test 통과 확인
- API·DB를 바꾸면 openapi.yaml·schema.sql 도 같이 바꾸고 python tools/crosscheck.py 실행
- 나는 백엔드를 배우는 중이야. 중요한 코드는 왜 그렇게 짰는지 쉬운 한국어로 짧게 설명해줘

## 명령어
- DB·Redis: docker compose up -d
- 서버 테스트: cd server && npm test
- 설계 대조: python tools/crosscheck.py
