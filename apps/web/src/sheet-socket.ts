// Sheet-channel client (BUILD-SPEC §5.1): JSON actions out, MessagePack frames in.
// Reconnects with backoff, fetching a fresh routing token for each attempt.

import { unpack } from "msgpackr";

import type { WireTile } from "./grid/tiles";

export type Action =
  | { type: "Ping" }
  | { type: "GetTiles"; sheet: number; tiles: [number, number][] }
  | { type: "GetCell"; sheet: number; row: number; col: number }
  | { type: "UpdateCell"; sheet: number; row: number; col: number; raw: string };

export type ServerMsg =
  | { t: "Welcome"; seq: number; sheets: { id: number; name: string }[]; role: string }
  | { t: "Ack"; req_id: number; seq: number }
  | { t: "Error"; req_id: number; code: string; message: string }
  | { t: "Tiles"; req_id: number; seq: number; sheet: number; tiles: WireTile[] }
  | { t: "Cell"; req_id: number; sheet: number; row: number; col: number; raw: string }
  | { t: "Changed"; seq: number }
  | { t: "Pong"; req_id: number };

export interface Grant {
  endpoint: string;
  token: string;
}

type Status = "connecting" | "open" | "closed";

export class SheetSocket {
  status: Status = "connecting";
  onWelcome: (msg: Extract<ServerMsg, { t: "Welcome" }>) => void = () => {};
  onChanged: (seq: number) => void = () => {};
  onStatus: (status: Status) => void = () => {};

  private ws: WebSocket | null = null;
  private reqId = 0;
  private waiting = new Map<number, { resolve: (m: ServerMsg) => void; reject: (e: Error) => void }>();
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
      this.onChanged(msg.seq);
      return;
    }
    if (msg.t === "Welcome") {
      this.onWelcome(msg);
      return;
    }
    const pending = this.waiting.get(msg.req_id);
    if (!pending) return;
    this.waiting.delete(msg.req_id);
    if (msg.t === "Error") pending.reject(new Error(`${msg.code}: ${msg.message}`));
    else pending.resolve(msg);
  }

  send(action: Action): Promise<ServerMsg> {
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
