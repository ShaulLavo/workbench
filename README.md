# workbench

MIT React 19 workbench UI library (`@shaulavo/workbench`) for Sprockt, Fregat, and browser IDEs.

## Install

```bash
bun add @shaulavo/workbench react react-dom @base-ui/react
```

Optional peers: `ghostty-webgpu` (`./terminal`), `@singapore-editor/*` (`./editor*`), and `@dnd-kit/*` (`./editor/groups`).

## Usage

Browser subpaths auto-import their component CSS. Theme presets, reset, and Tailwind v4 layers are opt-in:

```tsx
import "@shaulavo/workbench/reset.css";
import "@shaulavo/workbench/themes/fregat.css";
import { WorkbenchShell } from "@shaulavo/workbench";
import { FileTreeView } from "@shaulavo/workbench/tree";
```

Tailwind v4 hosts import `@import "@shaulavo/workbench/layers.css";` on line 1 before `@import "tailwindcss";`.

## Development

```bash
bun install && bun run verify
```

See [AGENTS.md](./AGENTS.md) for package architecture, verification, and MIT license rules.
