// SaveTime 표시: 둥근 시계 테두리 + 빨간 십자 (시안 2026-11-24)
export function Logo() {
  return (
    <svg aria-hidden viewBox="0 0 36 36" className="size-9 shrink-0">
      <circle cx="18" cy="19" r="13" fill="none" stroke="currentColor" strokeWidth="3" />
      <rect x="15" y="2" width="6" height="5" rx="1.5" fill="currentColor" />
      <rect x="15.5" y="11" width="5" height="16" rx="1.5" fill="var(--destructive)" />
      <rect x="10" y="16.5" width="16" height="5" rx="1.5" fill="var(--destructive)" />
    </svg>
  );
}
