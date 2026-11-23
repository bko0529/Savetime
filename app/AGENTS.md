<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project rules
- Ambulance-crew app is a mobile-first web prototype of SaveTime (github.com/bko0529/Savetime). src/lib/domain/stateMachine.ts is a verbatim copy of the repo's server/src/domain/stateMachine.ts — never edit it locally; re-copy from the repo so rules stay identical.
- src/lib/engine.ts holds the transport state that comes from the SaveTime server (no fake server any more): actions call the REST API, Socket.IO team events (IDs only) trigger GET /transports/{id}, timers use serverNow(). The server decides every status change with its stateMachine.ts. Hospitals come from the server (recommendations / hospital detail), not from a local list. Screens keep using useEngine/actions/hospital(id).
- Location: src/lib/location.ts. VITE_FIXED_LAT/VITE_FIXED_LNG pin the paramedic location (demo videos: 36.815, 127.1139) and make the navigation device simulate driving to the ER entrance, sending a point every 5 s and the remaining minutes every minute. Without them the device GPS is used.
- Login, signup, team (duty) and invites come from the SaveTime server: src/lib/auth-server.ts calls the API (src/lib/api.ts, base URL from VITE_API_BASE_URL, default http://localhost:4000) and Socket.IO /app (src/lib/realtime.ts), then writes into src/lib/auth-store.ts (only consent, permissions, tokens and the server copy of my account/team are stored on the device). On the server, leaving a team = ending duty = logout. Pure rule/mapping functions are tested in src/test/auth-rules.test.ts; AppGate.gateTarget enforces min version → consent → permissions → login → approval → duty, so screens never decide navigation order themselves.
- Duty end, logout and withdrawal all go through src/lib/duty.ts leave() so the last team member's active transport is cancelled with the matching reason.
- Transport state lives in a React context (src/lib/transport-store.tsx) shared across routes; patient name/ID/phone are never collected (repo privacy rule).
