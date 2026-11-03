// Client cache of server-rendered tiles (BUILD-SPEC §3.2). Tiles are TILE_ROWS x
// TILE_COLS cells of one sheet. After an edit the server broadcasts `Changed`; the
// cache keeps showing the old tiles (no flicker) while it re-requests the visible ones.

export const TILE_ROWS = 64;
export const TILE_COLS = 16;
const MAX_TILES = 3000;

/** `kind::*` flags from the server. */
export const enum CellKind {
  Number = 1,
  Error = 2,
  Boolean = 4,
  /** Data Table or filtered-range header: draw a column-menu button. */
  HeaderButton = 8,
  Filtered = 16,
  Sorted = 32,
  SortDesc = 64,
  /** Data-validation dropdown. */
  Dropdown = 128,
}

/** `font::*` flags from the server. */
export const enum FontFlag {
  Bold = 1,
  Italic = 2,
  Underline = 4,
  Strike = 8,
  Wrap = 16,
}

export type Edge = [style: string, color: string] | null;

export interface CellStyle {
  font: number;
  color: string | null;
  fill: string | null;
  align: "left" | "center" | "right" | null;
  size: number | null;
  top: Edge;
  right: Edge;
  bottom: Edge;
  left: Edge;
  /** Conditional-format data bar: [fill in thousandths of the width, color]. */
  bar?: [number, string] | null;
  /** Conditional-format icon: [name, color]. */
  icon?: [string, string] | null;
}

export interface Tile {
  text: (string | null)[];
  kind: Uint8Array;
  style: Uint16Array;
  styles: CellStyle[];
  gen: number;
}

/** Server shape: non-empty cells as [index within tile, display, kind, style index]. */
export interface WireTile {
  tr: number;
  tc: number;
  cells: [number, string, number, number][];
  styles: CellStyle[];
}

export interface TileSource {
  requestTiles(sheet: number, tiles: [number, number][]): void;
}

export class TileCache {
  private tiles = new Map<string, Tile>();
  // key -> generation the request was made for
  private pending = new Map<string, number>();
  private gen = 0;
  sheet = 0;

  constructor(private source: TileSource, private onUpdate: () => void) {}

  /** Switch to another sheet: drop everything cached for the previous one. */
  setSheet(sheet: number): void {
    this.sheet = sheet;
    this.tiles.clear();
    this.pending.clear();
    this.gen++;
    this.onUpdate();
  }

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
    if (want.length > 0) this.source.requestTiles(this.sheet, want);
  }

  /** Store tiles from a response for `sheet`, requested at generation `requestGen`. */
  receive(sheet: number, wire: WireTile[], requestGen: number): void {
    if (sheet !== this.sheet) return;
    for (const { tr, tc, cells, styles } of wire) {
      const n = TILE_ROWS * TILE_COLS;
      const tile: Tile = { text: new Array(n).fill(null), kind: new Uint8Array(n), style: new Uint16Array(n), styles, gen: requestGen };
      for (const [i, display, kind, style] of cells) {
        tile.text[i] = display;
        tile.kind[i] = kind;
        tile.style[i] = style;
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
