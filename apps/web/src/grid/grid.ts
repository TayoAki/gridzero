// Canvas grid renderer for server-served viewports (BUILD-SPEC D6, §6).
// Promoted from spike S2 (spikes/s2_grid); see docs/spikes/S2-canvas-grid.md.
// Scrolling happens in logical pixel space with custom scrollbars because a
// 1M-row sheet is taller than any native scroll container may be.

import { SparseAxis } from "./axis";
import { CellKind, FontFlag, TILE_COLS, TILE_ROWS, TileCache } from "./tiles";
import type { CellStyle, Edge, Tile } from "./tiles";

export const ROW_HEADER_W = 56;
export const COL_HEADER_H = 22;
export const SCROLLBAR = 12;
const BUFFER_PX = 440; // matches the reference client's viewport buffer (PRD E7)
const LOOKAHEAD_MS = 250; // prefetch this far ahead of the current scroll velocity
const LOOKAHEAD_MAX_PX = 8_000;
const FONT_FAMILY = "system-ui, -apple-system, Segoe UI, sans-serif";
const BASE_PT = 12; // IronCalc's default point size, drawn at 13px
const PAD = 4;
const RESIZE_GRIP = 4;
const MIN_SIZE = 8;
const HEADER_BUTTON_W = 18;

export interface GridOptions {
  rows: number;
  cols: number;
}

/** Per-sheet layout from the server's `SheetMeta`. */
export interface SheetLayout {
  /** Rows on this sheet: Excel's limit, or more when a Data Table is longer. */
  rowCount: number;
  defaultColWidth: number;
  defaultRowHeight: number;
  colWidths: [number, number][];
  rowHeights: [number, number][];
  frozenRows: number;
  frozenCols: number;
  merges: CellRange[];
  showGrid: boolean;
}

export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export type Hit =
  | { kind: "cell"; row: number; col: number }
  | { kind: "rowHeader"; row: number }
  | { kind: "colHeader"; col: number }
  | { kind: "corner" }
  | { kind: "vscroll" }
  | { kind: "hscroll" }
  | { kind: "none" };

export interface CellPos {
  row: number;
  col: number;
}

export interface FrameStats {
  drawMs: number;
  visibleCells: number;
  blankCells: number;
}

export type Command =
  | "undo" | "redo" | "copy" | "cut" | "selectAll" | "fillDown" | "fillRight"
  | "bold" | "italic" | "underline" | "find" | "clear";

export type ArrowDir = "Up" | "Down" | "Left" | "Right";

interface Span {
  first: number;
  last: number;
}

type Drag =
  | { mode: "select" }
  | { mode: "selectRows" | "selectCols" }
  | { mode: "vthumb" | "hthumb"; startPos: number; startScroll: number }
  | { mode: "resizeCol"; index: number; start: number; startSize: number }
  | { mode: "resizeRow"; index: number; start: number; startSize: number };

export class CanvasGrid {
  rows: SparseAxis;
  cols: SparseAxis;
  frozenRows = 0;
  frozenCols = 0;
  merges: CellRange[] = [];
  showGrid = true;
  scrollX = 0;
  scrollY = 0;
  anchor: CellPos = { row: 0, col: 0 };
  focus: CellPos = { row: 0, col: 0 };
  onFrame: ((stats: FrameStats) => void) | null = null;
  /** Focus cell or selection changed (click, keyboard, or `select`). */
  onSelect: (focus: CellPos) => void = () => {};
  /** User asked to edit the focus cell: `initial` is typed text, or undefined for F2/double-click. */
  onEditRequest: (initial?: string) => void = () => {};
  onCommand: (command: Command) => void = () => {};
  /** Ctrl+Arrow: the page asks the server for the data edge and calls `select`. */
  onJump: (dir: ArrowDir, extend: boolean) => void = () => {};
  onPasteText: (text: string) => void = () => {};
  onResize: (axis: "col" | "row", index: number, size: number) => void = () => {};
  onContextMenu: (hit: Hit, x: number, y: number) => void = () => {};
  /** The column-menu button of a Data Table or filtered-range header was clicked. */
  onHeaderButton: (row: number, col: number, x: number, y: number) => void = () => {};

  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly textInput: HTMLTextAreaElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 1;
  private frameRequested = false;
  private drag: Drag | null = null;
  private textWidth = new Map<string, number>();
  private fitted = new Map<string, string>();
  private frame: FrameStats = { drawMs: 0, visibleCells: 0, blankCells: 0 };
  private lastDraw = { t: 0, x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };

  constructor(private readonly host: HTMLElement, private readonly tiles: TileCache, readonly opts: GridOptions) {
    this.rows = new SparseAxis(opts.rows, 25);
    this.cols = new SparseAxis(opts.cols, 90);
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    host.appendChild(this.canvas);
    // Hidden textarea that owns keyboard focus (see bindInput). It sits over the focus
    // cell so an IME's candidate window opens next to it.
    this.textInput = document.createElement("textarea");
    this.textInput.setAttribute("aria-label", "Spreadsheet grid");
    this.textInput.setAttribute("autocomplete", "off");
    this.textInput.spellcheck = false;
    Object.assign(this.textInput.style, {
      position: "absolute", width: "1px", height: "1px", padding: "0", border: "0",
      opacity: "0", resize: "none", overflow: "hidden", pointerEvents: "none",
    });
    host.appendChild(this.textInput);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.bindInput();
    this.resize();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.canvas.remove();
    this.textInput.remove();
  }

