// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    // 개발 서버가 켜질 때 모든 화면(앱·병원·관리자)의 부품을 미리 준비한다.
    // 안 그러면 처음 여는 화면에서 부품을 새로 준비하며 페이지를 다시 불러와, 메모리에만 있는 관리자 로그인이 풀린다
    optimizeDeps: { entries: ["src/routes/**/*.tsx"] },
    server: {
      proxy: {
        "/api/v1": { target: process.env['API_ORIGIN'] || "http://localhost:4000", changeOrigin: true },
        "/socket.io": { target: process.env['API_ORIGIN'] || "http://localhost:4000", ws: true, changeOrigin: true },
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
