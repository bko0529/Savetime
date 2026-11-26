# 구급대원 앱 (React Native · Expo SDK 58) — 담당: 백강욱

`docs/기술정의서.md` 4장 기준. 서버 API는 `../docs/design-v0.2/openapi.yaml`, 실시간 이벤트 타입은 `../shared/events.ts`.

## 실행

```bash
npm install            # 저장소 맨 위에서 (npm workspaces)
cd mobile
npm start              # Expo 개발 서버. i = iOS 시뮬레이터, a = Android 에뮬레이터
```

서버 주소는 `EXPO_PUBLIC_API_BASE_URL`(비밀 값 아님). 없으면 `http://localhost:4000`.
진짜 휴대폰에서는 localhost 가 휴대폰 자신이라, 노트북 IP 를 넣어 실행해요.

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.0.10:4000 npm start
```

## 명령어

| 명령 | 하는 일 |
|---|---|
| `npm test` | Jest + React Native Testing Library |
| `npm run typecheck` | TypeScript 검사 |
| `npm run gen:api` | `openapi.yaml` → `src/api/schema.d.ts` 타입 다시 만들기 (API 가 바뀌면) |
| `npx expo install <패키지>` | 라이브러리 추가는 꼭 이걸로 (SDK 와 맞는 버전). 기술정의서에 없는 건 먼저 물어보기 |

## 폴더

- `app/` : 화면 (Expo Router — 파일 이름 = 화면 주소). `_layout.tsx` 가 로그인 여부로 화면을 고른다
- `src/api/` : 서버 연결(`client.ts`: 토큰 갱신 · 서버 시각 · 오류 형식), 자동 생성 타입
- `src/auth/` : 로그인 상태, secure-store 보관, 입력 검사
- `src/ui/` : 색 · 간격

## 지킬 것

- 환자 이름·주민번호·전화번호·주소는 서버로 보내지 않는다 (SER-012). 일지 PDF 는 단말에서 만든다
- 2분·5분 같은 시간 계산은 `serverNow()` (서버 시각) 로
- refresh 토큰은 secure-store 에만. AsyncStorage 등 일반 저장소에 두지 않는다
