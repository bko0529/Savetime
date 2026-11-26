// 병원 웹의 요청 목록·도착 예정이 같이 쓰는 표 모양
export const table = {
  root: 'w-full border-collapse text-[18px]',
  headRow: 'border-y border-line-soft bg-surface text-left text-[15px] text-muted-foreground',
  th: 'px-3 py-3 font-bold whitespace-nowrap first:pl-6 last:pr-6',
  row: 'border-b border-line-soft transition-colors last:border-b-0 hover:bg-surface/65',
  td: 'px-3 py-4 first:pl-6 last:pr-6',
  empty: 'border-t border-line-soft px-6 py-8 text-[18px] text-muted-foreground',
};
