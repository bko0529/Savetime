import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const TONE = {
  success: 'bg-success-soft text-success-strong',
  info: 'bg-info-soft text-info-strong',
  warning: 'bg-warning-soft text-warning-strong',
  danger: 'bg-danger-soft text-danger-strong',
  neutral: 'bg-neutral-soft text-muted-foreground',
};

export type Tone = keyof typeof TONE;

// 병원 웹의 상태 알약. 색만으로 구분하지 않게 안에는 항상 글자가 있다
export function Chip({ tone, className, ...props }: ComponentProps<'span'> & { tone: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[15px] font-bold whitespace-nowrap',
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}
