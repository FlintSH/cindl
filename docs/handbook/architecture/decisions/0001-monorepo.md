# 0001 One TypeScript pnpm monorepo

**Status:** Accepted

**Context.** Three clients must share one contract, one Hermes adapter, one
state model and one design system, and change together.

**Decision.** A single repository using pnpm workspaces and TypeScript. Shared
versions are pinned in the pnpm `catalog` so web and Android use the same React,
TypeScript and Zod. Packages are consumed as TypeScript source with erasable
syntax and explicit `.ts` imports, so Node 24, Vite, Metro and esbuild run them
without a build step. pnpm's install-script allowlist and minimum release age
stay enabled.

**Consequences.** One lockfile for runtime code; root files have one owner
(see `AGENTS.md`). The handbook site will have its own lockfile so docs tooling
never ships in a runtime package.
