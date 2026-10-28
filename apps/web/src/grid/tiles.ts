// Client cache of server-rendered tiles (BUILD-SPEC §3.2). Tiles are TILE_ROWS x
// TILE_COLS cells. After an edit the server broadcasts `Changed`; the cache then
// keeps showing the old tiles (no flicker) while it re-requests the visible ones.

export const TILE_ROWS = 64;
export const TILE_COLS = 16;
const MAX_TILES = 3000;

export const enum CellFlag {
  Number = 1,
  Bold = 2,
  Error = 4,
}

export interface Tile {
  text: (string | null)[];
  flags: Uint8Array;
  gen: number;
}

/** Server shape: one tile and its non-empty cells as [index within tile, display, flags]. */
export interface WireTile {
  tr: number;
  tc: number;
  cells: [number, string, number][];
}

export interface TileSource {
  requestTiles(tiles: [number, number][]): void;
}

export class TileCache {
  private tiles = new Map<string, Tile>();
  // key -> generation the request was made for
  private pending = new Map<string, number>();
  private gen = 0;

  constructor(private source: TileSource, private onUpdate: () => void) {}

  get(tileRow: number, tileCol: number): Tile | undefined {
    const key = tileKey(tileRow, tileCol);
    const tile = this.tiles.get(key);
    if (tile) {
      this.tiles.delete(key);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  /** Request tiles in the inclusive cell range that are missing or stale and not already in flight. */
  ensure(r0: number, r1: number, c0: number, c1: number): void {
    const want: [number, number][] = [];
    for (let tr = Math.floor(r0 / TILE_ROWS); tr <= Math.floor(r1 / TILE_ROWS); tr++) {
      for (let tc = Math.floor(c0 / TILE_COLS); tc <= Math.floor(c1 / TILE_COLS); tc++) {
        const key = tileKey(tr, tc);
        const tile = this.tiles.get(key);
        if (tile && tile.gen === this.gen) continue;
        if (this.pending.get(key) === this.gen) continue;
        this.pending.set(key, this.gen);
        want.push([tr, tc]);
      }
    }
    if (want.length > 0) this.source.requestTiles(want);
  }

  /** Store tiles from a response. `requestGen` is the generation current when they were requested. */
  receive(wire: WireTile[], requestGen: number): void {
    for (const { tr, tc, cells } of wire) {
      const tile: Tile = { text: new Array(TILE_ROWS * TILE_COLS).fill(null), flags: new Uint8Array(TILE_ROWS * TILE_COLS), gen: requestGen };
      for (const [i, display, flags] of cells) {
        tile.text[i] = display;
        tile.flags[i] = flags;
      }
      const key = tileKey(tr, tc);
      if (this.pending.get(key) === requestGen) this.pending.delete(key);
      const current = this.tiles.get(key);
      if (!current || current.gen <= requestGen) this.tiles.set(key, tile);
    }
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value as string);
    this.onUpdate();
  }

  /** Mark every cached tile stale; they stay visible until fresh ones arrive. */
  invalidate(): void {
    this.gen++;
    this.onUpdate();
  }

  get generation(): number {
    return this.gen;
  }
}

function tileKey(tileRow: number, tileCol: number): string {
  return `${tileRow}:${tileCol}`;
}
