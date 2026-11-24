import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  // 개발 모드 왼쪽 아래 'N' 표시를 숨긴다 (시연 영상에 찍히지 않게)
  devIndicators: false,
  // 개발 중에는 /api/* 를 서버(기본 4000)로 넘긴다. 운영에서는 Caddy 가 같은 도메인에서 나눠 준다 (T-03).
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const origin = process.env.API_ORIGIN ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${origin}/api/:path*` }];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
