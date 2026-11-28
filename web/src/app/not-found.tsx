import Link from 'next/link';
import { StatusScreen } from '@/components/brand/StatusScreen';

// 없는 주소 (404). '처음 화면으로'는 / 로 보내고, 병원 서버면 병원 웹·관리자 서버면 관리자 웹으로 다시 나뉜다 (proxy.ts)
export default function NotFound() {
  return (
    <StatusScreen
      eyebrow="404"
      title="페이지를 찾을 수 없어요"
      action={
        <Link
          href="/"
          className="btn-solid-primary inline-flex h-14 items-center rounded-xl px-8 text-xl font-bold text-primary-foreground"
        >
          처음 화면으로
        </Link>
      }
    >
      주소가 바뀌었거나 이 서버에서는 열 수 없는 화면이에요.
    </StatusScreen>
  );
}
