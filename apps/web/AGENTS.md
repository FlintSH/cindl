# apps/web

The responsive web client and the Electron renderer. Read `DESIGN.md` first.

- Run it: `pnpm --filter @cindl/web dev:demo` (synthetic demo on
  127.0.0.1:5173) or `pnpm --filter @cindl/web build`.
- Talk only to `CindlClientApi` via `@cindl/client-react`; never import the
  adapter or fixtures directly (except `src/platform/client.ts`).
- Routes are hash routes in `src/router.ts`; shortcuts only in
  `src/shortcuts.ts`.
- Styles: CSS modules with semantic tokens; no raw colours; literal breakpoints
  768/1024/1280; 44px targets on coarse pointers.
- Agent content renders only through `src/talk/Markdown.tsx`.
- Use `useResource` for reads so state only changes in async callbacks and
  stale responses are ignored.
- The production build adds a strict CSP (`vite.config.ts`); keep assets local.
- UI changes need browser QA at phone (390x844, 360x800), tablet (768x1024) and
  desktop (1280x800, 1440x1000) sizes with the synthetic demo, both themes.
