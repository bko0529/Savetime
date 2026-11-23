# Imported SaveTime web frontend

- Preserve the original REST request paths and payloads, same-origin PC cookies, in-memory admin tokens, OTP flow and Socket.IO events; this import is presentation work, not a backend migration.
- Use the navigation adapter only for the source framework's links and redirects; public /hospital and /admin paths stay intact while TanStack owns routing.
- Keep imported source tests as JSX with TypeScript annotations removed so original assertions run without weakening the host project's strict compiler settings.
- Use shared global semantic tokens and the source Base UI controls; styling must not change source business rules or supply fake production rows.
- Vite development forwards /api/v1 and /socket.io to API_ORIGIN (source default localhost:4000); a published deployment still needs a same-site source API proxy to preserve Strict cookies.