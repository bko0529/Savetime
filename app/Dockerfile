# 구급대원 앱 + 병원 웹 + 관리자 웹 이미지 (한 프로젝트, T-11)
# Lovable 은 Cloudflare 용으로 빌드하지만, 우리 서버에서는 Node 서버로 빌드한다 (NITRO_PRESET=node-server)
# 빌드: docker build app   (app/ 폴더가 빌드 위치)

FROM node:24-slim AS build
WORKDIR /app
COPY package.json ./
# 앱은 bun.lock 만 있어 npm 은 잠금 파일 없이 설치한다 (CI 와 같은 방식)
RUN npm install --no-audit --no-fund
COPY . .
# 카카오 지도 JS 키는 브라우저에 들어가는 공개 키라 빌드 때 넣는다 (카카오 콘솔에서 도메인으로 막음)
ARG VITE_KAKAO_JS_KEY=""
# 비우면 같은 도메인의 /api·/socket.io 로 부른다 (Caddy 가 서버로 넘김)
ARG VITE_API_BASE_URL=""
ENV VITE_KAKAO_JS_KEY=$VITE_KAKAO_JS_KEY VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN NITRO_PRESET=node-server npx vite build

# 실행 단계: 빌드 결과(.output)만 가져온다. 의존성이 모두 묶여 있어 node_modules 가 필요 없다
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/.output .output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