  /** Apply a sheet's sizes, frozen panes, merges and gridline setting. */
  setLayout(layout: SheetLayout): void {
    this.rows = new SparseAxis(layout.rowCount, layout.defaultRowHeight);
    this.cols = new SparseAxis(this.opts.cols, layout.defaultColWidth);
    for (const [i, w] of layout.colWidths) this.cols.setSize(i, w);
    for (const [i, h] of layout.rowHeights) this.rows.setSize(i, h);
    this.frozenRows = layout.frozenRows;
    this.frozenCols = layout.frozenCols;
    this.merges = layout.merges;
    this.showGrid = layout.showGrid;
    this.scrollTo(this.scrollX, this.scrollY);
    this.invalidate();
  }

  // ------------------------------------------------------------- geometry

  private get frozenW(): number {
    return this.cols.offsetOf(this.frozenCols);
  }
  private get frozenH(): number {
    return this.rows.offsetOf(this.frozenRows);
  }
  private get bodyX0(): number {
    return ROW_HEADER_W + this.frozenW;
  }
  private get bodyY0(): number {
    return COL_HEADER_H + this.frozenH;
  }
  get viewW(): number {
    return Math.max(0, this.width - SCROLLBAR - this.bodyX0);
  }
  get viewH(): number {
    return Math.max(0, this.height - SCROLLBAR - this.bodyY0);
  }
  get maxScrollX(): number {
    return Math.max(0, this.cols.total() - this.frozenW - this.viewW);
  }
  get maxScrollY(): number {
    return Math.max(0, this.rows.total() - this.frozenH - this.viewH);
  }

  colX(col: number): number {
    return col < this.frozenCols ? ROW_HEADER_W + this.cols.offsetOf(col) : this.bodyX0 + this.cols.offsetOf(col) - this.frozenW - this.scrollX;
  }

  rowY(row: number): number {
    return row < this.frozenRows ? COL_HEADER_H + this.rows.offsetOf(row) : this.bodyY0 + this.rows.offsetOf(row) - this.frozenH - this.scrollY;
  }

  cellRect(row: number, col: number): { x: number; y: number; w: number; h: number } {
    return { x: this.colX(col), y: this.rowY(row), w: this.cols.sizeOf(col), h: this.rows.sizeOf(row) };
  }

  /** The merged range containing a cell, if any. */
  mergeAt(row: number, col: number): CellRange | null {
    for (const m of this.merges) if (row >= m.r0 && row <= m.r1 && col >= m.c0 && col <= m.c1) return m;
    return null;
  }

  /** Screen rect of a cell, expanded to its merge. */
  private blockRect(row: number, col: number) {
    const m = this.mergeAt(row, col);
    if (!m) return this.cellRect(row, col);
    const x = this.colX(m.c0);
    const y = this.rowY(m.r0);
    return { x, y, w: this.colX(m.c1) + this.cols.sizeOf(m.c1) - x, h: this.rowY(m.r1) + this.rows.sizeOf(m.r1) - y };
  }

  /** The on-screen part of a cell (or its merge), clipped to its pane; null when fully hidden. */
  visibleCellRect(row: number, col: number): { x: number; y: number; w: number; h: number } | null {
    const r = this.blockRect(row, col);
    const [px0, px1] = col < this.frozenCols ? [ROW_HEADER_W, this.bodyX0] : [this.bodyX0, this.width - SCROLLBAR];
    const [py0, py1] = row < this.frozenRows ? [COL_HEADER_H, this.bodyY0] : [this.bodyY0, this.height - SCROLLBAR];
    const x0 = Math.max(r.x, px0);
    const x1 = Math.min(r.x + r.w, px1);
    const y0 = Math.max(r.y, py0);
    const y1 = Math.min(r.y + r.h, py1);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Scrollable (non-frozen) indices intersecting the view, extended by `pad` px each side. */
  private scrollRange(axis: SparseAxis, frozen: number, frozenPx: number, scroll: number, view: number, pad = 0): Span {
    const first = Math.max(frozen, axis.indexAt(frozenPx + scroll - pad));
    const last = Math.min(axis.count - 1, axis.indexAt(frozenPx + scroll + view + pad));
    return { first, last };
  }

  visibleRows(pad = 0): Span {
    return this.scrollRange(this.rows, this.frozenRows, this.frozenH, this.scrollY, this.viewH, pad);
  }

  visibleCols(pad = 0): Span {
    return this.scrollRange(this.cols, this.frozenCols, this.frozenW, this.scrollX, this.viewW, pad);
  }

  /** The selected rectangle (anchor..focus). */
  selection(): CellRange {
    return {
      r0: Math.min(this.anchor.row, this.focus.row),
      r1: Math.max(this.anchor.row, this.focus.row),
      c0: Math.min(this.anchor.col, this.focus.col),
      c1: Math.max(this.anchor.col, this.focus.col),
    };
  }

  hitTest(x: number, y: number): Hit {
    const inV = x >= this.width - SCROLLBAR;
    const inH = y >= this.height - SCROLLBAR;
    if (inV && inH) return { kind: "none" };
    if (inV) return { kind: "vscroll" };
    if (inH) return { kind: "hscroll" };
    const col = this.colAt(x);
    const row = this.rowAt(y);
    if (x < ROW_HEADER_W && y < COL_HEADER_H) return { kind: "corner" };
    if (x < ROW_HEADER_W) return row === null ? { kind: "none" } : { kind: "rowHeader", row };
    if (y < COL_HEADER_H) return col === null ? { kind: "none" } : { kind: "colHeader", col };
    if (row === null || col === null) return { kind: "none" };
    return { kind: "cell", row, col };
  }

  private colAt(x: number): number | null {
    if (x < ROW_HEADER_W) return null;
    const logical = x < this.bodyX0 ? x - ROW_HEADER_W : x - this.bodyX0 + this.frozenW + this.scrollX;
    return logical >= this.cols.total() ? null : this.cols.indexAt(logical);
  }

  private rowAt(y: number): number | null {
    if (y < COL_HEADER_H) return null;
    const logical = y < this.bodyY0 ? y - COL_HEADER_H : y - this.bodyY0 + this.frozenH + this.scrollY;
    return logical >= this.rows.total() ? null : this.rows.indexAt(logical);
  }

  // ------------------------------------------------------------- scrolling

  scrollTo(x: number, y: number): void {
    const nx = clamp(x, 0, this.maxScrollX);
    const ny = clamp(y, 0, this.maxScrollY);
    if (nx === this.scrollX && ny === this.scrollY) return;
    this.scrollX = nx;
    this.scrollY = ny;
    this.invalidate();
  }

  scrollBy(dx: number, dy: number): void {
    this.scrollTo(this.scrollX + dx, this.scrollY + dy);
  }

  ensureVisible(pos: CellPos): void {
    let { scrollX, scrollY } = this;
    if (pos.row >= this.frozenRows) {
      const top = this.rows.offsetOf(pos.row) - this.frozenH;
      const bottom = top + this.rows.sizeOf(pos.row);
      if (top < scrollY) scrollY = top;
      else if (bottom > scrollY + this.viewH) scrollY = bottom - this.viewH;
    }
    if (pos.col >= this.frozenCols) {
      const left = this.cols.offsetOf(pos.col) - this.frozenW;
      const right = left + this.cols.sizeOf(pos.col);
      if (left < scrollX) scrollX = left;
      else if (right > scrollX + this.viewW) scrollX = right - this.viewW;
    }
    this.scrollTo(scrollX, scrollY);
  }

  // ------------------------------------------------------------- rendering

  invalidate(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.draw();
    });
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.width = Math.floor(rect.width);
    this.height = Math.floor(rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.scrollTo(this.scrollX, this.scrollY);
    this.invalidate();
  }

