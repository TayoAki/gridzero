// Sheet-channel client (BUILD-SPEC §5.1): JSON actions out, MessagePack frames in.
// Reconnects with backoff, fetching a fresh routing token for each attempt.
// Mirrors crates/protocol; rows, columns and sheets are 0-based.

import { unpack } from "msgpackr";

import type { WireTile } from "./grid/tiles";

export interface Range {
  sheet: number;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export type Direction = "Up" | "Down" | "Left" | "Right";

export type FilterOp = "Eq" | "Ne" | "Gt" | "Ge" | "Lt" | "Le" | "Contains" | "NotContains" | "StartsWith" | "EndsWith" | "Blank" | "NotBlank";
export type ColumnFilter = { type: "Values"; values: string[] } | { type: "Condition"; op: FilterOp; value: string };
export type DataTarget = { type: "Range"; range: Range } | { type: "Table"; table: string };
export interface SortKey {
  col: number;
  desc: boolean;
}
export interface ImportOptions {
  header: boolean;
  separator: string | null;
  quote: string | null;
  skip_rows: number;
}
export type ImportDest = { type: "NewSheet" } | { type: "Cell"; sheet: number; row: number; col: number };
export type ImportMode = "Cells" | "Table";

export type Agg = "Sum" | "Count" | "CountUnique" | "Avg" | "Min" | "Max" | "Median" | "Percentile";
export type DateGroup = "Year" | "Quarter" | "Month" | "Day";
export interface PivotField {
  field: string;
  group: DateGroup | null;
}
export interface PivotValue {
  field: string;
  agg: Agg;
  percentile: number | null;
}
export interface PivotSpec {
  id: string;
  sheet: number;
  row: number;
  col: number;
  source: DataTarget;
  rows: PivotField[];
  columns: PivotField[];
  values: PivotValue[];
  filters: [string, ColumnFilter][];
  totals: boolean;
}
export interface PivotInfo {
  spec: PivotSpec;
  rows: number;
  cols: number;
  error: string | null;
  fields: { name: string; dtype: string }[];
}
export type ChartKind = "Bar" | "Column" | "Line" | "Area" | "Scatter" | "Pie" | "Histogram";
export interface ChartSeries {
  range: Range | null;
  name: string | null;
  kind: ChartKind | null;
  axis: "Left" | "Right";
}
export interface ChartSpec {
  id: string;
  sheet: number;
  row: number;
  col: number;
  w: number;
  h: number;
  kind: ChartKind;
  title: string;
  x: Range | null;
  series: ChartSeries[];
  bins: number | null;
  stacked: boolean;
}
export interface ChartData {
  x: string[];
  series: { name: string; kind: ChartKind; axis: "Left" | "Right"; values: (number | null)[] }[];
  refs: string[];
  errors: string[];
}
export interface SlicerSpec {
  id: string;
  sheet: number;
  row: number;
  col: number;
  target: DataTarget;
  column: number;
  title: string;
}
export interface ValidationSpec {
  id: string;
  range: Range;
  values: string[];
  source: Range | null;
  strict: boolean;
}
export type CondOp = "Eq" | "Ne" | "Gt" | "Ge" | "Lt" | "Le" | "Between" | "NotBetween";
export type CondRule =
  | { type: "CellIs"; op: CondOp; value: string; value2: string | null }
  | { type: "TextContains"; value: string }
  | { type: "Blanks" }
  | { type: "NotBlanks" }
  | { type: "Duplicates" }
  | { type: "Top"; rank: number; bottom: boolean; percent: boolean }
  | { type: "Average"; below: boolean }
  | { type: "Formula"; formula: string }
  | { type: "ColorScale"; min: string; mid: string | null; max: string }
  | { type: "DataBar"; color: string }
  | { type: "IconSet"; set: IconSetKind; reverse: boolean };

export type IconSetKind = "Arrows" | "TrafficLights" | "Flags" | "Symbols";
export interface CondStyle {
  fill: string | null;
  color: string | null;
  bold: boolean;
}
export type BorderKind = "All" | "Inner" | "Outer" | "Top" | "Right" | "Bottom" | "Left" | "None";

export type Action =
  | { type: "Ping" }
  | { type: "GetTiles"; sheet: number; tiles: [number, number][] }
  | { type: "GetCell"; sheet: number; row: number; col: number }
  | { type: "GetSheetMeta"; sheet: number }
  | { type: "CopyRange"; range: Range; cut: boolean }
  | { type: "CtrlJump"; sheet: number; row: number; col: number; dir: Direction }
  | { type: "Find"; sheet: number; row: number; col: number; text: string }
  | { type: "SelectionStats"; range: Range }
  | { type: "ListNames" }
  | { type: "UpdateCell"; sheet: number; row: number; col: number; raw: string }
  | { type: "PasteText"; sheet: number; row: number; col: number; text: string }
  | { type: "PasteInternal"; sheet: number; row: number; col: number }
  | { type: "ClearRange"; range: Range; formats: boolean }
  | { type: "Fill"; source: Range; to_row: number | null; to_col: number | null }
  | { type: "InsertRows" | "DeleteRows"; sheet: number; row: number; count: number }
  | { type: "InsertCols" | "DeleteCols"; sheet: number; col: number; count: number }
  | { type: "Undo" }
  | { type: "Redo" }
  | { type: "SetStyle"; range: Range; path: string; value: string }
  | { type: "SetBorder"; range: Range; kind: BorderKind; style: string; color: string }
  | { type: "Merge" | "Unmerge"; range: Range }
  | { type: "SetColWidth"; sheet: number; c0: number; c1: number; width: number }
  | { type: "SetRowHeight"; sheet: number; r0: number; r1: number; height: number }
  | { type: "Freeze"; sheet: number; rows: number; cols: number }
  | { type: "SetGridlines"; sheet: number; show: boolean }
  | { type: "ReplaceAll"; sheet: number; find: string; replace: string }
  | { type: "AddSheet" }
  | { type: "RenameSheet"; sheet: number; name: string }
  | { type: "DeleteSheet" | "DuplicateSheet"; sheet: number }
  | { type: "MoveSheet"; sheet: number; to: number }
  | { type: "SetSheetColor"; sheet: number; color: string }
  | { type: "SetSheetHidden"; sheet: number; hidden: boolean }
  | { type: "CreateName"; name: string; scope: number | null; formula: string }
  | { type: "DeleteName"; name: string; scope: number | null }
  | { type: "ImportPreview"; import_id: string; options: ImportOptions }
  | { type: "CancelImport"; import_id: string }
  | { type: "FinalizeImport"; import_id: string; options: ImportOptions; dest: ImportDest; mode: ImportMode; name: string }
  | { type: "DistinctValues"; target: DataTarget; col: number; search: string | null; limit: number }
  | { type: "SortRange"; range: Range; keys: SortKey[]; header: boolean }
  | { type: "SetFilter"; target: DataTarget; col: number; filter: ColumnFilter | null }
  | { type: "ClearFilters"; target: DataTarget }
  | { type: "SortTable"; table: string; keys: SortKey[] }
  | { type: "AddComputedColumn"; table: string; name: string; expr: string }
  | { type: "UpdateComputedColumn"; table: string; col: number; name: string; expr: string }
  | { type: "DeleteTableColumn"; table: string; col: number }
  | { type: "SetTableColumnHidden"; table: string; col: number; hidden: boolean }
  | { type: "RenameTable"; table: string; name: string }
  | { type: "DeleteTable"; table: string }
  | { type: "ExplodeTable"; table: string }
  | { type: "RemoveDuplicates"; target: DataTarget; cols: number[]; header: boolean }
  | { type: "TextToColumns"; range: Range; delimiter: string }
  | { type: "CreatePivot"; spec: PivotSpec; new_sheet: boolean }
  | { type: "UpdatePivot"; spec: PivotSpec }
  | { type: "GetFields"; source: DataTarget }
  | { type: "CreateChart" | "UpdateChart"; spec: ChartSpec }
  | { type: "GetChart"; id: string }
  | { type: "CreateSlicer" | "UpdateSlicer"; spec: SlicerSpec }
  | { type: "DrillDown"; sheet: number; row: number; col: number }
  | { type: "DeleteObject"; id: string }
  | { type: "SetValidation"; spec: ValidationSpec }
  | { type: "GetChoices"; sheet: number; row: number; col: number }
  | { type: "AddCondFormat"; range: Range; rule: CondRule; style: CondStyle }
  | { type: "DeleteCondFormat"; sheet: number; index: number }
  | { type: "ListCondFormats"; sheet: number };

export interface SheetInfo {
  id: number;
  name: string;
  color: string | null;
  hidden: boolean;
}

export interface TableColumnInfo {
  name: string;
  dtype: string;
  expr: string | null;
  hidden: boolean;
  filter: ColumnFilter | null;
  sort: boolean | null;
}

export interface TableInfo {
  id: string;
  name: string;
  sheet: number;
  row: number;
  col: number;
  rows: number;
  total_rows: number;
  columns: TableColumnInfo[];
  source: string;
}

export interface RangeFilterInfo {
  range: Range;
  filters: [number, ColumnFilter][];
}

export interface ImportPreview {
  format: string;
  separator: string | null;
  columns: { name: string; dtype: string }[];
  rows: string[][];
  total_rows: number | null;
  bytes: number;
}

export interface SheetMeta {
  sheet: number;
  frozen_rows: number;
  frozen_cols: number;
  default_col_width: number;
  default_row_height: number;
  col_widths: [number, number][];
  row_heights: [number, number][];
  merges: Range[];
  show_grid: boolean;
  row_count: number;
  tables: TableInfo[];
  filters: RangeFilterInfo[];
  pivots: PivotInfo[];
  charts: ChartSpec[];
  slicers: { spec: SlicerSpec; column_name: string; filter: ColumnFilter | null }[];
  validations: ValidationSpec[];
}

export type Reply =
  | { k: "Ok" }
  | { k: "Pong" }
  | { k: "Tiles"; sheet: number; tiles: WireTile[] }
  | { k: "Cell"; sheet: number; row: number; col: number; raw: string }
  | { k: "SheetMeta"; meta: SheetMeta }
  | { k: "Text"; text: string }
  | { k: "Position"; sheet: number; row: number; col: number }
  | { k: "NotFound" }
  | { k: "Stats"; count: number; numbers: number; sum: number; min: number | null; max: number | null }
  | { k: "Names"; names: { name: string; scope: number | null; formula: string }[] }
  | { k: "ImportPreview"; preview: ImportPreview }
  | { k: "Imported"; sheet: number; row: number; col: number; rows: number; cols: number; table: string | null }
  | { k: "Distinct"; values: [string, number][]; total: number }
  | { k: "Removed"; removed: number }
  | { k: "Created"; id: string; sheet: number }
  | { k: "Fields"; columns: { name: string; dtype: string }[] }
  | { k: "Chart"; data: ChartData }
  | { k: "Choices"; values: string[]; strict: boolean }
  | { k: "CondFormats"; list: { index: number; range: string; summary: string }[] };

export interface DocState {
  seq: number;
  sheets: SheetInfo[];
  can_undo: boolean;
  can_redo: boolean;
}

type ServerMsg =
  | ({ t: "Welcome"; role: string } & DocState)
  | { t: "Reply"; req_id: number; seq: number; body: Reply }
  | { t: "Error"; req_id: number; code: string; message: string }
  | ({ t: "Changed" } & DocState);

export interface Grant {
  endpoint: string;
  token: string;
}

type Status = "connecting" | "open" | "closed";

export class SheetSocket {
  status: Status = "connecting";
  role = "viewer";
  onWelcome: (state: DocState) => void = () => {};
  onChanged: (state: DocState) => void = () => {};
  onStatus: (status: Status) => void = () => {};

