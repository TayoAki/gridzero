# Spike S2 — Canvas grid over server-served viewports

**Result: PASS. Keep BUILD-SPEC D6 (custom canvas renderer).**
Date: 2026-10-28 · Harness: `spikes/s2_grid` (Vite + TypeScript, ~900 lines)

## What was built
- **Renderer:** `CanvasGrid` (`src/grid.ts`), on a single DPR-scaled canvas.
  - Draws four quadrants (body, frozen rows, frozen columns, corner), then the selection, headers, freeze lines and custom scrollbars.
  - Numbers are right-aligned; text is truncated with an ellipsis, cached per width.
  - Gridlines are stroked as one path per quadrant.
- **Geometry:** `SparseAxis` (`src/axis.ts`) — a default size plus sparse overrides, with O(log n) offset and index lookups. 1M rows is a 22,000,502 px logical height, beyond what a browser allows for a native scroll container. So scrolling happens in logical space with custom scrollbars, and no DOM element is ever sized to the sheet.
- **Data:** `TileCache` (`src/tiles.ts`) — 64 × 16 cell tiles, LRU-capped at 3,000. Visible tiles are requested first; the 440 px buffer and a velocity-scaled lookahead (250 ms ahead, capped at 8,000 px) are requested separately.
- **Server stand-in:** `server.worker.ts` — a Web Worker that answers with MessagePack tile patches after 30 ms ± 10 ms of simulated latency, so the client pays real decode cost and sees realistic arrival timing.
- **Input:** wheel, shift-wheel, scrollbar drag and paging, click, shift-click and drag selection, arrows and PageUp/PageDown, plus `hitTest` and `visibleCellRect`.
- **Test shape:** 1,000,000 rows × 50 columns, frozen 1 row and 1 column, mixed column widths (64–200 px) and row heights (22–44 px).

## Gates

| Gate | Target | Measured (headful Chrome 155, 30 ms latency) | Result |
|---|---|---|---|
| Scroll at 60 fps | Every frame fits 16.7 ms | Draw p99 ≤ 8.3 ms and max ≤ 10.4 ms at every viewport, for slow (2k px/s), fling (20k px/s) and diagonal scrolls | PASS |
| No blank frames > 100 ms | 0 | **0 blank frames** in all scroll runs, including 20k px/s flings | PASS |
| Jump (scrollbar teleport) fill | ≤ 100 ms | p95 61–69 ms, max 73 ms; 0 of 120 over 100 ms | PASS |
| Hit-testing | 0 mismatches | **0 / 30,000** random points, each checked forward (point inside the hit cell's visible rect) and inverse (that rect's centre hits the same cell) | PASS |

### Detail: headful run, 30 ms latency (`results/s2_headful_lat30.json`)

| Viewport | Scroll | Draw p50 / p95 / max (ms) | Blank frames | Jump fill p50 / p95 (ms) |
|---|---|---|---|---|
| 1280×720 @1x | 2k / 20k / diagonal | 1.8 / 2.9 / 5.8 · 2.4 / 3.3 / 4.4 · 1.8 / 2.8 / 4.1 | 0 | 49 / 62 |
| 1280×720 @2x | 2k / 20k / diagonal | 2.8 / 3.8 / 5.7 · 2.6 / 3.9 / 5.5 · 2.2 / 3.6 / 5.3 | 0 | 47 / 61 |
| 2560×1440 @1x | 2k / 20k / diagonal | 4.9 / 7.5 / 10.4 · 4.0 / 5.1 / 8.1 · 3.9 / 4.7 / 6.4 | 0 | 58 / 69 |

Each response costs about 1–3 ms on the simulated server (tile build plus MessagePack pack) and about 0.5–1.5 ms of client decode.

Machine: i7-10750H laptop, Intel UHD + RTX 3070, **240 Hz display**. rAF therefore ran at 100–240 fps, so frame intervals aren't 60 Hz numbers. The 60 fps gate is judged on draw time against the 16.7 ms budget. Headless runs (`results/s2_headless_lat30.json`) give the same picture.

## What the spike changed
1. **Visible-first requests.** Asking for the visible tiles and the buffer in one request put 12–25 tiles (up to about 25k cells) on the critical path; jumps took 87–150 ms. Splitting them brought jumps to 46–69 ms. **Protocol consequence:** `GetData` must let the client mark the visible window as higher priority than the buffer, or send two requests (BUILD-SPEC §5.1).
2. **Velocity lookahead.** At 20k px/s the fixed 440 px buffer is used up within one round trip, which caused a 413 ms blank episode. Prefetching 250 ms × the smoothed velocity removed every blank frame.
3. **Server formatting cost matters.** Formatting with `Intl.toLocaleString` in the worker made tile builds dominate jump latency (60–180 ms with zero network latency). A plain formatter brought responses to about 1 ms. The Rust server must use pre-compiled number formats (IronCalc's formatter) and cache formatted display strings per tile.
4. **Test flaw found and fixed.** The first hit-test check used the full cell rect. Cells partly hidden under a frozen pane failed the inverse check (1.4% false mismatches), so `visibleCellRect` (the cell clipped to its pane) was added. The production cell editor and overlays need the same function.

## Not covered (carry into M1)
- Text overflow into empty neighbours (Excel behaviour); for now text is clipped with an ellipsis.
- Formats beyond bold and number alignment (fills, borders, fonts, wrap) — expect draw time to grow; re-measure in M1.
- IME and in-cell editing, accessibility (ARIA live region), touch and trackpad momentum, column and row resizing.
- A real network: the worker models latency but not bandwidth, packet loss or reconnects.
- Firefox and Safari (Chromium only).

## Reproduce
```bash
cd spikes/s2_grid
pnpm install
pnpm run bench                                         # headless, 30 ms latency
pnpm exec vite build && node bench/run.mjs --headful   # visible Chrome window
pnpm run dev                                           # interactive at http://localhost:4316
```
