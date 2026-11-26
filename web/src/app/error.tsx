'use client';

import { StatusScreen } from '@/components/brand/StatusScreen';
import { Button } from '@/components/ui/button';

// 화면을 그리다 예상하지 못한 오류가 나면 Next 기본 오류 화면 대신 이 안내를 보여 준다.
// 오류 내용(error.message)은 화면에 내보내지 않는다 (서버 내부 정보·환자 정보가 섞일 수 있어서)
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <StatusScreen
      eyebrow="Error"
      tone="danger"
      title="화면을 보여 주지 못했어요"
      action={
        <Button size="lg" className="h-14 rounded-xl px-8 text-xl" onClick={reset}>
          다시 시도
        </Button>
      }
    >
      잠시 후 다시 시도해 주세요. 계속되면 새로고침해 주세요.
    </StatusScreen>
  );
}
