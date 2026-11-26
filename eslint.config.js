import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/.expo/**',
      // 디자인 시안(참고 자료)의 자동 생성 실행 파일. 실제 화면은 web/ 의 .tsx 로 구현한다
      'docs/design-handoff-web-ui/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // React Native(Metro)는 글꼴·그림 파일을 require() 로 불러온다 (표준 방식)
    files: ['mobile/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // mobile 의 설정 파일(jest.config.js 등)은 Node CommonJS
    files: ['mobile/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly' },
    },
  },
  prettier,
);
