// Canvas grid renderer for server-served viewports (BUILD-SPEC D6, §6).
// Promoted from spike S2 (spikes/s2_grid); see docs/spikes/S2-canvas-grid.md.
// Scrolling happens in logical pixel space with custom scrollbars because a
// 1M-row sheet is taller than any native scroll container may be.

import { SparseAxis } from "./axis";
import { CellFlag, TILE_COLS, TILE_ROWS, TileCache } from "./tiles";
import type { Tile } from "./tiles";

export const ROW_HEADER_W = 56;
export const COL_HEADER_H = 22;
export const SCROLLBAR = 12;
const BUFFER_PX = 440; // matches the reference client's viewport buffer (PRD E7)
const LOOKAHEAD_MS = 250; // prefetch this far ahead of the current scroll velocity
const LOOKAHEAD_MAX_PX = 8_000;
const FONT = "13px system-ui, -apple-system, Segoe UI, sans-serif";
const PAD = 4;

export interface GridOptions {
  rows: number;
  cols: number;
  frozenRows: number;
  frozenCols: number;
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

interface Range {
  first: number;
  last: number;
}

export class CanvasGrid {
  readonly rows: SparseAxis;
  readonly cols: SparseAxis;
  scrollX = 0;
  scrollY = 0;
  anchor: CellPos = { row: 0, col: 0 };
  focus: CellPos = { row: 0, col: 0 };
  onFrame: ((stats: FrameStats) => void) | null = null;
  /** Focus cell moved (click, keyboard, or `select`). */
  onSelect: (focus: CellPos) => void = () => {};
  /** User asked to edit the focus cell: `initial` is a typed character, or undefined for F2/double-click. */
  onEditRequest: (initial?: string) => void = () => {};
  /** Delete/Backspace on the selection. */
  onClear: () => void = () => {};

  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly textInput: HTMLTextAreaElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 1;
  private frameRequested = false;
  private drag: { mode: "select" } | { mode: "vthumb" | "hthumb"; startPos: number; startScroll: number } | null = null;
  private textWidth = new Map<string, number>();
  private fitted = new Map<string, string>();
  private frame: FrameStats = { drawMs: 0, visibleCells: 0, blankCells: 0 };
  private lastDraw = { t: 0, x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };

