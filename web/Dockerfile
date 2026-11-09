# 병원·관리자 웹 이미지 (COR-008, T-11): 같은 이미지를 APP_ROLE=hospital / admin 으로 띄운다.
# APP_ROLE 은 빌드 때가 아니라 실행 때 읽어서(web/src/proxy.ts) 이미지 하나로 두 서버에 쓴다.
# 빌드는 저장소 맨 위에서: docker build -f web/Dockerfile .

FROM node:24-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# 맨 위 prepare(husky, 커밋 검사 도구)는 이미지에서 필요 없고, 개발 도구를 빼면 명령이 없어 설치가 멈춘다
RUN npm pkg delete scripts.prepare
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci -w web
# web 은 실시간 이벤트 타입을 shared/ 에서 가져온다
COPY shared shared
COPY web web
RUN npm run build -w web

# 실행 단계: next.config.ts 를 읽으려면 TypeScript 가 필요해서, 빌드 단계의 node_modules 를 그대로 쓴다
FROM node:24-slim
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/shared shared
COPY --from=build /repo/web web
WORKDIR /repo/web
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
