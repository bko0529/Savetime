// 병원 웹의 확인·사유·메모 창이 같이 쓰는 모양 (대원 앱 Lovable 시안: 둥근 흰 카드 + 진한 그림자, 아래 버튼 줄은 회색).
// 낮은 화면에서도 아래 버튼까지 내려갈 수 있다
export const dialog = {
  content:
    'max-h-[calc(100dvh-32px)] gap-5 overflow-y-auto rounded-2xl px-[28px] pt-[24px] pb-[28px] sm:max-w-[620px]',
  overlay: 'bg-foreground/30 backdrop-blur-[2px]',
  title: 'text-[24px] leading-tight font-extrabold tracking-[-0.02em]',
  description: 'text-[17px] leading-relaxed',
  footer: '-mx-[28px] -mb-[28px] rounded-b-2xl border-line-soft bg-surface px-[28px] py-4',
  button: 'h-[56px] rounded-xl text-xl',
  input: 'field h-[56px] rounded-xl text-xl',
};