  draw(): void {
    const t0 = performance.now();
    const { ctx } = this;
    this.frame = { drawMs: 0, visibleCells: 0, blankCells: 0 };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.textBaseline = "middle";

    const rows = this.visibleRows();
    const cols = this.visibleCols();
    const frozenRows: Span = { first: 0, last: this.frozenRows - 1 };
    const frozenCols: Span = { first: 0, last: this.frozenCols - 1 };
    const right = this.width - SCROLLBAR;
    const bottom = this.height - SCROLLBAR;

    // Visible tiles go out first in their own request so a jump paints without
    // waiting for the buffer; the buffered ring follows as a second request.
    const lastFrozenRow = Math.max(0, this.frozenRows - 1);
    const lastFrozenCol = Math.max(0, this.frozenCols - 1);
    this.tiles.ensure(0, lastFrozenRow, cols.first, cols.last);
    this.tiles.ensure(rows.first, rows.last, 0, lastFrozenCol);
    this.tiles.ensure(rows.first, rows.last, cols.first, cols.last);
    const ahead = this.lookahead(t0);
    const buffered = {
      rows: this.extend(this.visibleRows(BUFFER_PX), this.rows, ahead.y),
      cols: this.extend(this.visibleCols(BUFFER_PX), this.cols, ahead.x),
    };
    this.tiles.ensure(0, lastFrozenRow, buffered.cols.first, buffered.cols.last);
    this.tiles.ensure(buffered.rows.first, buffered.rows.last, 0, lastFrozenCol);
    this.tiles.ensure(buffered.rows.first, buffered.rows.last, buffered.cols.first, buffered.cols.last);

    // Body first, frozen panes over it, headers over everything.
    this.drawQuadrant(rows, cols, this.bodyX0, this.bodyY0, right, bottom);
    this.drawQuadrant(frozenRows, cols, this.bodyX0, COL_HEADER_H, right, this.bodyY0);
    this.drawQuadrant(rows, frozenCols, ROW_HEADER_W, this.bodyY0, this.bodyX0, bottom);
    this.drawQuadrant(frozenRows, frozenCols, ROW_HEADER_W, COL_HEADER_H, this.bodyX0, this.bodyY0);
    this.drawSelection(right, bottom);
    this.drawHeaders(rows, cols, right, bottom);
    this.drawFreezeLines(right, bottom);
    this.drawScrollbars();
    this.placeTextInput();

    this.frame.drawMs = performance.now() - t0;
    this.onFrame?.(this.frame);
  }

  /** Extra prefetch distance in the scroll direction: velocity x LOOKAHEAD_MS, capped. */
  private lookahead(now: number): { x: number; y: number } {
    const dt = Math.max(1, now - this.lastDraw.t);
    const vx = (this.scrollX - this.lastDraw.x) / dt;
    const vy = (this.scrollY - this.lastDraw.y) / dt;
    this.lastDraw = { t: now, x: this.scrollX, y: this.scrollY };
    // Smooth so one fast frame does not flood requests and one pause does not drop them.
    this.velocity = { x: this.velocity.x * 0.7 + vx * 0.3, y: this.velocity.y * 0.7 + vy * 0.3 };
    const cap = (v: number) => Math.max(-LOOKAHEAD_MAX_PX, Math.min(LOOKAHEAD_MAX_PX, v * LOOKAHEAD_MS));
    return { x: cap(this.velocity.x), y: cap(this.velocity.y) };
  }

