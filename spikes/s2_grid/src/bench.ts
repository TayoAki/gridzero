// S2 gate measurements, run in-page (BUILD-SPEC §11 M0):
//   scroll  - 60 fps while scrolling a 1M x 50 grid, no blank episode > 100 ms
//   jumps   - scrollbar teleports fill within 100 ms
//   hittest - hit-testing agrees with cell geometry for random points

import type { CanvasGrid, FrameStats } from "./grid";
import { COL_HEADER_H, ROW_HEADER_W, SCROLLBAR } from "./grid";
import type { TileCache } from "./tiles";

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarize(values: number[]) {
  const round = (v: number) => Math.round(v * 100) / 100;
  return { p50: round(pct(values, 50)), p95: round(pct(values, 95)), p99: round(pct(values, 99)), max: round(Math.max(0, ...values)) };
}

/** Draw synchronously with the bench's own scroll position, bypassing the grid's rAF scheduling. */
function drawAt(grid: CanvasGrid, x: number, y: number): FrameStats {
  let stats: FrameStats = { drawMs: 0, visibleCells: 0, blankCells: 0 };
  grid.onFrame = (s) => (stats = s);
  grid.scrollX = Math.min(Math.max(0, x), grid.maxScrollX);
  grid.scrollY = Math.min(Math.max(0, y), grid.maxScrollY);
  grid.draw();
  grid.onFrame = null;
  return stats;
}

async function waitFilled(grid: CanvasGrid, timeoutMs = 2000): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    await nextFrame();
    if (drawAt(grid, grid.scrollX, grid.scrollY).blankCells === 0) return performance.now() - t0;
  }
  return Infinity;
}

export async function runScroll(grid: CanvasGrid, opts: { pxPerSecond: number; durationMs: number; axis: "y" | "x" | "xy" }) {
  drawAt(grid, 0, 0);
  await waitFilled(grid);
  const intervals: number[] = [];
  const drawMs: number[] = [];
  const blankEpisodes: number[] = [];
  let blankSince: number | null = null;
  let blankFrames = 0;
  let frames = 0;
  const start = await nextFrame();
  let last = start;
  const x0 = grid.scrollX;
  const y0 = grid.scrollY;
  for (;;) {
    const ts = await nextFrame();
    const elapsed = ts - start;
    if (elapsed > opts.durationMs) break;
    intervals.push(ts - last);
    last = ts;
    const dist = (opts.pxPerSecond * elapsed) / 1000;
    const stats = drawAt(grid, opts.axis === "y" ? x0 : x0 + dist / (opts.axis === "xy" ? 4 : 1), opts.axis === "x" ? y0 : y0 + dist);
    frames++;
    drawMs.push(stats.drawMs);
    if (stats.blankCells > 0) {
      blankFrames++;
      blankSince ??= ts;
    } else if (blankSince !== null) {
      blankEpisodes.push(ts - blankSince);
      blankSince = null;
    }
  }
  if (blankSince !== null) blankEpisodes.push(last - blankSince);
  const medianInterval = pct(intervals, 50);
  const longFrames = intervals.filter((v) => v > medianInterval * 1.5).length;
  return {
    ...opts,
    frames,
    fps: Math.round((frames / (opts.durationMs / 1000)) * 10) / 10,
    intervalMs: summarize(intervals),
    drawMs: summarize(drawMs),
    longFramePct: Math.round((longFrames / Math.max(1, frames)) * 1000) / 10,
    blankFrames,
    maxBlankEpisodeMs: Math.round(Math.max(0, ...blankEpisodes)),
    endRow: grid.visibleRows().first,
  };
}

export async function runJumps(grid: CanvasGrid, cache: TileCache, count: number) {
  const fill: number[] = [];
  const server0 = cache.serverMs;
  const decode0 = cache.decodeMs;
  const responses0 = cache.responses;
  for (let i = 0; i < count; i++) {
    drawAt(grid, Math.random() * grid.maxScrollX, Math.random() * grid.maxScrollY);
    fill.push(await waitFilled(grid));
  }
  const responses = Math.max(1, cache.responses - responses0);
  return {
    count,
    fillMs: summarize(fill),
    over100ms: fill.filter((v) => v > 100).length,
    perResponse: {
      serverMs: Math.round(((cache.serverMs - server0) / responses) * 100) / 100,
      decodeMs: Math.round(((cache.decodeMs - decode0) / responses) * 100) / 100,
    },
  };
}

export function runHitTest(grid: CanvasGrid, points: number) {
  let checked = 0;
  let mismatches = 0;
  const examples: unknown[] = [];
  const { width: w, height: h } = grid;
  for (let i = 0; i < points; i++) {
    drawAt(grid, Math.random() * grid.maxScrollX, Math.random() * grid.maxScrollY);
    for (let k = 0; k < 20; k++) {
      const x = ROW_HEADER_W + Math.random() * (w - SCROLLBAR - ROW_HEADER_W);
      const y = COL_HEADER_H + Math.random() * (h - SCROLLBAR - COL_HEADER_H);
      const hit = grid.hitTest(x, y);
      checked++;
      let ok = hit.kind === "cell" || hit.kind === "none";
      if (hit.kind === "cell") {
        // Forward check: the hit cell's visible rect must contain the point.
        const r = grid.visibleCellRect(hit.row, hit.col);
        ok = r !== null && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
        // Inverse check: the centre of the visible rect must hit the same cell.
        if (r) {
          const back = grid.hitTest(r.x + r.w / 2, r.y + r.h / 2);
          ok &&= back.kind === "cell" && back.row === hit.row && back.col === hit.col;
        }
      }
      if (!ok) {
        mismatches++;
        if (examples.length < 5) examples.push({ x, y, hit, scrollX: grid.scrollX, scrollY: grid.scrollY });
      }
    }
  }
  return { checked, mismatches, examples };
}

export async function runAll(grid: CanvasGrid, cache: TileCache) {
  const t0 = performance.now();
  const coldFillMs = await waitFilled(grid, 5000);
  const result = {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    coldFillMs: Math.round(coldFillMs),
    scroll: [
      await runScroll(grid, { pxPerSecond: 2_000, durationMs: 4_000, axis: "y" }),
      await runScroll(grid, { pxPerSecond: 20_000, durationMs: 4_000, axis: "y" }),
      await runScroll(grid, { pxPerSecond: 3_000, durationMs: 3_000, axis: "xy" }),
    ],
    jumps: await runJumps(grid, cache, 40),
    hittest: runHitTest(grid, 500),
    totalMs: 0,
  };
  result.totalMs = Math.round(performance.now() - t0);
  return result;
}
