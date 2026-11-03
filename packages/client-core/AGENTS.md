# packages/client-core and packages/client-react

Platform-agnostic client state shared by web, Electron main and Android.

- `reduce` is pure and is the only way state changes. Every event type in
  `CindlEvent` is handled; add a test for each new rule.
- No globals: storage, sockets, clocks, crypto and browsers come in through
  the interfaces in `src/platform.ts`.
- SHA-256 versions use `sha256Hex` so every platform computes the same value
  (Android's JS engine has no WebCrypto).
- `client-react` hooks must return stable snapshots (`useSyncExternalStore`);
  derive arrays through the stable-array helper, not inline `.filter()`.
