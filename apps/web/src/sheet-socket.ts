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
  | { type: "DeleteName"; name: string; scope: number | null };

export interface SheetInfo {
  id: number;
  name: string;
  color: string | null;
  hidden: boolean;
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
  | { k: "Stats"; count: number; numbers: number; sum: number }
  | { k: "Names"; names: { name: string; scope: number | null; formula: string }[] };

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

  close(): void {
    this.closedByUser = true;
    window.clearInterval(this.ping);
    this.ws?.close();
  }
}
