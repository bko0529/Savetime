// 병원 웹의 확인·사유·메모 창이 같이 쓰는 모양. 낮은 화면에서도 아래 버튼까지 내려갈 수 있다
export const dialog = {
  content:
    'max-h-[calc(100dvh-32px)] gap-5 overflow-y-auto rounded-[18px] px-[28px] pt-[24px] pb-[28px] shadow-[0_24px_60px_oklch(0.13_0_0/30%)] sm:max-w-[620px]',
  overlay: 'bg-foreground/40',
  title: 'text-[24px] leading-tight font-extrabold tracking-[-0.02em]',
  description: 'text-[17px]',
  footer: '-mx-[28px] -mb-[28px] rounded-b-[18px] border-line bg-surface px-[28px] py-4',
  button: 'h-[56px] rounded-[10px] text-xl',
  input: 'h-[56px] rounded-[10px] border-2 border-input px-3 text-xl',
};
