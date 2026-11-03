import type { ReactNode } from 'react';
import { AdminAuthProvider } from './AdminAuth';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminAuthProvider>{children}</AdminAuthProvider>;
}
