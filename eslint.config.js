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
      // 디자인 시안(참고 자료)의 자동 생성 실행 파일. 실제 화면은 web/ 의 .tsx 로 구현한다
      'docs/design-handoff-web-ui/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
