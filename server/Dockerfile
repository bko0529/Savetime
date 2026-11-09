# 서버 이미지 (T-11): 같은 이미지를 APP_ROLE=main(대원·병원) / admin(관리자)으로 띄운다.
# 빌드는 저장소 맨 위에서: docker build -f server/Dockerfile .  (npm workspaces 라 package-lock.json 이 맨 위에 있다)

# ---- 1단계: TypeScript 빌드 ----
FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
# 맨 위 prepare(husky, 커밋 검사 도구)는 이미지에서 필요 없고, 개발 도구를 빼면 명령이 없어 설치가 멈춘다
RUN npm pkg delete scripts.prepare
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w server
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build -w server

# ---- 2단계: 실행용 (개발 도구 없이) ----
FROM node:24-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# 맨 위 prepare(husky, 커밋 검사 도구)는 이미지에서 필요 없고, 개발 도구를 빼면 명령이 없어 설치가 멈춘다
RUN npm pkg delete scripts.prepare
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w server --omit=dev && npm cache clean --force
COPY --from=build /repo/server/dist server/dist
# 마이그레이션 파일 (docker compose run --rm server npm run migrate)
COPY server/db server/db
WORKDIR /repo/server
# root 로 돌리지 않는다
USER node
EXPOSE 4000
# SIGTERM 을 node 가 직접 받아야 처리 중인 요청을 끝내고 내려간다 (index.ts shutdown)
CMD ["node", "dist/index.js"]
