import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '세이브타임',
  description: '응급실 이송 요청 승인·관리',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
