import { Link as RouterLink, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

const paths = ["/hospital", "/hospital/register", "/hospital/design-preview", "/admin", "/admin/login", "/admin/accounts", "/admin/monitoring", "/admin/hospitals"] as const;
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(() => ({ replace(path: string) {
    const target = paths.find(p => p === path);
    if (target) void navigate({ to: target, replace: true });
  } }), [navigate]);
}
export function usePathname() { return useRouterState({ select: s => s.location.pathname }); }
export function Link({ href, children, className, ...props }: { href: string; children?: ReactNode; className?: string; 'aria-current'?: 'page' | undefined }) {
  const [pathname, hash] = href.split("#");
  const to = paths.find(p => p === pathname);
  if (!to) return null;
  return <RouterLink to={to} {...(hash ? { hash } : {})} {...(className ? { className } : {})} {...props}>{children}</RouterLink>;
}