  constructor(private readonly host: HTMLElement, private readonly tiles: TileCache, readonly opts: GridOptions) {
    this.rows = new SparseAxis(opts.rows, 22);
    this.cols = new SparseAxis(opts.cols, 100);
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

  // ------------------------------------------------------------- geometry

  private get frozenW(): number {
    return this.cols.offsetOf(this.opts.frozenCols);
  }
  private get frozenH(): number {
    return this.rows.offsetOf(this.opts.frozenRows);
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
    return col < this.opts.frozenCols
      ? ROW_HEADER_W + this.cols.offsetOf(col)
      : this.bodyX0 + this.cols.offsetOf(col) - this.frozenW - this.scrollX;
  }

  rowY(row: number): number {
    return row < this.opts.frozenRows
      ? COL_HEADER_H + this.rows.offsetOf(row)
      : this.bodyY0 + this.rows.offsetOf(row) - this.frozenH - this.scrollY;
  }

  cellRect(row: number, col: number): { x: number; y: number; w: number; h: number } {
    return { x: this.colX(col), y: this.rowY(row), w: this.cols.sizeOf(col), h: this.rows.sizeOf(row) };
  }

  /** The on-screen part of a cell, clipped to its pane; null when fully hidden. */
  visibleCellRect(row: number, col: number): { x: number; y: number; w: number; h: number } | null {
    const r = this.cellRect(row, col);
    const [px0, px1] = col < this.opts.frozenCols ? [ROW_HEADER_W, this.bodyX0] : [this.bodyX0, this.width - SCROLLBAR];
    const [py0, py1] = row < this.opts.frozenRows ? [COL_HEADER_H, this.bodyY0] : [this.bodyY0, this.height - SCROLLBAR];
    const x0 = Math.max(r.x, px0);
    const x1 = Math.min(r.x + r.w, px1);
    const y0 = Math.max(r.y, py0);
    const y1 = Math.min(r.y + r.h, py1);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Scrollable (non-frozen) indices intersecting the view, extended by `pad` px each side. */
  private scrollRange(axis: SparseAxis, frozen: number, frozenPx: number, scroll: number, view: number, pad = 0): Range {
    const first = Math.max(frozen, axis.indexAt(frozenPx + scroll - pad));
    const last = Math.min(axis.count - 1, axis.indexAt(frozenPx + scroll + view + pad));
    return { first, last };
  }

  visibleRows(pad = 0): Range {
    return this.scrollRange(this.rows, this.opts.frozenRows, this.frozenH, this.scrollY, this.viewH, pad);
  }

  visibleCols(pad = 0): Range {
    return this.scrollRange(this.cols, this.opts.frozenCols, this.frozenW, this.scrollX, this.viewW, pad);
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
    if (pos.row >= this.opts.frozenRows) {
      const top = this.rows.offsetOf(pos.row) - this.frozenH;
      const bottom = top + this.rows.sizeOf(pos.row);
      if (top < scrollY) scrollY = top;
      else if (bottom > scrollY + this.viewH) scrollY = bottom - this.viewH;
    }
    if (pos.col >= this.opts.frozenCols) {
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
    ctx.font = FONT;
    ctx.textBaseline = "middle";

    const rows = this.visibleRows();
    const cols = this.visibleCols();
    const frozenRows: Range = { first: 0, last: this.opts.frozenRows - 1 };
    const frozenCols: Range = { first: 0, last: this.opts.frozenCols - 1 };
    const right = this.width - SCROLLBAR;
    const bottom = this.height - SCROLLBAR;

    // Visible tiles go out first in their own request so a jump paints without
    // waiting for the buffer; the buffered ring follows as a second request.
    const lastFrozenRow = Math.max(0, this.opts.frozenRows - 1);
    const lastFrozenCol = Math.max(0, this.opts.frozenCols - 1);
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

  private extend(range: Range, axis: SparseAxis, px: number): Range {
    if (px === 0) return range;
    const rows = Math.ceil(Math.abs(px) / axis.defaultSize);
    return px > 0
      ? { first: range.first, last: Math.min(axis.count - 1, range.last + rows) }
      : { first: Math.max(0, range.first - rows), last: range.last };
  }

  private drawQuadrant(rows: Range, cols: Range, x0: number, y0: number, x1: number, y1: number): void {
    if (rows.last < rows.first || cols.last < cols.first || x1 <= x0 || y1 <= y0) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();

    // Tiles for the current tile-row, fetched once per tile rather than per cell.
    const tc0 = Math.floor(cols.first / TILE_COLS);
    let rowTiles: (Tile | undefined)[] = [];
    let rowTileIndex = -1;
    for (let r = rows.first; r <= rows.last; r++) {
      const y = this.rowY(r);
      const h = this.rows.sizeOf(r);
      const tr = Math.floor(r / TILE_ROWS);
      if (tr !== rowTileIndex) {
        rowTileIndex = tr;
        rowTiles = [];
        for (let tc = tc0; tc <= Math.floor(cols.last / TILE_COLS); tc++) rowTiles.push(this.tiles.get(tr, tc));
      }
      for (let c = cols.first; c <= cols.last; c++) {
        this.frame.visibleCells++;
        const tile = rowTiles[Math.floor(c / TILE_COLS) - tc0];
        if (!tile) {
          this.frame.blankCells++;
          continue;
        }
        const i = (r % TILE_ROWS) * TILE_COLS + (c % TILE_COLS);
        const text = tile.text[i];
        if (!text) continue;
        const x = this.colX(c);
        const w = this.cols.sizeOf(c);
        const flags = tile.flags[i];
        if (flags & CellFlag.Bold) ctx.font = `600 ${FONT}`;
        ctx.fillStyle = flags & CellFlag.Error ? "#c5221f" : "#1f2328";
        const shown = this.fit(text, w - PAD * 2);
        if (flags & CellFlag.Number) {
          ctx.textAlign = "right";
          ctx.fillText(shown, x + w - PAD, y + h / 2);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(shown, x + PAD, y + h / 2);
        }
        if (flags & CellFlag.Bold) ctx.font = FONT;
      }
    }

    // Gridlines in one path.
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
    ctx.restore();
  }

  private selectionBounds(): { r0: number; r1: number; c0: number; c1: number } {
    return {
      r0: Math.min(this.anchor.row, this.focus.row),
      r1: Math.max(this.anchor.row, this.focus.row),
      c0: Math.min(this.anchor.col, this.focus.col),
      c1: Math.max(this.anchor.col, this.focus.col),
    };
  }

  private drawSelection(right: number, bottom: number): void {
    const { ctx } = this;
    const { r0, r1, c0, c1 } = this.selectionBounds();
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
    const f = this.cellRect(this.focus.row, this.focus.col);
    ctx.lineWidth = 1;
    ctx.strokeRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
    ctx.restore();
  }

  private drawHeaders(rows: Range, cols: Range, right: number, bottom: number): void {
    const { ctx } = this;
    const { r0, r1, c0, c1 } = this.selectionBounds();
    ctx.fillStyle = "#f6f7f9";
    ctx.fillRect(0, 0, right, COL_HEADER_H);
    ctx.fillRect(0, 0, ROW_HEADER_W, bottom);
    ctx.font = "12px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";

    const colRanges: [Range, number, number][] = [
      [cols, this.bodyX0, right],
      [{ first: 0, last: this.opts.frozenCols - 1 }, ROW_HEADER_W, this.bodyX0],
    ];
    for (const [range, x0, x1] of colRanges) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, COL_HEADER_H);
      ctx.clip();
      for (let c = range.first; c <= range.last; c++) {
        const x = this.colX(c);
        const w = this.cols.sizeOf(c);
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

    const rowRanges: [Range, number, number][] = [
      [rows, this.bodyY0, bottom],
      [{ first: 0, last: this.opts.frozenRows - 1 }, COL_HEADER_H, this.bodyY0],
    ];
    for (const [range, y0, y1] of rowRanges) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, ROW_HEADER_W, y1 - y0);
      ctx.clip();
      for (let r = range.first; r <= range.last; r++) {
        const y = this.rowY(r);
        const h = this.rows.sizeOf(r);
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
    ctx.font = FONT;
  }

  private drawFreezeLines(right: number, bottom: number): void {
    const { ctx } = this;
    ctx.fillStyle = "#b8bcc2";
    if (this.opts.frozenRows > 0) ctx.fillRect(0, this.bodyY0 - 1, right, 2);
    if (this.opts.frozenCols > 0) ctx.fillRect(this.bodyX0 - 1, 0, 2, bottom);
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
    let w = this.textWidth.get(text);
    if (w === undefined) {
      if (this.textWidth.size > 50_000) this.textWidth.clear();
      w = this.ctx.measureText(text).width;
      this.textWidth.set(text, w);
    }
    return w;
  }

  /** Text truncated with an ellipsis to fit `max` px; cached per (width, text). */
  private fit(text: string, max: number): string {
    if (this.measure(text) <= max) return text;
    const key = `${max}|${text}`;
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

  // ------------------------------------------------------------- input

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 22 : e.deltaMode === 2 ? this.viewH : 1;
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
      this.scrollBy(dx, dy);
    }, { passive: false });

    c.addEventListener("pointerdown", (e) => {
      // Keep the hidden input focused; preventDefault stops the canvas taking focus itself.
      e.preventDefault();
      this.focusCanvas();
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
        this.focus = { row: hit.row, col: hit.col };
        if (!e.shiftKey) this.anchor = { ...this.focus };
        this.drag = { mode: "select" };
        this.onSelect(this.focus);
        this.invalidate();
      }
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      if (this.drag.mode === "select") {
        const hit = this.hitTest(clamp(e.offsetX, ROW_HEADER_W, this.width - SCROLLBAR - 1), clamp(e.offsetY, COL_HEADER_H, this.height - SCROLLBAR - 1));
        if (hit.kind === "cell" && (hit.row !== this.focus.row || hit.col !== this.focus.col)) {
          this.focus = { row: hit.row, col: hit.col };
          this.onSelect(this.focus);
          this.invalidate();
        }
        return;
      }
      const axis = this.drag.mode === "vthumb" ? "v" : "h";
      const t = this.thumb(axis);
      const delta = (axis === "v" ? e.offsetY : e.offsetX) - this.drag.startPos;
      const max = axis === "v" ? this.maxScrollY : this.maxScrollX;
      const next = this.drag.startScroll + (delta / Math.max(1, t.track - t.size)) * max;
      if (axis === "v") this.scrollTo(this.scrollX, next);
      else this.scrollTo(next, this.scrollY);
    });

    c.addEventListener("pointerup", (e) => {
      this.drag = null;
      c.releasePointerCapture(e.pointerId);
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
      if (text) this.onEditRequest(text);
    });
    input.addEventListener("compositionend", (e) => {
      input.value = "";
      if (e.data) this.onEditRequest(e.data);
    });

    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const page = Math.max(1, Math.floor(this.viewH / 22));
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
        this.onClear();
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
    this.select({
      row: clamp(this.focus.row + dRow, 0, this.opts.rows - 1),
      col: clamp(this.focus.col + dCol, 0, this.opts.cols - 1),
    }, extend);
  }

  select(pos: CellPos, extend = false): void {
    this.focus = pos;
    if (!extend) this.anchor = { ...pos };
    this.ensureVisible(pos);
    this.onSelect(pos);
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
