# docs/handbook

The canonical handbook and its VitePress site. Read
`docs/handbook/development/docs.md` first.

- Separate pnpm project with its own lockfile, outside the runtime workspace:
  `pnpm --dir docs/handbook install --frozen-lockfile`, then `build`, `dev` or
  `preview`. Never add handbook tooling to a runtime package.
- Every page is in the sidebar (`.vitepress/sidebar.mjs`); labels come from the
  page's first heading. New pages in a section's folders join that section
  automatically; the build fails on missing pages and on pages in folders no
  section covers.
- Tables between `BEGIN GENERATED` and `END GENERATED` are generated: change
  the source, then run `node scripts/generate-docs-reference.mjs`.
- Link pages with relative `.md` links; link repository files with their GitHub
  URL on `main`. Both are checked.
- Anchors use the site's heading ids, not GitHub's: keep apostrophes out of linked headings.
- Provenance comes from Git at build time (`.vitepress/build-info.mjs`). Never
  hardcode a version, branch or date.
- The theme uses only `packages/tokens` variables and fonts, and for text and
  interface colours only pairings the token contrast tests cover (code
  highlighting uses Shiki's themes). Nothing loads from another origin.
- No deployment or hosting: CI uploads the built site as an artifact.
- Synthetic examples only; placeholder text outside code fails the coverage
  gate.
