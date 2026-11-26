# Workbench verification feature map

| Phase           | Surface                                                                                                                                          | Harness entry         | Automated Playwright spec         |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------- | :-------------------------------- |
| Phase 0         | Boot smoke + CSS layer cascade (plain-CSS vs Tailwind v4) + scoped theme observer + touch focus policy                                           | `/`, `/tailwind.html` | `apps/harness/e2e/phase0.spec.ts` |
| Phase 1         | Base UI overlays + `WorkbenchPortalProvider` scoped theming + `DesktopSplitGrid` / `Splitter` + `MobilePaneShell` + `TooltipLayer` + `ToastHost` | `/`, `/tailwind.html` | `apps/harness/e2e/phase1.spec.ts` |
| Phase 2 (icons) | `@shaulavo/workbench-icons` MIT/CC0 manifest + `CLAUDE.md` CC0 glyph + rich & stroke presets                                                     | `/`, `/tailwind.html` | `apps/harness/e2e/phase1.spec.ts` |
| Phase 2 (tree)  | Clean-room MIT file tree + 50k-path benchmark                                                                                                    | Planned               | Planned                           |
| Phase 3         | Ghostty reactive theme/font sync + ordered replay + `DECCKM` keys + bridged & remote preview                                                     | Planned               | Planned                           |
| Phase 4         | Singapore editor + split groups + mobile touch WebKit tab-tap focus + Markdown composer                                                          | Planned               | Planned                           |
