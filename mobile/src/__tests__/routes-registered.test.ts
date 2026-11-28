/**
 * 화면 파일(app/*.tsx)이 모두 _layout.tsx 의 화면 순서(Stack.Protected)에 들어 있는지.
 * 빠지면 화면 순서 규칙 밖에서 열려 버린다 (6·7단계 화면이 한때 빠졌던 일을 다시 막으려고).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const appDir = path.join(__dirname, '../../app');
const routes = (dir: string, prefix = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.isDirectory()) return routes(path.join(dir, d.name), `${prefix}${d.name}/`);
    if (!d.name.endsWith('.tsx') || d.name.startsWith('_')) return [];
    return [`${prefix}${d.name.replace(/\.tsx$/, '')}`];
  });

test('모든 화면 파일이 화면 순서에 등록돼 있다', () => {
  const layout = fs.readFileSync(path.join(appDir, '_layout.tsx'), 'utf8');
  const registered = [...layout.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]);
  expect(routes(appDir).sort()).toEqual([...registered].sort());
});
