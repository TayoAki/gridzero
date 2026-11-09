// Shared E2E harness: starts a control plane and workbook host on the given ports,
// signs up a user, and talks to workbooks over HTTP and the sheet socket.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { unpack } from "msgpackr";

export const root = fileURLToPath(new URL("../..", import.meta.url));
const exe = process.platform === "win32" ? ".exe" : "";
export const bin = (name) => join(root, "target", process.env.E2E_RELEASE ? "release" : "debug", name + exe);

export async function waitFor(fn, label, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export class Stack {
  constructor({ controlPort, wbhostPort, wbhostEnv = {} }) {
    this.controlPort = controlPort;
    this.wbhostPort = wbhostPort;
    this.wbhostEnv = wbhostEnv;
    this.base = `http://localhost:${controlPort}`;
    this.secret = "e2e-wb-token-secret-0123456789abcdef";
    this.dataDir = mkdtempSync(join(tmpdir(), "gz-e2e-"));
    this.cookie = "";
  }

  async start() {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    this.control = spawn(process.execPath, ["src/server.ts"], {
      cwd: join(root, "services", "control"),
      env: {
        ...process.env,
        PORT: String(this.controlPort),
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-auth-secret-0123456789abcdef0123",
        BETTER_AUTH_URL: this.base,
        WB_TOKEN_SECRET: this.secret,
        WBHOST_PUBLIC_URL: `ws://localhost:${this.wbhostPort}`,
        WEB_DIST: "",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    await waitFor(() => fetch(`${this.base}/api/v1/health`).then((r) => r.ok), "control plane");
    await this.startWbhost();
    const res = await this.api("POST", "/api/auth/sign-up/email", { name: "E2E", email: `e2e-${Date.now()}-${Math.random()}@example.com`, password: "correct-horse-9" });
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  }

  startWbhost() {
    this.wbhost = spawn(bin("wbhost"), [], {
      env: { ...process.env, PORT: String(this.wbhostPort), DATA_DIR: this.dataDir, WB_TOKEN_SECRET: this.secret, IDLE_EVICT_SECS: "2", RUST_LOG: "warn", ...this.wbhostEnv },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return waitFor(() => fetch(`http://localhost:${this.wbhostPort}/health`).then((r) => r.ok), "wbhost");
  }

  async restartWbhost() {
    const exited = new Promise((r) => this.wbhost.once("exit", r));
    this.wbhost.kill();
    await exited;
    await this.startWbhost();
  }

  stop() {
    this.control?.kill();
    this.wbhost?.kill();
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  async api(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: { "Content-Type": "application/json", Origin: this.base, Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.match(/better-auth\.session_token=[^;]+/)?.[0] ?? this.cookie;
    return res;
  }

  async newWorkbook() {
    const { id } = await (await this.api("POST", "/api/v1/workbooks")).json();
    return id;
  }

  /** Routing grant: {endpoint, token}; `http` is the host's HTTP base for this workbook. */
  async grant(id) {
    const g = await (await this.api("POST", `/api/v1/workbooks/${id}/open`)).json();
    return { ...g, http: g.endpoint.replace(/^ws/, "http").replace(/\/ws$/, "") };
  }

  /** Open a workbook socket; resolves after Welcome. */
  async open(id) {
    const grant = await this.grant(id);
    return Object.assign(await this.openUrl(`${grant.endpoint}?token=${grant.token}`), { grant });
  }

  /** Open a socket by URL; resolves after Welcome. */
  async openUrl(url) {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const replies = new Map();
    const session = { ws };
    let welcome;
    const welcomed = new Promise((r) => (welcome = r));
    ws.onmessage = (ev) => {
      const m = unpack(new Uint8Array(ev.data));
      if (m.t === "Welcome") return welcome(m);
      if (m.t === "Changed") return;
      if (m.t === "Presence") {
        session.presence = m;
        return;
      }
      const pending = replies.get(m.req_id);
      replies.delete(m.req_id);
      if (m.t === "Error") pending?.reject(new Error(`${m.code}: ${m.message}`));
      else pending?.resolve(m.body);
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("socket error"));
    });
    let reqId = 0;
    ws.send(JSON.stringify({ reqId: ++reqId, action: { type: "Hello" } }));
    const state = await welcomed;
    const send = (action) =>
      new Promise((resolve, reject) => {
        const id = ++reqId;
        replies.set(id, { resolve, reject });
        ws.send(JSON.stringify({ reqId: id, action }));
      });
    const close = () => new Promise((r) => { ws.onclose = r; ws.close(); });
    return Object.assign(session, { send, state, close });
  }
}

/** Display texts of one tile as {index: text}. */
export async function tileTexts(s, sheet, tr = 0, tc = 0) {
  const t = await s.send({ type: "GetTiles", sheet, tiles: [[tr, tc]] });
  return Object.fromEntries(t.tiles[0].cells.map(([i, display]) => [i, display]));
}

export function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
