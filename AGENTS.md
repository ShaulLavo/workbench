# Workbench repository guidelines

## Mission and license

`ShaulLavo/workbench` is a 100% MIT React 19 workbench UI library (`@shaulavo/workbench-*`) shared across Sprockt, Fregat, and browser IDEs.

- Zero Apache-2.0 or CC-BY-4.0 code or artwork may enter this repository.
- Run `bun run license:check` and `bun run pack:check` before shipping any package change.
- All hand-written source files are strict TypeScript (`.ts`/`.tsx`). `bun run lint` rejects hand-written `.js`/`.mjs`/`.cjs` files.

## Package architecture

- `@shaulavo/workbench-tokens`: pure CSS `--wb-*` design tokens in explicit `@layer theme, base, components, utilities, workbench, workbench-app;`, theme presets (`fregat.css`, `sprockt.css`), `reset.css`, `tailwind-bridge.css`, and scoped theme observers. Zero runtime dependencies.
- `@shaulavo/workbench-core`: backend-agnostic adapter interfaces (`fs`, `editor`, `lsp`, `terminal`, `preview`, `layout`, `hotkeys`), `Subscribable<T>`, pure layout math, per-activation `FocusPolicy`, `visualViewport` keyboard-inset controller, and long-press synthesizer. Root entry has zero React imports; React hooks live in `./react`. Zero Singapore or Ghostty imports anywhere in core.
- Every package externalizes `react`, `react-dom`, `react/jsx-runtime`, `react/compiler-runtime`, and shared stateful peer dependencies (`@shaulavo/hotkeys`, `@base-ui/react`, `@singapore-editor/*`, `ghostty-webgpu`).

## Code style

- Max nesting depth 3 (guard clauses, early returns, extracted helpers).
- Combine arrays with `.concat(...)`, map iterables with `Array.from(iter, fn)`, use `.toSorted()`/`.toReversed()` on borrowed arrays, widen read-only params to `readonly`.
- Components must be React Compiler clean (`bun run compiler:census`) and `<StrictMode>` idempotent while working identically without `<StrictMode>`.

## Verification

- Drive `apps/harness` through `.agents/skills/verify-workbench/SKILL.md` (`bun run verify:browser look --doctor`, `bun run test:browser`).
- Run `bun run verify` (`build`, `gates`, `test:unit`, `pack:check`, `test:browser`) before opening a PR.
