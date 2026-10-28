// Client-side cache of server-sent viewport tiles (BUILD-SPEC §3.2).
// A tile covers TILE_ROWS x TILE_COLS cells. The client asks the server only for
// tiles intersecting the viewport plus buffer that it does not already hold.

import { unpack } from "msgpackr";

export const TILE_ROWS = 64;
export const TILE_COLS = 16;
const MAX_TILES = 3000;

export const enum CellFlag {
  Number = 1,
  Bold = 2,
}

export interface Tile {
  text: (string | null)[];
  flags: Uint8Array;
}

/** Wire shape of one tile in a server patch: [tileRow, tileCol, cells], cells = [index, display, flags][]. */
type WireTile = [number, number, [number, string, number][]];

export interface ViewportRequest {
  type: "tiles";
  reqId: number;
  tiles: [number, number][];
}

export class TileCache {
  private tiles = new Map<string, Tile>();
  private pending = new Set<string>();
  private reqId = 0;
  bytesReceived = 0;
  decodeMs = 0;
  serverMs = 0;
  responses = 0;

  constructor(private worker: Worker, private onUpdate: () => void) {
    worker.onmessage = (ev: MessageEvent<{ buf: ArrayBuffer; serverMs: number }>) => {
      this.serverMs += ev.data.serverMs;
      this.receive(ev.data.buf);
    };
  }

  get(tileRow: number, tileCol: number): Tile | undefined {
    const key = tileKey(tileRow, tileCol);
    const tile = this.tiles.get(key);
    if (tile) {
      // Refresh LRU position.
      this.tiles.delete(key);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  /** Request every tile in the inclusive cell range that is neither cached nor in flight. */
  ensure(r0: number, r1: number, c0: number, c1: number): void {
    const want: [number, number][] = [];
    for (let tr = Math.floor(r0 / TILE_ROWS); tr <= Math.floor(r1 / TILE_ROWS); tr++) {
      for (let tc = Math.floor(c0 / TILE_COLS); tc <= Math.floor(c1 / TILE_COLS); tc++) {
        const key = tileKey(tr, tc);
        if (this.tiles.has(key) || this.pending.has(key)) continue;
        this.pending.add(key);
        want.push([tr, tc]);
      }
    }
    if (want.length === 0) return;
    const msg: ViewportRequest = { type: "tiles", reqId: ++this.reqId, tiles: want };
    this.worker.postMessage(msg);
  }

  private receive(buf: ArrayBuffer): void {
    const t0 = performance.now();
    this.bytesReceived += buf.byteLength;
    const wire = unpack(new Uint8Array(buf)) as WireTile[];
    for (const [tr, tc, cells] of wire) {
      const tile: Tile = { text: new Array(TILE_ROWS * TILE_COLS).fill(null), flags: new Uint8Array(TILE_ROWS * TILE_COLS) };
      for (const [i, display, flags] of cells) {
        tile.text[i] = display;
        tile.flags[i] = flags;
      }
      const key = tileKey(tr, tc);
      this.pending.delete(key);
      this.tiles.set(key, tile);
    }
    while (this.tiles.size > MAX_TILES) {
      this.tiles.delete(this.tiles.keys().next().value as string);
    }
    this.decodeMs += performance.now() - t0;
    this.responses++;
    this.onUpdate();
  }

  clear(): void {
    this.tiles.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.tiles.size;
  }
}

function tileKey(tileRow: number, tileCol: number): string {
  return `${tileRow}:${tileCol}`;
}
