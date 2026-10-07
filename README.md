# 세이브타임 (SaveTime)

119 구급대원이 환자를 받을 응급실을 **실시간으로 요청·확정**하고, 병원은 웹에서 바로 승인·거절하는 시스템 (졸업 프로젝트)

| 파트 | 기술 | 담당 | 폴더 |
|---|---|---|---|
| 서버 · PM | Node.js / Express · PostgreSQL · Socket.IO | 백강욱 | `server/` |
| 구급대원 앱 | React Native (Android + iOS) | 진아 | `app/` |
| 병원 웹 + 관리자 웹 | Next.js | 승언 | `web/` |
| 공통 타입 | TypeScript | 모두 | `shared/` |

## 폴더 구조
```
savetime/
├─ docs/design-v0.2/        설계 문서 (먼저 읽기)
│   ├─ 1_상태전이표.md        이송 건 6개 상태 · 병원 요청 9개 상태
│   ├─ 2_DB설계_설명.md       테이블 36개 설명
│   ├─ 3_실시간통신설계.md     Socket.IO 이벤트 · 타이머
│   ├─ 4_API명세.md          API 83개 요약 · 오류 코드
│   └─ openapi.yaml          API 전체 명세 (editor.swagger.io 에 붙여 넣으면 보기 좋음)
├─ server/
│   ├─ src/domain/stateMachine.ts       상태 전이 (서버에 그대로 사용)
│   ├─ src/domain/stateMachine.test.ts  테스트 31개
│   ├─ db/schema.sql                    DB 생성 SQL (PostgreSQL 16)
│   └─ .env.example                     환경 변수 예시
├─ shared/events.ts         서버·앱·웹이 같이 쓰는 실시간 이벤트 타입
├─ app/                     구급대원 앱 (예정)
├─ web/                     병원·관리자 웹 (예정)
└─ tools/crosscheck.py      설계 문서끼리 안 맞는 곳 자동 점검
```

## 처음 받는 법
```bash
git clone https://github.com/bko0529/savetime.git
cd savetime
```

## 테스트 돌려 보기 (서버)
```bash
cd server
npm install
npm test          # 상태 전이 테스트 31개
```

## 설계 점검
```bash
pip install pyyaml
python tools/crosscheck.py   # 상태·DB·실시간·API 34개 항목 대조
```

## 꼭 지킬 규칙
1. **API 키·비밀번호는 `.env`에만** 넣어요. `.env`는 커밋 금지 (`.gitignore`에 들어 있음). 새 키가 생기면 `.env.example`에 이름만 추가해요.
2. **환자 이름·주민번호·전화번호는 어디에도 저장하지 않아요.** 실시간 이벤트에도 환자 정보는 넣지 않아요.
3. **병원 웹에는 요청한 구급대 소속을 보여주지 않아요.**
4. 상태를 바꾸는 코드는 반드시 `stateMachine.ts`의 함수를 거쳐요. 표에 없는 전이는 전부 거부돼요.
5. `main`에 바로 올리지 말고 브랜치를 만들어 PR로 합쳐요 (브랜치 규칙은 2-3 단계에서 정해요).