  private extend(range: Span, axis: SparseAxis, px: number): Span {
    if (px === 0) return range;
    const n = Math.ceil(Math.abs(px) / axis.defaultSize);
    return px > 0 ? { first: range.first, last: Math.min(axis.count - 1, range.last + n) } : { first: Math.max(0, range.first - n), last: range.last };
  }

  private tileCell(tiles: Map<number, Tile | undefined>, row: number, col: number): { tile: Tile; i: number } | null {
    const key = Math.floor(row / TILE_ROWS) * 100_000 + Math.floor(col / TILE_COLS);
    let tile = tiles.get(key);
    if (tile === undefined && !tiles.has(key)) {
      tile = this.tiles.get(Math.floor(row / TILE_ROWS), Math.floor(col / TILE_COLS));
      tiles.set(key, tile);
    }
    return tile ? { tile, i: (row % TILE_ROWS) * TILE_COLS + (col % TILE_COLS) } : null;
  }

  private drawQuadrant(rows: Span, cols: Span, x0: number, y0: number, x1: number, y1: number): void {
    if (rows.last < rows.first || cols.last < cols.first || x1 <= x0 || y1 <= y0) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();

    const tiles = new Map<number, Tile | undefined>();
    const merges = this.merges.filter((m) => m.r1 >= rows.first && m.r0 <= rows.last && m.c1 >= cols.first && m.c0 <= cols.last);
    const inMerge = (r: number, c: number) => merges.some((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);

    // Pass 1: fills.
    for (let r = rows.first; r <= rows.last; r++) {
      for (let c = cols.first; c <= cols.last; c++) {
        this.frame.visibleCells++;
        const tc = this.tileCell(tiles, r, c);
        if (!tc) {
          this.frame.blankCells++;
          continue;
        }
        const style = tc.tile.styles[tc.tile.style[tc.i]];
        if (style?.fill && !inMerge(r, c)) {
          ctx.fillStyle = style.fill;
          ctx.fillRect(this.colX(c), this.rowY(r), this.cols.sizeOf(c), this.rows.sizeOf(r));
        }
      }
    }

    // Pass 2: gridlines, skipping merge interiors.
    if (this.showGrid) {
      ctx.beginPath();
      for (let c = cols.first; c <= cols.last + 1; c++) {
        const x = this.crisp(this.colX(c));
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (let r = rows.first; r <= rows.last + 1; r++) {
        const y = this.crisp(this.rowY(r));
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.strokeStyle = "#e3e5e8";
      ctx.lineWidth = 1 / this.dpr;
      ctx.stroke();
    }

    // Pass 3: text, and column-menu buttons on table / filter headers.
    for (let r = rows.first; r <= rows.last; r++) {
      for (let c = cols.first; c <= cols.last; c++) {
        if (inMerge(r, c)) continue;
        const tc = this.tileCell(tiles, r, c);
        if (!tc) continue;
        const text = tc.tile.text[tc.i];
        const kind = tc.tile.kind[tc.i];
        const button = kind & CellKind.HeaderButton ? HEADER_BUTTON_W : 0;
        const x = this.colX(c);
        const y = this.rowY(r);
        const w = this.cols.sizeOf(c);
        const h = this.rows.sizeOf(r);
        if (text) this.drawText(text, kind, tc.tile.styles[tc.tile.style[tc.i]], x, y, w - button, h);
        if (button && w > button) this.drawHeaderButton(kind, x + w - button, y, h);
      }
    }

    // Pass 4: merged blocks, drawn whole over the grid.
    for (const m of merges) {
      const rect = this.blockRect(m.r0, m.c0);
      const tc = this.tileCell(tiles, m.r0, m.c0);
      const style = tc ? tc.tile.styles[tc.tile.style[tc.i]] : undefined;
      ctx.fillStyle = style?.fill ?? "#fff";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      if (this.showGrid) {
        ctx.strokeStyle = "#e3e5e8";
        ctx.lineWidth = 1 / this.dpr;
        ctx.strokeRect(this.crisp(rect.x), this.crisp(rect.y), rect.w, rect.h);
      }
      const text = tc?.tile.text[tc.i];
      if (tc && text) this.drawText(text, tc.tile.kind[tc.i], style, rect.x, rect.y, rect.w, rect.h);
    }

    // Pass 5: borders.
    for (let r = rows.first; r <= rows.last; r++) {
      for (let c = cols.first; c <= cols.last; c++) {
        const tc = this.tileCell(tiles, r, c);
        const style = tc ? tc.tile.styles[tc.tile.style[tc.i]] : undefined;
        if (!style || !(style.top || style.right || style.bottom || style.left)) continue;
        const x = this.colX(c);
        const y = this.rowY(r);
        const w = this.cols.sizeOf(c);
        const h = this.rows.sizeOf(r);
        this.drawEdge(style.top, x, y, x + w, y);
        this.drawEdge(style.bottom, x, y + h, x + w, y + h);
        this.drawEdge(style.left, x, y, x, y + h);
        this.drawEdge(style.right, x + w, y, x + w, y + h);
      }
    }
    ctx.restore();
  }

  private drawText(text: string, kind: number, style: CellStyle | undefined, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const font = style?.font ?? 0;
    const px = Math.round(((style?.size ?? BASE_PT) * 13) / BASE_PT);
    ctx.font = `${font & FontFlag.Italic ? "italic " : ""}${font & FontFlag.Bold ? "600 " : ""}${px}px ${FONT_FAMILY}`;
    ctx.fillStyle = kind & CellKind.Error ? "#c5221f" : style?.color ?? "#1f2328";
    const align = style?.align ?? (kind & CellKind.Number ? "right" : kind & CellKind.Boolean ? "center" : "left");
    const max = w - PAD * 2;
    const lines = font & FontFlag.Wrap ? this.wrap(text, max) : [this.fit(text, max)];
    const lineH = px + 4;
    const top = font & FontFlag.Wrap ? y + PAD + lineH / 2 : y + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.textAlign = align;
    const tx = align === "right" ? x + w - PAD : align === "center" ? x + w / 2 : x + PAD;
    lines.forEach((line, i) => {
      const ly = top + i * lineH;
      ctx.fillText(line, tx, ly);
      if (font & (FontFlag.Underline | FontFlag.Strike)) {
        const lw = ctx.measureText(line).width;
        const lx = align === "right" ? tx - lw : align === "center" ? tx - lw / 2 : tx;
        ctx.fillStyle = ctx.fillStyle as string;
        if (font & FontFlag.Underline) ctx.fillRect(lx, ly + px / 2, lw, 1);
        if (font & FontFlag.Strike) ctx.fillRect(lx, ly, lw, 1);
      }
    });
    ctx.restore();
  }

  private drawHeaderButton(kind: number, x: number, y: number, h: number): void {
    const { ctx } = this;
    const size = Math.min(14, h - 4);
    const bx = x + (HEADER_BUTTON_W - size) / 2;
    const by = y + (h - size) / 2;
    const active = kind & (CellKind.Filtered | CellKind.Sorted);
    ctx.save();
    ctx.fillStyle = active ? "#d2e3fc" : "#ffffff";
    ctx.strokeStyle = active ? "#1a73e8" : "#9aa0a6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx + 0.5, by + 0.5, size - 1, size - 1, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? "#1a73e8" : "#5f6368";
    ctx.font = `10px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    const glyph = kind & CellKind.Sorted ? (kind & CellKind.SortDesc ? "↓" : "↑") : "▾";
    ctx.fillText(glyph, bx + size / 2, by + size / 2 + 0.5);
    if (kind & CellKind.Filtered && kind & CellKind.Sorted) ctx.fillRect(bx + size - 4, by + 1, 3, 3);
    ctx.restore();
  }

  /** Value flags of a cell from the tile cache (0 when not loaded). */
  kindAt(row: number, col: number): number {
    const tile = this.tiles.get(Math.floor(row / TILE_ROWS), Math.floor(col / TILE_COLS));
    return tile ? tile.kind[(row % TILE_ROWS) * TILE_COLS + (col % TILE_COLS)] : 0;
  }

  private drawEdge(edge: Edge, x0: number, y0: number, x1: number, y1: number): void {
    if (!edge) return;
    const [style, color] = edge;
    const { ctx } = this;
    const width = style === "thick" ? 3 : style === "medium" || style.startsWith("medium") ? 2 : 1;
    ctx.save();
    ctx.strokeStyle = color || "#000";
    ctx.lineWidth = width;
    ctx.setLineDash(style === "dotted" ? [1, 2] : style.includes("dash") ? [4, 2] : []);
    ctx.beginPath();
    const off = width % 2 === 1 ? 0.5 : 0;
    ctx.moveTo(Math.round(x0) + (x0 === x1 ? off : 0), Math.round(y0) + (y0 === y1 ? off : 0));
    ctx.lineTo(Math.round(x1) + (x0 === x1 ? off : 0), Math.round(y1) + (y0 === y1 ? off : 0));
    ctx.stroke();
    if (style === "double") {
      ctx.lineWidth = 1;
      ctx.beginPath();
      const d = 2;
      ctx.moveTo(x0 + (x0 === x1 ? d : 0), y0 + (y0 === y1 ? d : 0));
      ctx.lineTo(x1 + (x0 === x1 ? d : 0), y1 + (y0 === y1 ? d : 0));
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSelection(right: number, bottom: number): void {
    const { ctx } = this;
    const { r0, r1, c0, c1 } = this.selection();
    const x = this.colX(c0);
    const y = this.rowY(r0);
    const w = this.colX(c1) + this.cols.sizeOf(c1) - x;
    const h = this.rowY(r1) + this.rows.sizeOf(r1) - y;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ROW_HEADER_W, COL_HEADER_H, right - ROW_HEADER_W, bottom - COL_HEADER_H);
    ctx.clip();
    ctx.fillStyle = "rgba(26, 115, 232, 0.10)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#1a73e8";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    const f = this.blockRect(this.focus.row, this.focus.col);
    ctx.lineWidth = 1;
    ctx.strokeRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.restore();
  }

  private drawHeaders(rows: Span, cols: Span, right: number, bottom: number): void {
    const { ctx } = this;
    const { r0, r1, c0, c1 } = this.selection();
    ctx.fillStyle = "#f6f7f9";
    ctx.fillRect(0, 0, right, COL_HEADER_H);
    ctx.fillRect(0, 0, ROW_HEADER_W, bottom);
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.textAlign = "center";

    const colSpans: [Span, number, number][] = [[cols, this.bodyX0, right], [{ first: 0, last: this.frozenCols - 1 }, ROW_HEADER_W, this.bodyX0]];
    for (const [span, x0, x1] of colSpans) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, COL_HEADER_H);
      ctx.clip();
      for (let c = span.first; c <= span.last; c++) {
        const x = this.colX(c);
        const w = this.cols.sizeOf(c);
        if (w === 0) continue;
        if (c >= c0 && c <= c1) {
          ctx.fillStyle = "#d3e3fd";
          ctx.fillRect(x, 0, w, COL_HEADER_H);
        }
        ctx.fillStyle = "#5f6368";
        ctx.fillText(columnName(c), x + w / 2, COL_HEADER_H / 2);
        ctx.fillStyle = "#dadce0";
        ctx.fillRect(this.crisp(x + w) - 0.5, 0, 1, COL_HEADER_H);
      }
      ctx.restore();
    }

    const rowSpans: [Span, number, number][] = [[rows, this.bodyY0, bottom], [{ first: 0, last: this.frozenRows - 1 }, COL_HEADER_H, this.bodyY0]];
    for (const [span, y0, y1] of rowSpans) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, ROW_HEADER_W, y1 - y0);
      ctx.clip();
      for (let r = span.first; r <= span.last; r++) {
        const y = this.rowY(r);
        const h = this.rows.sizeOf(r);
        if (h === 0) continue;
        if (r >= r0 && r <= r1) {
          ctx.fillStyle = "#d3e3fd";
          ctx.fillRect(0, y, ROW_HEADER_W, h);
        }
        ctx.fillStyle = "#5f6368";
        ctx.fillText(String(r + 1), ROW_HEADER_W / 2, y + h / 2);
        ctx.fillStyle = "#dadce0";
        ctx.fillRect(0, this.crisp(y + h) - 0.5, ROW_HEADER_W, 1);
      }
      ctx.restore();
    }
  }

  private drawFreezeLines(right: number, bottom: number): void {
    const { ctx } = this;
    ctx.fillStyle = "#b8bcc2";
    if (this.frozenRows > 0) ctx.fillRect(0, this.bodyY0 - 1, right, 2);
    if (this.frozenCols > 0) ctx.fillRect(this.bodyX0 - 1, 0, 2, bottom);
  }

  private thumb(axis: "v" | "h"): { pos: number; size: number; track: number } {
    const track = axis === "v" ? this.height - SCROLLBAR : this.width - SCROLLBAR;
    const view = axis === "v" ? this.viewH : this.viewW;
    const content = view + (axis === "v" ? this.maxScrollY : this.maxScrollX);
    const size = Math.max(24, (view / Math.max(content, 1)) * track);
    const max = axis === "v" ? this.maxScrollY : this.maxScrollX;
    const scroll = axis === "v" ? this.scrollY : this.scrollX;
    const pos = max === 0 ? 0 : (scroll / max) * (track - size);
    return { pos, size, track };
  }

  private drawScrollbars(): void {
    const { ctx } = this;
    ctx.fillStyle = "#f1f3f4";
    ctx.fillRect(this.width - SCROLLBAR, 0, SCROLLBAR, this.height);
    ctx.fillRect(0, this.height - SCROLLBAR, this.width, SCROLLBAR);
    ctx.fillStyle = "#bdc1c6";
    const v = this.thumb("v");
    ctx.fillRect(this.width - SCROLLBAR + 2, v.pos, SCROLLBAR - 4, v.size);
    const h = this.thumb("h");
    ctx.fillRect(h.pos, this.height - SCROLLBAR + 2, h.size, SCROLLBAR - 4);
  }

  private crisp(v: number): number {
    return (Math.round(v * this.dpr) + 0.5) / this.dpr;
  }

  private measure(text: string): number {
    const key = `${this.ctx.font}|${text}`;
    let w = this.textWidth.get(key);
    if (w === undefined) {
      if (this.textWidth.size > 50_000) this.textWidth.clear();
      w = this.ctx.measureText(text).width;
      this.textWidth.set(key, w);
    }
    return w;
  }

  /** Text truncated with an ellipsis to fit `max` px; cached per (font, width, text). */
  private fit(text: string, max: number): string {
    if (this.measure(text) <= max) return text;
    const key = `${this.ctx.font}|${max}|${text}`;
    let out = this.fitted.get(key);
    if (out === undefined) {
      if (this.fitted.size > 20_000) this.fitted.clear();
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (this.ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
        else hi = mid - 1;
      }
      out = text.slice(0, lo) + "…";
      this.fitted.set(key, out);
    }
    return out;
  }

  /** Greedy word wrap to `max` px. */
  private wrap(text: string, max: number): string[] {
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (line && this.measure(next) > max) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  // ------------------------------------------------------------- input

  /** Header edge under the pointer, for resizing. */
  private resizeTarget(x: number, y: number): { axis: "col" | "row"; index: number } | null {
    if (y < COL_HEADER_H && x > ROW_HEADER_W) {
      const col = this.colAt(x - RESIZE_GRIP);
      if (col !== null && Math.abs(this.colX(col) + this.cols.sizeOf(col) - x) <= RESIZE_GRIP) return { axis: "col", index: col };
    }
    if (x < ROW_HEADER_W && y > COL_HEADER_H) {
      const row = this.rowAt(y - RESIZE_GRIP);
      if (row !== null && Math.abs(this.rowY(row) + this.rows.sizeOf(row) - y) <= RESIZE_GRIP) return { axis: "row", index: row };
    }
    return null;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 22 : e.deltaMode === 2 ? this.viewH : 1;
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
      this.scrollBy(dx, dy);
    }, { passive: false });

    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const hit = this.hitTest(e.offsetX, e.offsetY);
      // Right-click outside the selection moves it, as in Excel.
      const sel = this.selection();
      if (hit.kind === "cell" && (hit.row < sel.r0 || hit.row > sel.r1 || hit.col < sel.c0 || hit.col > sel.c1)) this.select({ row: hit.row, col: hit.col });
      if (hit.kind === "colHeader" && (hit.col < sel.c0 || hit.col > sel.c1 || sel.r0 !== 0 || sel.r1 !== this.rows.count - 1)) this.selectCols(hit.col, hit.col);
      if (hit.kind === "rowHeader" && (hit.row < sel.r0 || hit.row > sel.r1 || sel.c0 !== 0 || sel.c1 !== this.opts.cols - 1)) this.selectRows(hit.row, hit.row);
      this.onContextMenu(hit, e.clientX, e.clientY);
    });

    c.addEventListener("pointermove", (e) => {
      if (!this.drag) c.style.cursor = this.resizeTarget(e.offsetX, e.offsetY)?.axis === "col" ? "col-resize" : this.resizeTarget(e.offsetX, e.offsetY) ? "row-resize" : "default";
    });

    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Keep the hidden input focused; preventDefault stops the canvas taking focus itself.
      e.preventDefault();
      this.focusCanvas();
      const grip = this.resizeTarget(e.offsetX, e.offsetY);
      if (grip) {
        this.drag = grip.axis === "col"
          ? { mode: "resizeCol", index: grip.index, start: e.offsetX, startSize: this.cols.sizeOf(grip.index) }
          : { mode: "resizeRow", index: grip.index, start: e.offsetY, startSize: this.rows.sizeOf(grip.index) };
        c.setPointerCapture(e.pointerId);
        return;
      }
      const hit = this.hitTest(e.offsetX, e.offsetY);
      if (hit.kind === "vscroll" || hit.kind === "hscroll") {
        const axis = hit.kind === "vscroll" ? "v" : "h";
        const pos = axis === "v" ? e.offsetY : e.offsetX;
        const t = this.thumb(axis);
        if (pos >= t.pos && pos <= t.pos + t.size) {
          this.drag = { mode: axis === "v" ? "vthumb" : "hthumb", startPos: pos, startScroll: axis === "v" ? this.scrollY : this.scrollX };
        } else if (axis === "v") {
          this.scrollBy(0, pos < t.pos ? -this.viewH : this.viewH);
        } else {
          this.scrollBy(pos < t.pos ? -this.viewW : this.viewW, 0);
        }
      } else if (hit.kind === "cell") {
        if (this.kindAt(hit.row, hit.col) & CellKind.HeaderButton) {
          const r = this.cellRect(hit.row, hit.col);
          if (e.offsetX >= r.x + r.w - HEADER_BUTTON_W - 2) {
            this.select({ row: hit.row, col: hit.col });
            this.onHeaderButton(hit.row, hit.col, e.clientX, e.clientY);
            return;
          }
        }
        const m = this.mergeAt(hit.row, hit.col);
        this.focus = m ? { row: m.r0, col: m.c0 } : { row: hit.row, col: hit.col };
        if (!e.shiftKey) this.anchor = { ...this.focus };
        this.drag = { mode: "select" };
        this.onSelect(this.focus);
        this.invalidate();
      } else if (hit.kind === "colHeader") {
        this.selectCols(e.shiftKey ? this.anchor.col : hit.col, hit.col);
        this.drag = { mode: "selectCols" };
      } else if (hit.kind === "rowHeader") {
        this.selectRows(e.shiftKey ? this.anchor.row : hit.row, hit.row);
        this.drag = { mode: "selectRows" };
      } else if (hit.kind === "corner") {
        this.onCommand("selectAll");
      }
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener("pointermove", (e) => {
      const drag = this.drag;
      if (!drag) return;
      if (drag.mode === "resizeCol" || drag.mode === "resizeRow") {
        const axis = drag.mode === "resizeCol" ? this.cols : this.rows;
        const delta = (drag.mode === "resizeCol" ? e.offsetX : e.offsetY) - drag.start;
        axis.setSize(drag.index, Math.max(MIN_SIZE, drag.startSize + delta));
        this.invalidate();
        return;
      }
      if (drag.mode === "select" || drag.mode === "selectRows" || drag.mode === "selectCols") {
        const hit = this.hitTest(clamp(e.offsetX, ROW_HEADER_W + 1, this.width - SCROLLBAR - 1), clamp(e.offsetY, COL_HEADER_H + 1, this.height - SCROLLBAR - 1));
        if (hit.kind !== "cell") return;
        const next = drag.mode === "selectCols" ? { row: this.rows.count - 1, col: hit.col } : drag.mode === "selectRows" ? { row: hit.row, col: this.opts.cols - 1 } : { row: hit.row, col: hit.col };
        if (next.row !== this.focus.row || next.col !== this.focus.col) {
          this.focus = next;
          this.onSelect(this.focus);
          this.invalidate();
        }
        return;
      }
      if (drag.mode !== "vthumb" && drag.mode !== "hthumb") return;
      const axis = drag.mode === "vthumb" ? "v" : "h";
      const t = this.thumb(axis);
      const delta = (axis === "v" ? e.offsetY : e.offsetX) - drag.startPos;
      const max = axis === "v" ? this.maxScrollY : this.maxScrollX;
      const next = drag.startScroll + (delta / Math.max(1, t.track - t.size)) * max;
      if (axis === "v") this.scrollTo(this.scrollX, next);
      else this.scrollTo(next, this.scrollY);
    });

    c.addEventListener("pointerup", (e) => {
      const drag = this.drag;
      this.drag = null;
      c.releasePointerCapture(e.pointerId);
      if (drag?.mode === "resizeCol") this.onResize("col", drag.index, this.cols.sizeOf(drag.index));
      if (drag?.mode === "resizeRow") this.onResize("row", drag.index, this.rows.sizeOf(drag.index));
    });

    c.addEventListener("dblclick", (e) => {
      if (this.hitTest(e.offsetX, e.offsetY).kind === "cell") this.onEditRequest();
    });

    // Typed text arrives through the hidden textarea's input events rather than keydown,
    // so IME composition, mobile keyboards and synthetic text input all start an edit.
    const input = this.textInput;
    input.addEventListener("input", (e) => {
      if ((e as InputEvent).isComposing) return;
      const text = input.value;
      input.value = "";
      // A bare newline is a stray Enter (e.g. from a field that just handed focus over), not typing.
      if (text && !/^[\r\n]+$/.test(text)) this.onEditRequest(text);
    });
    input.addEventListener("compositionend", (e) => {
      input.value = "";
      if (e.data) this.onEditRequest(e.data);
    });
    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain");
      if (text) this.onPasteText(text);
    });

    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      const arrows: Record<string, ArrowDir> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
      if (mod && arrows[e.key]) {
        e.preventDefault();
        this.onJump(arrows[e.key], e.shiftKey);
        return;
      }
      if (mod) {
        const commands: Record<string, Command> = {
          z: e.shiftKey ? "redo" : "undo", y: "redo", c: "copy", x: "cut", a: "selectAll",
          d: "fillDown", r: "fillRight", b: "bold", i: "italic", u: "underline", f: "find",
        };
        const command = commands[e.key.toLowerCase()];
        // Ctrl+V is left to the browser so the paste event delivers clipboard text.
        if (command) {
          e.preventDefault();
          this.onCommand(command);
        }
        return;
      }
      const page = Math.max(1, Math.floor(this.viewH / this.rows.defaultSize));
      const moves: Record<string, [number, number]> = {
        ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
        PageUp: [-page, 0], PageDown: [page, 0],
        // Excel: Enter/Tab move without editing; Shift reverses.
        Enter: [e.shiftKey ? -1 : 1, 0], Tab: [0, e.shiftKey ? -1 : 1],
      };
      if (e.key === "F2") {
        e.preventDefault();
        this.onEditRequest();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.onCommand("clear");
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        this.select({ row: this.focus.row, col: 0 }, e.shiftKey);
        return;
      }
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const extend = e.shiftKey && e.key !== "Enter" && e.key !== "Tab";
      this.moveFocus(move[0], move[1], extend);
    });
  }

  /** Move the focus cell by a delta, optionally extending the selection; scrolls it into view. */
  moveFocus(dRow: number, dCol: number, extend = false): void {
    // Step over merged blocks rather than into their interior.
    const m = this.mergeAt(this.focus.row, this.focus.col);
    const from = m && !extend ? { row: dRow > 0 ? m.r1 : m.r0, col: dCol > 0 ? m.c1 : m.c0 } : this.focus;
    let row = clamp(from.row + dRow, 0, this.rows.count - 1);
    let col = clamp(from.col + dCol, 0, this.opts.cols - 1);
    const landed = !extend && this.mergeAt(row, col);
    if (landed) {
      row = landed.r0;
      col = landed.c0;
    }
    this.select({ row, col }, extend);
  }

  select(pos: CellPos, extend = false): void {
    this.focus = pos;
    if (!extend) this.anchor = { ...pos };
    this.ensureVisible(pos);
    this.onSelect(pos);
    this.invalidate();
  }

  selectRange(range: CellRange): void {
    this.anchor = { row: range.r0, col: range.c0 };
    this.focus = { row: range.r1, col: range.c1 };
    this.onSelect(this.focus);
    this.invalidate();
  }

  selectCols(fromCol: number, toCol: number): void {
    this.anchor = { row: 0, col: fromCol };
    this.focus = { row: this.rows.count - 1, col: toCol };
    this.onSelect(this.focus);
    this.invalidate();
  }

  selectRows(fromRow: number, toRow: number): void {
    this.anchor = { row: fromRow, col: 0 };
    this.focus = { row: toRow, col: this.opts.cols - 1 };
    this.onSelect(this.focus);
    this.invalidate();
  }

  private placeTextInput(): void {
    const r = this.visibleCellRect(this.focus.row, this.focus.col);
    if (r) {
      this.textInput.style.left = `${r.x}px`;
      this.textInput.style.top = `${r.y}px`;
    }
  }

  /** Give the grid keyboard focus (via its hidden text input). */
  focusCanvas(): void {
    this.textInput.focus({ preventScroll: true });
  }
}

export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** "B3" or "B3:D10" (optionally "Sheet!B3") -> 0-based coordinates; null when not a reference. */
export function parseRef(text: string): CellRange | null {
  const m = text.trim().replace(/^.*!/, "").replace(/\$/g, "").toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/);
  if (!m) return null;
  const col = (s: string) => [...s].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = { r: Number(m[2]) - 1, c: col(m[1]) };
  const b = m[3] ? { r: Number(m[4]) - 1, c: col(m[3]) } : a;
  if (a.r < 0 || b.r < 0) return null;
  return { r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
