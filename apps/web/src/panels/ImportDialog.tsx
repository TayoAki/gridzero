// File import (PRD FR-16, E32): pick a file or URL, upload it straight to the workbook
// host, preview it with the parse options, then import into cells or a Data Table.

import { useEffect, useRef, useState } from "react";

import type { Action, ImportMode, ImportOptions, ImportPreview, Reply } from "../sheet-socket";
import { useEscape } from "../use-escape";

/** Above this many cells the dialog defaults to a Data Table; cells are capped at 1M (A2). */
const CELLS_DEFAULT_MAX = 200_000;
const CELLS_MAX = 1_000_000;
const COMPRESS_OVER = 4 << 20;

type Stage =
  | { kind: "pick" }
  | { kind: "uploading"; label: string; pct: number | null }
  | { kind: "preview"; preview: ImportPreview }
  | { kind: "importing" };

export interface ImportDialogProps {
  send: (action: Action) => Promise<Reply>;
  uploadTarget: () => Promise<{ base: string; token: string }>;
  /** The selected cell, offered as a destination. */
  cell: { sheet: number; row: number; col: number; label: string };
  onImported: (reply: Extract<Reply, { k: "Imported" }>) => void;
  onClose: () => void;
  /** Start by uploading the sample file that ships with the app. */
  sample?: boolean;
}

const DEFAULT_OPTIONS: ImportOptions = { header: true, separator: null, quote: null, skip_rows: 0 };

