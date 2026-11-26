---
name: verify-workbench
description: Drive apps/harness in Chromium and WebKit (desktop and touch) to verify shared workbench packages, CSS cascade isolation, theme parity, and touch focus invariants.
---

# Verify workbench

`apps/harness` mounts every `@shaulavo/workbench-*` package over in-memory mock adapters on two hosts:

- `/` — plain-CSS host (Sprockt-like, zero Tailwind, uses `@shaulavo/workbench-tokens/reset.css` + `themes/sprockt.css`).
- `/tailwind.html` — Tailwind v4 host (Fregat-like, uses `@tailwindcss/vite` + `themes/fregat.css` + `tailwind-bridge.css`).

## Commands

```bash
bun run verify:browser look --doctor
bun run verify:browser look --engine webkit
bun run test:browser
```

Evidence (screenshots + `observed.json` + `summary.md`) is written to `<OS temp>/workbench-evidence/<stamp>-<verb>-<engine>/`. Read captured screenshots back before calling any visual change done.

## Feature map

See [features/README.md](features/README.md).