  private ws: WebSocket | null = null;
  private reqId = 0;
  private waiting = new Map<number, { resolve: (m: Reply) => void; reject: (e: Error) => void }>();
  private closedByUser = false;
  private retries = 0;
  private ping: number | undefined;

  constructor(private grant: () => Promise<Grant>) {
    void this.connect();
  }

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    let grant: Grant;
    try {
      grant = await this.grant();
    } catch {
      return this.scheduleReconnect();
    }
    if (this.closedByUser) return;
    const ws = new WebSocket(`${grant.endpoint}?token=${encodeURIComponent(grant.token)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.setStatus("open");
      // Welcome carries no request id, so Hello is fire-and-forget and handled in receive().
      ws.send(JSON.stringify({ reqId: ++this.reqId, action: { type: "Hello" } }));
      this.ping = window.setInterval(() => this.send({ type: "Ping" }).catch(() => {}), 25_000);
    };
    ws.onmessage = (ev) => this.receive(unpack(new Uint8Array(ev.data as ArrayBuffer)) as ServerMsg);
    ws.onclose = () => {
      window.clearInterval(this.ping);
      for (const { reject } of this.waiting.values()) reject(new Error("connection closed"));
      this.waiting.clear();
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus("closed");
    const delay = Math.min(10_000, 500 * 2 ** this.retries++);
    window.setTimeout(() => void this.connect(), delay);
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.onStatus(status);
  }

  private receive(msg: ServerMsg): void {
    if (msg.t === "Changed") {
      this.onChanged(msg);
      return;
    }
    if (msg.t === "Welcome") {
      this.role = msg.role;
      this.onWelcome(msg);
      return;
    }
    const pending = this.waiting.get(msg.req_id);
    if (!pending) return;
    this.waiting.delete(msg.req_id);
    if (msg.t === "Error") pending.reject(new Error(msg.message));
    else pending.resolve(msg.body);
  }

  send(action: Action): Promise<Reply> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.waiting.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ reqId, action }));
    });
  }

  /** HTTP base and a fresh routing token for this workbook's host, for file uploads. */
  async uploadTarget(): Promise<{ base: string; token: string }> {
    const grant = await this.grant();
    const base = grant.endpoint.replace(/^ws/, "http").replace(/\/ws$/, "");
    return { base, token: grant.token };
  }

  private charts = new Map<string, { etag: string; data: ChartData }>();

  /** A chart's evaluated series over HTTP; an unchanged workbook answers 304 from its ETag. */
  async chartData(id: string): Promise<ChartData> {
    const { base, token } = await this.uploadTarget();
    const cached = this.charts.get(id);
    const res = await fetch(`${base}/chart/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`, {
      headers: cached ? { "If-None-Match": cached.etag } : {},
    });
    if (res.status === 304 && cached) return cached.data;
    if (!res.ok) throw new Error((await res.text()) || `chart request failed (${res.status})`);
    const data = (await res.json()) as ChartData;
    const etag = res.headers.get("ETag");
    if (etag) this.charts.set(id, { etag, data });
    return data;
  }

  close(): void {
    this.closedByUser = true;
    window.clearInterval(this.ping);
    this.ws?.close();
  }
}
