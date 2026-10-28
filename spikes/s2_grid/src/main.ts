import { runAll } from "./bench";
import { CanvasGrid } from "./grid";
import { TileCache } from "./tiles";

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => Number(params.get(key) ?? fallback);

const opts = {
  rows: num("rows", 1_000_000),
  cols: num("cols", 50),
  frozenRows: num("frozenRows", 1),
  frozenCols: num("frozenCols", 1),
};

const worker = new Worker(new URL("./server.worker.ts", import.meta.url), { type: "module" });
worker.postMessage({ type: "config", rows: opts.rows, cols: opts.cols, latencyMs: num("latency", 30), jitterMs: num("jitter", 10) });

let grid: CanvasGrid;
const cache = new TileCache(worker, () => grid.invalidate());
grid = new CanvasGrid(document.getElementById("grid")!, cache, opts);

// Mixed sizes so geometry and hit-testing are exercised off the defaults.
grid.cols.setSize(2, 200);
grid.cols.setSize(4, 64);
grid.cols.setSize(17, 160);
grid.rows.setSize(5, 44);
for (let r = 1000; r < opts.rows; r += 25_000) grid.rows.setSize(r, 34);

const status = document.getElementById("status")!;
status.textContent = `${opts.rows.toLocaleString()} rows × ${opts.cols} cols · frozen ${opts.frozenRows}/${opts.frozenCols} · logical height ${Math.round(grid.rows.total()).toLocaleString()} px`;

declare global {
  interface Window {
    __s2: { grid: CanvasGrid; cache: TileCache; runAll: () => ReturnType<typeof runAll>; ready: boolean };
  }
}
window.__s2 = { grid, cache, runAll: () => runAll(grid, cache), ready: true };
