# apps/web

The responsive web client and the Electron renderer. Read `DESIGN.md` first.

- Run it: `pnpm --filter @cindl/web dev:demo` (synthetic demo on
  127.0.0.1:5173) or `pnpm --filter @cindl/web build`.
- Talk only to `CindlClientApi` via `@cindl/client-react`; never import the
  adapter or fixtures directly (except `src/platform/client.ts`).
- Routes are hash routes in `src/router.ts`; shortcuts only in
  `src/shortcuts.ts`.
- Styles: CSS modules with semantic tokens; no raw colours; literal breakpoints
  768/1280; 44px targets on coarse pointers.
- Agent content renders only through `src/talk/Markdown.tsx`.
- Use `useResource` for reads so state only changes in async callbacks and
  stale responses are ignored.
- The production build adds a strict CSP (`vite.config.ts`); keep assets local.
- UI changes need browser QA at phone (390x844, 360x800), tablet (768x1024) and
  desktop (1280x800, 1440x1000) sizes with the synthetic demo, both themes:
  `pnpm --filter @cindl/web test:e2e` runs the flow tests against the
  production demo build (add `CINDL_E2E_CHANNEL=chrome` to use an installed
  Chrome instead of Playwright's bundled Chromium); `CINDL_CAPTURE=1` also
  writes the screenshot matrix to `.agent-artifacts/web-qa/capture/`. Review
  every image before publishing it.
- Component tests (`test/*.test.tsx`, jsdom) cover security-relevant rendering.
- jsdom never moves focus off a disabled control; browsers do, one frame
  later. Focus behaviour goes in `e2e/focus.spec.ts`, which runs the real
  views on the test-only harness `e2e/harness/focus.html` (its own dev server,
  never built; `CINDL_E2E_HARNESS_PORT`, default the e2e port plus one).
