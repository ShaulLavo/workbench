# Workbench repository guidelines

## Mission and license

`ShaulLavo/workbench` is a 100% MIT React 19 workbench UI library (`@shaulavo/workbench`) shared across Sprockt, Fregat, and browser IDEs.

- Zero Apache-2.0 or CC-BY-4.0 code or artwork may enter this repository.
- Run `bun run license:check` and `bun run verify:pack` before shipping any package change.
- All hand-written source files are strict TypeScript (`.ts`/`.tsx`). `bun run lint` rejects hand-written `.js`/`.mjs`/`.cjs` files.

## Package architecture

- `@shaulavo/workbench` is a single MIT package with clean subpaths:
  - Headless React-free, CSS-free entries: `./core`, `./tokens`, `./icons/core` (DOM-free), `./tree/model` (DOM-free).
  - Browser React entries with auto-imported CSS: `.`, `./icons`, `./tree`, `./terminal`, `./preview`, `./editor`, `./editor/groups`, `./editor/lsp`, `./editor/composer`, `./editor/diff`.
  - Opt-in CSS exports: `./layers.css`, `./reset.css`, `./tailwind.css`, `./themes/fregat.css`, `./themes/sprockt.css`.
- Stylesheets declare `@layer theme, base, components, workbench, utilities, workbench-app;`.
- Shared stateful runtimes (`react`, `react-dom`, `react/jsx-runtime`, `react/compiler-runtime`, `@shaulavo/hotkeys`, `@base-ui/react`, `@singapore-editor/*`, `@dnd-kit/*`, `ghostty-webgpu`) are strictly externalized.

## Code style

- Max nesting depth 3 (guard clauses, early returns, extracted helpers).
- Combine arrays with `.concat(...)`, map iterables with `Array.from(iter, fn)`, use `.toSorted()`/`.toReversed()` on borrowed arrays, widen read-only params to `readonly`.
- Components must be React Compiler clean (`bun run compiler:census`) and `<StrictMode>` idempotent while working identically without `<StrictMode>`.

## Verification

- Drive `apps/harness` through `.agents/skills/verify-workbench/SKILL.md` (`bun run verify:browser look --doctor`, `bun run test:browser`).
- Run `bun run verify` (`verify:pack`, `gates:no-build`, `test:unit:no-build`, `bench:tree:gate`, `test:browser:run`) before opening a PR.
