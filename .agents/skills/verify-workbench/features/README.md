# Workbench verification feature map

| Phase           | Surface                                                                                                                                          | Harness entry         | Automated Playwright spec                          |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- | :------------------------------------------------- |
| Phase 0         | Boot smoke + CSS layer cascade (plain-CSS vs Tailwind v4) + scoped theme observer + touch focus policy                                           | `/`, `/tailwind.html` | `apps/harness/e2e/phase0.spec.ts`                  |
| Phase 1         | Base UI overlays + `WorkbenchPortalProvider` scoped theming + `DesktopSplitGrid` / `Splitter` + `MobilePaneShell` + `TooltipLayer` + `ToastHost` | `/`, `/tailwind.html` | `apps/harness/e2e/phase1.spec.ts`                  |
| Phase 2 (icons) | `@shaulavo/workbench-icons` MIT/CC0 manifest + `CLAUDE.md` CC0 glyph + rich & stroke presets                                                     | `/`, `/tailwind.html` | `apps/harness/e2e/phase1.spec.ts`                  |
| Phase 2 (tree)  | `@shaulavo/workbench-tree` clean-room MIT virtualized tree + 50k-path benchmark + sticky ancestors + compact chains + lazy retry                 | `/`, `/tailwind.html` | `apps/harness/e2e/phase2-tree.spec.ts`             |
| Phase 3         | Ghostty reactive theme/font sync + ordered replay + `DECCKM` keys + bridged & remote preview                                                     | `/`, `/tailwind.html` | `apps/harness/e2e/phase3-terminal-preview.spec.ts` |
| Phase 4         | Singapore editor + split groups + mobile touch WebKit tab-tap focus + Markdown composer                                                          | Planned               | Planned                                            |
