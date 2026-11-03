# 병원 웹 + 관리자 웹 (Next.js, 한 프로젝트) — 담당: 승언

Next.js 16 (App Router) · Tailwind CSS 4 · shadcn/ui · Vitest

실시간 이벤트 타입은 `../shared/events.ts`, API는 `../docs/design-v0.2/openapi.yaml`을 보세요.

## 실행

```bash
# 저장소 맨 위에서 한 번
npm install

# 병원 화면 (http://localhost:3000 → /hospital)
npm run dev -w web

# 관리자 화면 (→ /admin). PowerShell은 $env:APP_ROLE='admin'; npm run dev -w web
APP_ROLE=admin npm run dev -w web

npm test -w web
```

## 화면 나누기 (`APP_ROLE`)

| `APP_ROLE` | 열리는 경로 | 막히는 경로 (404) |
|---|---|---|
| `admin` | `/admin` | `/hospital` |
| 그 밖의 값·비움 | `/hospital` | `/admin` |

판단은 `src/lib/appRole.ts`, 적용은 `src/proxy.ts`(Next.js 16에서 `middleware`가 `proxy`로 이름이 바뀜)에서 해요.
실행할 때 값을 읽으므로 Docker 이미지 하나로 두 서버를 띄워요 (T-11).