export function ImportDialog({ send, uploadTarget, cell, onImported, onClose, sample = false }: ImportDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_OPTIONS);
  const [dest, setDest] = useState<"new" | "cell">("new");
  // The sample goes in as a Data Table, so the agent can total every row of it.
  const [mode, setMode] = useState<ImportMode | null>(sample ? "Table" : null);
  const [dragging, setDragging] = useState(false);
  const importId = useRef<string | null>(null);
  const xhr = useRef<XMLHttpRequest | null>(null);

  const cancelUpload = () => {
    xhr.current?.abort();
    if (importId.current) void send({ type: "CancelImport", import_id: importId.current }).catch(() => {});
    importId.current = null;
  };

  const close = () => {
    if (stage.kind !== "importing") cancelUpload();
    onClose();
  };

  async function preview(opts: ImportOptions) {
    if (!importId.current) return;
    try {
      const reply = await send({ type: "ImportPreview", import_id: importId.current, options: opts });
      if (reply.k === "ImportPreview") {
        setError(null);
        setStage({ kind: "preview", preview: reply.preview });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function uploadFile(file: File) {
    setError(null);
    setName(file.name);
    const id = crypto.randomUUID();
    importId.current = id;
    let body: Blob = file;
    // Compress in the browser so less goes over the network; the host gunzips while staging.
    if (file.size > COMPRESS_OVER && !/\.gz$/i.test(file.name) && "CompressionStream" in window) {
      setStage({ kind: "uploading", label: "Compressing…", pct: null });
      body = await new Response(file.stream().pipeThrough(new CompressionStream("gzip"))).blob();
    }
    try {
      const { base, token } = await uploadTarget();
      const target = `${base}/import?token=${encodeURIComponent(token)}&import_id=${id}&name=${encodeURIComponent(file.name)}`;
      await new Promise<void>((resolve, reject) => {
        const req = new XMLHttpRequest();
        xhr.current = req;
        req.open("POST", target);
        req.upload.onprogress = (e) => e.lengthComputable && setStage({ kind: "uploading", label: "Uploading", pct: e.loaded / e.total });
        req.onload = () => (req.status === 200 ? resolve() : reject(new Error(req.responseText || `upload failed (${req.status})`)));
        req.onerror = () => reject(new Error("upload failed: the workbook host could not be reached"));
        req.onabort = () => reject(new Error("upload cancelled"));
        setStage({ kind: "uploading", label: "Uploading", pct: 0 });
        req.send(body);
      });
      setStage({ kind: "uploading", label: "Reading file…", pct: null });
      await preview(options);
    } catch (e) {
      importId.current = null;
      setError((e as Error).message);
      setStage({ kind: "pick" });
    }
  }

  async function fetchUrl() {
    const u = url.trim();
    if (!u) return;
    setError(null);
    const id = crypto.randomUUID();
    importId.current = id;
    setName(decodeURIComponent(u.split(/[?#]/)[0].split("/").pop() || "download.csv"));
    setStage({ kind: "uploading", label: "Downloading…", pct: null });
    try {
      const { base, token } = await uploadTarget();
      const res = await fetch(`${base}/import_url?token=${encodeURIComponent(token)}&import_id=${id}&url=${encodeURIComponent(u)}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setName(body.name);
      await preview(options);
    } catch (e) {
      importId.current = null;
      setError((e as Error).message);
      setStage({ kind: "pick" });
    }
  }

  // Re-parse the preview when the options change.
  const firstPreview = useRef(true);
  // The sample file is uploaded like any other, so the person sees the same preview and choices.
  const sampled = useRef(false);
  useEffect(() => {
    if (!sample || sampled.current) return;
    sampled.current = true;
    void fetch("/sample-orders.csv")
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("The sample file could not be loaded."))))
      .then((b) => uploadFile(new File([b], "sample-orders.csv", { type: "text/csv" })))
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample]);

  useEffect(() => {
    if (firstPreview.current) {
      firstPreview.current = false;
      return;
    }
    const t = window.setTimeout(() => void preview(options), 250);
    return () => window.clearTimeout(t);
  }, [options]);

  async function doImport(p: ImportPreview) {
    if (!importId.current) return;
    const chosen = mode ?? defaultMode(p);
    setStage({ kind: "importing" });
    try {
      const reply = await send({
        type: "FinalizeImport",
        import_id: importId.current,
        options,
        dest: dest === "new" ? { type: "NewSheet" } : { type: "Cell", sheet: cell.sheet, row: cell.row, col: cell.col },
        mode: chosen,
        name,
      });
      importId.current = null;
      if (reply.k === "Imported") onImported(reply);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setStage({ kind: "preview", preview: p });
    }
  }

  const p = stage.kind === "preview" ? stage.preview : null;
  const cells = p ? ((p.total_rows ?? p.rows.length) + 1) * Math.max(1, p.columns.length) : 0;
  const chosenMode = p ? mode ?? defaultMode(p) : "Table";
  useEscape(close);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog import-dialog" role="dialog" aria-modal="true" aria-label="Import data">
        <header className="dialog-head">
          <h2>{p ? `Import ${name}` : "Import data"}</h2>
          <button className="link-button" onClick={close} aria-label="Close">✕</button>
        </header>

        {error && <p className="error" role="alert">{error}</p>}

        {stage.kind === "pick" && (
          <div className="import-pick">
            <label
              className={`drop-zone${dragging ? " over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) void uploadFile(f);
              }}
            >
              <strong>Drop a file here</strong>
              <span>or choose one — CSV, TSV, TXT, JSONL, Parquet or XLSX (optionally .gz), up to 5 GB</span>
              <input type="file" accept=".csv,.tsv,.txt,.tab,.jsonl,.ndjson,.json,.parquet,.xlsx,.xlsm,.gz" onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
            </label>
            <div className="import-url">
              <input aria-label="File URL" placeholder="Or import from URL: https://…/data.csv" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void fetchUrl()} />
              <button className="secondary" disabled={!url.trim()} onClick={() => void fetchUrl()}>Fetch</button>
            </div>
          </div>
        )}

        {stage.kind === "uploading" && (
          <div className="import-progress" aria-live="polite">
            <span>{stage.label} {name}{stage.pct !== null && ` — ${Math.round(stage.pct * 100)}%`}</span>
            <progress max={1} value={stage.pct ?? undefined} />
            <button className="secondary" onClick={() => { cancelUpload(); setStage({ kind: "pick" }); }}>Cancel</button>
          </div>
        )}

        {stage.kind === "importing" && (
          <div className="import-progress" aria-live="polite">
            <span>Importing {name}… large files take a few seconds per million rows.</span>
            <progress />
          </div>
        )}

        {p && (
          <>
            <div className="import-preview" tabIndex={0} aria-label="Preview">
              <table>
                <thead>
                  <tr>{p.columns.map((c, i) => <th key={i}>{c.name}<small>{c.dtype}</small></th>)}</tr>
                </thead>
                <tbody>
                  {p.rows.slice(0, 50).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
            <p className="import-summary">
              {p.format.toUpperCase()} · {p.total_rows === null ? "?" : `${p.format === "csv" || p.format === "jsonl" ? "≈" : ""}${p.total_rows.toLocaleString()}`} rows · {p.columns.length} columns · {formatBytes(p.bytes)}
            </p>
            <div className="import-options">
              <fieldset>
                <legend>Destination</legend>
                <label><input type="radio" checked={dest === "new"} onChange={() => setDest("new")} /> New sheet</label>
                <label><input type="radio" checked={dest === "cell"} onChange={() => setDest("cell")} /> Selected cell ({cell.label})</label>
              </fieldset>
              <fieldset>
                <legend>Import type</legend>
                <label title={cells > CELLS_MAX ? "Too large for cells" : undefined}>
                  <input type="radio" disabled={cells > CELLS_MAX} checked={chosenMode === "Cells"} onChange={() => setMode("Cells")} /> Import into cells
                </label>
                <label><input type="radio" checked={chosenMode === "Table"} onChange={() => setMode("Table")} /> Data table</label>
              </fieldset>
              <fieldset>
                <legend>Options</legend>
                <label><input type="checkbox" checked={options.header} onChange={(e) => setOptions({ ...options, header: e.target.checked })} /> First row is a header</label>
                {(p.format === "csv") && (
                  <>
                    <label>Separator{" "}
                      <select value={options.separator ?? ""} onChange={(e) => setOptions({ ...options, separator: e.target.value || null })}>
                        <option value="">Autodetect{p.separator ? ` (${sepName(p.separator)})` : ""}</option>
                        <option value=",">Comma</option>
                        <option value="\t">Tab</option>
                        <option value=";">Semicolon</option>
                        <option value="|">Pipe</option>
                      </select>
                    </label>
                    <label>Quote{" "}
                      <select value={options.quote ?? ""} onChange={(e) => setOptions({ ...options, quote: e.target.value || null })}>
                        <option value="">Autodetect (")</option>
                        <option value="'">'</option>
                      </select>
                    </label>
                  </>
                )}
                {p.format !== "parquet" && p.format !== "jsonl" && (
                  <label>Skip rows <input type="number" min={0} max={1000} value={options.skip_rows} onChange={(e) => setOptions({ ...options, skip_rows: Math.max(0, Number(e.target.value) || 0) })} /></label>
                )}
              </fieldset>
            </div>
            <footer className="dialog-foot">
              <button className="secondary" onClick={() => { cancelUpload(); setStage({ kind: "pick" }); }}>Back</button>
              <button className="primary-inline" onClick={() => void doImport(p)}>Import</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function defaultMode(p: ImportPreview): ImportMode {
  const cells = ((p.total_rows ?? p.rows.length) + 1) * Math.max(1, p.columns.length);
  return cells > CELLS_DEFAULT_MAX ? "Table" : "Cells";
}

function sepName(s: string): string {
  return s === "," ? "comma" : s === "\t" ? "tab" : s === ";" ? "semicolon" : s === "|" ? "pipe" : s;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}
