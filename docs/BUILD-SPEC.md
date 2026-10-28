# GridZero Build Spec v1

*The engineering build plan for a Row Zero–class cloud spreadsheet.*
Source of requirements: [RowZero-Clone-PRD.md](RowZero-Clone-PRD.md). Evidence IDs (E1–E32) refer to that document's evidence ledger.
Author: tayom · Date: 2026-10-27 · Status: Ready for kickoff

---

## 1. Scope of this document

This spec turns the PRD into decisions, interfaces, milestones and pass/fail acceptance criteria. Anything not listed in §10 (MVP scope) is **out of scope for MVP**, even if the PRD mentions it.

**MVP definition:** a team of up to 3 users can:
- import a 5M-row CSV/Parquet/XLSX file;
- analyze it with Excel-style formulas, data tables, pivots, charts and slicers;
- collaborate in real time, share by email or link, and restore old versions;
- use Python custom functions and an AI agent;
- query a Postgres or Snowflake database into a refreshable connected table.

All of this runs in one AWS region, on Free and Pro plans.

---

## 2. Technology decisions

| # | Area | Decision | Alternatives rejected | Why |
|---|---|---|---|---|
| D1 | Cell formula engine | **IronCalc** (Rust, Apache-2.0), forked and vendored as `crates/ironcalc` | Writing our own (6+ months); HyperFormula (JS, GPL/commercial, wrong runtime) | Excel-compatible Rust engine that runs natively on the server and compiles to WASM for the client. **Gated by Spike S1 (§11).** |
| D2 | Data Tables / big data | **Polars** (lazy API) on **Arrow**, with Parquet persistence | DataFusion (stronger SQL, heavier); DuckDB (C++ embedding) | Fastest DataFrame engine in Rust; native Parquet/CSV/JSON readers; matches the reference's polars marshalling (E14) |
| D3 | XLSX import | **calamine** (MIT) | umya-spreadsheet | Fast, read-only, handles large sheets |
| D4 | Workbook server | **Rust**: tokio + axum (WebSocket + HTTP). **One actor per workbook**, several actors per host process | A process or VM per workbook (deferred to post-MVP) | Gets the "dedicated workbook" model (E5) without VM orchestration in the MVP. Each actor owns its state, so there are no locks. |
| D5 | Shared core crate | `crates/grid_core`: references, A1 parsing, range math, number formats, formula tokenizer/highlighter. Builds for the server (native) and the client (`wasm-bindgen`). | Duplicating the logic in TypeScript | Mirrors the reference (E2/E3), so client and server never disagree on references or formats |
| D6 | Client | **React 18 + TypeScript + Vite**, a **custom canvas grid renderer**, CodeMirror 6 (formula bar and code editor), ECharts | Glide Data Grid (assumes client-side data, last pushed Jan 2026) | The grid has to render server-sent viewport tiles and floating Data Table, chart and slicer overlays. A custom renderer is about 3k lines of code and fully under our control. |
| D7 | Wire protocol | Client→server: **JSON actions**. Server→client: **MessagePack** frames. | Protobuf/FlatBuffers | Debuggable requests; compact binary responses (the reference does the same, E6); no schema compiler needed |
| D8 | Control plane | **TypeScript (Node 22, Hono)** + **Postgres 16** + Drizzle ORM | Rust for everything | CRUD-heavy, and it shares the AI SDK runtime |
| D9 | AI agent | **Vercel AI SDK** (TS) + Anthropic Claude (latest Sonnet as default; selectable). A single `run_python` tool runs in the workbook's Python sandbox against the `gridzero` SDK. | Many fine-grained tools | Mirrors the reference (E17). The model gets loops and verification, and the call log keeps it auditable. |
| D10 | Python runtime | CPython 3.12 in a **per-workbook sandbox container** (gVisor `runsc`), with Arrow IPC over a Unix socket to the workbook actor. No network by default. | Pyodide (too slow for big data); in-process Python (unsafe) | Isolation, plus zero-copy DataFrames |
| D11 | Code editor sync | Yjs + y-codemirror.next over a `code` WebSocket channel | Last-write-wins | Matches E21; collaborative editing for free |
| D12 | Storage | S3: workbook snapshots, op-log segments and Parquet table files. Postgres: metadata only. | Storing cells in Postgres | Snapshot + op-log replay gives fast rehydrate and gives version history for free (E30) |
| D13 | Auth | Better-Auth (email + Google OAuth) in the control plane. Workbook access uses short-lived signed **routing tokens** (JWT, 10 min) | Auth0 | Self-hosted and cheap; the token format mirrors E22 |
| D14 | Infra | AWS us-east-1: ECS Fargate (control plane), EC2 ASG (workbook hosts), RDS Postgres, S3, CloudFront (client) | Kubernetes | Least operational load for a small team |
| D15 | Observability | Sentry (client and server), OpenTelemetry → Grafana Cloud, structured JSON logs | — | — |
| D16 | Billing | Stripe Checkout + Billing Portal | — | Free and Pro only in the MVP |

---

## 3. System architecture

```
                 CloudFront (SPA, WASM)
                        │
 Browser ──HTTPS──► Control Plane (Hono/TS) ──► Postgres (users, workbooks, shares, versions, connections, ai_threads)
    │                   │  POST /api/v1/workbooks/:id/open → {endpoint, routingToken, region}
    │                   │  POST /api/v1/ai/threads (SSE)  ──► Anthropic API
    │                   │                                      │ tool call run_python
    │                   ▼                                      ▼
    └──WSS + HTTPS──► Workbook Host (Rust)  ◄──Arrow IPC──► Python Sandbox (gVisor, per workbook)
                        ├─ Router: workbookId → actor (spawn on open; evict after 15 min idle)
                        ├─ WorkbookActor
                        │    ├─ CellEngine (IronCalc model per sheet)
                        │    ├─ TableStore (Polars LazyFrames, Parquet-backed)
                        │    ├─ ObjectStore (pivots, charts, slicers, filters, comments)
                        │    ├─ OpLog (seq, durable append)
                        │    └─ Session fan-out (viewports, presence)
                        ├─ ImportService (multipart upload → staging → preview → finalize)
                        └─ ConnectorWorkers (Postgres, Snowflake)
                        │
                        ▼
                      S3: snapshots/ oplog/ tables/ staging/
```

### 3.1 Workbook lifecycle
1. **Open.** The client calls `POST /api/v1/workbooks/:id/open`. The control plane checks access, picks a host (MVP: consistent hash over healthy hosts), and asks that host to `ensure_loaded(id)`. It returns `{endpoint, routingToken, region, accountTier}`.
2. **Rehydrate.** The host loads the latest snapshot from S3, replays op-log segments with `seq > snapshot.seq`, and marks Parquet tables lazy (loaded on first access).
3. **Connect.** The client opens `wss://{host}/wb/{id}?channel=sheet&token=…` and a second socket with `channel=code`.
4. **Edit.** Every action gets a seq number, is applied, appended to the op-log (fsync to local NVMe; flushed to S3 every 5 s or 500 ops), and its patches are broadcast.
5. **Snapshot.** Taken every 10 min of activity, every 5,000 ops, and on eviction. Each snapshot is registered as a version row in Postgres.
6. **Evict.** After 15 min with no sockets: snapshot, flush, drop the actor, stop the Python sandbox.
7. **Crash recovery.** Re-open on another host. Data loss is at most the un-flushed op-log tail (target ≤ 5 s).

### 3.2 Viewport-driven rendering (E7, E20)
- The client sends a `viewport {sheet, anchor, widthPx, heightPx, bufferX, bufferY, tablePages{tableId: rowStart}}` with `GetData` **and with every mutating action**.
- The server answers with `ViewportPatch`: the cells inside the viewport plus buffer (values, formatted text, style ids), row heights and column widths, merged regions, and visible Data Table pages (≤ 200 rows per table per frame).
- The client keeps a tile cache keyed by `(sheet, row/64, col/16)` and never asks for anything outside the viewport.

---

## 4. Data model

### 4.1 Postgres (control plane)

```sql
users(id uuid pk, email citext unique, name, avatar_url, plan text check (plan in ('free','pro')), stripe_customer_id, created_at)
workbooks(id char(24) pk, owner_id fk users, title, region, created_at, last_accessed_at, deleted_at, latest_seq bigint, latest_snapshot_key)
workbook_shares(workbook_id fk, principal_type text check (principal_type in ('user','link')), user_id fk null, role text check (role in ('owner','editor','viewer')), created_at, expires_at)
workbook_link_settings(workbook_id pk fk, link_access text check (link_access in ('none','view','edit')), allow_copy bool, copy_on_open bool)
workbook_versions(workbook_id fk, seq bigint, snapshot_key, created_at, name null, created_by, pk(workbook_id, seq))
connections(id uuid pk, owner_id fk, kind text check (kind in ('postgres','snowflake')), name, config jsonb, secret_ref text, created_at)
connected_tables(id uuid pk, workbook_id fk, connection_id fk, sql text, schedule_cron null, last_run_at, last_status)
ai_threads(id uuid pk, workbook_id fk, user_id fk, title, created_at, updated_at)
ai_turns(thread_id fk, turn_no int, model, transcript jsonb, tokens_in int, tokens_out int, created_at, pk(thread_id, turn_no))
ai_usage_weekly(user_id fk, week date, tokens bigint, pk(user_id, week))
```
Secrets are stored in AWS Secrets Manager; `secret_ref` holds only the ARN.

### 4.2 Workbook state (owned by the actor)

```rust
struct Workbook {
  id: WorkbookId, seq: u64, settings: Settings /* locale, timezone */,
  sheets: Vec<Sheet>, named_ranges: Vec<NamedRange>,
  objects: ObjectStore,          // pivots, charts, slicers, filtered ranges, comments, media
  tables: TableStore,            // Data Tables: Arrow/Polars, Parquet-backed
  code: CodeModule,              // Python source (Yjs doc) + last run status
}
struct Sheet { id: SheetId, name, color, hidden, protected, frozen: (u32,u32),
               model: ironcalc::Worksheet, col_widths, row_heights, merges, cond_formats, validations }
```

**Object manifests.** These are JSON, versioned, stored in snapshots, and mirror the shapes observed in E23/E27/E28.

```jsonc
// Pivot (anchored at rootCell; output spills)
{ "type":"pivot","v":1,"id":"…","rootCell":"1!A1",
  "source":{"type":"range"|"table","ref":"0!A1:G5001"|"tbl_…"},
  "rows":[{"field":"region"}],"columns":[],"values":[{"field":"revenue","agg":"sum"}],"filters":[],
  "valuesAxis":"columns","subtotals":"all","grandTotals":"all","layout":"compact"|"tabular"|"table" }

// Chart (every series is a formula expression)
{ "type":"chart","v":1,"id":"…","sheetId":"0","rect":{"x":264,"y":0,"w":616,"h":308},
  "kind":"bar"|"line"|"scatter"|"histogram","title":{"text":"…"}|{"expr":"=A1"},
  "x":{"expr":"=Sheet0!A2:A100"}|null,"series":[{"expr":"=Sheet0!B2:B100","type":"bar","axis":"left","color":null}],
  "legend":{"show":true,"position":"bottom"},"yAxis":{"min":null,"max":null,"log":false} }

// Slicer
{ "type":"slicer","v":1,"id":"…","sheetId":"0","target":{"type":"filteredRange","ref":"0!A1:G5001"},
  "column":"region","filter":{"type":"categorical","op":"include","values":["North","East"]},
  "rect":{"x":25,"y":25,"w":250,"h":48},"collapsed":true }
```

### 4.3 S3 layout

```
s3://gz-data-{region}/wb/{id}/snapshots/{seq}.msgpack.zst
s3://gz-data-{region}/wb/{id}/oplog/{fromSeq}-{toSeq}.msgpack.zst
s3://gz-data-{region}/wb/{id}/tables/{tableId}/{version}.parquet
s3://gz-staging-{region}/imports/{importId}/{filename}      # lifecycle: delete after 24 h
```

---

## 5. Protocols

### 5.1 Sheet channel (WebSocket)

**Client → server (JSON):**
```jsonc
{ "reqId": 42, "type": "action", "action": "UpdateCell",
  "args": { "cell": "0!C1", "raw": "=double(B1)" },
  "viewport": { "sheet":"0","anchor":"A1","w":1186,"h":532,"bx":440,"by":440,"tablePages":{} } }
{ "reqId": 43, "type": "presence", "selection": [{"type":"range","ref":"0!A1:A10"}], "cursor": [412,96], "following": null }
```

**Server → client (MessagePack):**
```
Ack            { reqId, seq, ok: true } | { reqId, ok:false, error:{code,message} }
ViewportPatch  { seq, sheet, cells:[[row,col,value,display,styleId,flags]], styles:{id:Style}, dims, tables:{id:{rowStart,rows,cols}} }
ObjectsPatch   { seq, upserts:[Manifest+evaluation], deletes:[id] }
SheetsPatch    { seq, sheets:[{id,name,color,hidden}] }
Presence       { peers:[{peerId,name,color,selection,cursor,following}] }
Progress       { jobId, kind:"import"|"recalc"|"query", pct, rowsDone, message }
Notice         { level, message }
```

**MVP action catalog (62 actions).** Names are ours; behaviour follows PRD Appendix A.

| Group | Actions |
|---|---|
| Session | `Hello`, `GetData`, `Ping`, `GetSettings`, `UpdateSettings` |
| Cells | `UpdateCell`, `UpdateRange` (paste), `ClearRange`, `CopyPaste`, `CutPaste`, `FillRange` (drag), `InsertRows`, `InsertCols`, `DeleteRows`, `DeleteCols`, `Undo`, `Redo` |
| Formatting | `SetFormat`, `SetBorders`, `SetNumberFormat`, `MergeRange`, `UnmergeRange`, `SetColWidths`, `SetRowHeights`, `FreezePanes`, `SetConditionalFormats`, `SetDataValidations` |
| Sheets | `CreateSheet`, `DeleteSheet`, `RenameSheet`, `DuplicateSheet`, `ReorderSheets`, `SetSheetColor`, `SetSheetHidden` |
| Navigation | `CtrlJump` (dir), `GoTo`, `Find`, `FindNext`, `ReplaceAll`, `SelectionStats` |
| Names | `CreateNamedRange`, `UpdateNamedRange`, `DeleteNamedRange`, `ListNamedRanges` |
| Data | `CreateFilteredRange`, `ApplyColumnFilter`, `ApplySort`, `RemoveDuplicates`, `TextToColumns`, `DistinctValues` |
| Tables | `ResizeTable`, `AddComputedColumn`, `UpdateComputedColumn`, `SetTableColumns`, `ExplodeTable` |
| Import | `ImportPreview`, `FinalizeImport`, `CancelImport` |
| Objects | `CreatePivot`, `UpdatePivot`, `CreateChart`, `UpdateChart`, `CreateSlicer`, `UpdateSlicer`, `DeleteObjects` |
| Collab | `AddComment`, `ReplyComment`, `ResolveComment` |
| Code | `RunCode`, `SetExecuteOnWake` |
| Connected | `CreateConnectedTable`, `RefreshConnectedTable` |
| Calc | `Recalculate`, `CancelEvaluation` |

### 5.2 HTTP on the workbook host
- `POST /wb/{id}/import?importId&ext&size&compressed` — streaming upload (gzip or zstd body), ≤ 5 GB (E32).
- `GET /wb/{id}/objects/{objectId}` — full chart or pivot payload when it is too large for a patch (E23).
- `GET /wb/{id}/export.csv?range|table` — Pro plan only.

### 5.3 Control-plane REST (`/api/v1`)
`auth/*` · `me` · `workbooks` (list/create) · `workbooks/:id` (get/rename/delete/restore) · `workbooks/:id/open` · `workbooks/:id/copy` · `workbooks/:id/shares` (GET/PUT) · `workbooks/:id/shares/precheck` · `workbooks/:id/link` · `workbooks/:id/versions` (list/name/restore) · `connections` (CRUD + `/test`) · `ai/threads` (POST SSE) · `ai/threads/:id/turns` · `billing/checkout` · `billing/portal` · `stripe/webhook`.

### 5.4 AI agent contract
**Tool:**
```ts
run_python({ userFacingDescription: string, executionPlan: string, evidencePlan: string, code: string })
→ { kind: "final"|"error", stdout: string, calls: Array<{ op: string, input: object, ok: boolean, error?: string }> }
```

**`gridzero` Python SDK (MVP surface).** Each function maps 1:1 to a sheet action, runs as the requesting user, and is recorded in `calls`.
```python
sheet(id_or_name) -> Sheet;  sheet_range(sheet, "A1:B10") -> Range
get_values(range) -> list[list];  get_table(table_id) -> polars.DataFrame
update_cell(sheet, "B1", "=SUM(A1:A10)");  update_range(range, values: list[list])
fill_range(src: Range, dst: Range);  clear_range(range)
create_chart(dest: Range, kind: ChartKind, y: list[Range], x: Range|None=None, title: str|None=None)
create_pivot(source: Range|Table, dest: Cell|"new_sheet", rows=[], columns=[], values=[("revenue","sum")], filters=[])
create_slicer(target, column: str)
write_dataframe(df: polars.DataFrame, dest: Cell, as_table: bool=True)
run_query(connection_name: str, sql: str, dest: Cell) -> Table
```

**System prompt essentials:**
- Inspect the data before acting.
- Prefer formulas over hard-coded values.
- Verify results according to the evidence plan.
- Reference ranges as `<gz:Sheet!A1:B2>` (these render as clickable chips).

**Limits:**
- 25 tool calls per turn; 120 s per `run_python`; 1 GB sandbox RAM.
- Free tier: 200k tokens/week. Pro: 2M tokens/week.

**Streaming:** AI SDK UI message stream (SSE) is passed straight through to the client. "Follow along" means the client moves its viewport to each `calls[i]` target.

---

## 6. Client architecture

```
apps/web/src/
  app/            routes: /, /workbooks, /connections, /workbook/:id/:sheet?
  grid/           CanvasGrid (layers: cells, gridlines, selection, overlays), TileCache, HitTest, KeyMap
  formula/        FormulaBar (CodeMirror + grid_core wasm tokenizer, function intellisense)
  objects/        ChartView (ECharts), PivotPane, SlicerChip, DataTableOverlay, CommentPins
  panels/         AIPanel, CodePanel (CodeMirror + Yjs), ImportDialog, ShareDialog, VersionPanel, ConnectedTablePane
  net/            SheetSocket (reqId tracking, reconnect, backoff), msgpack decode, CodeSocket
  state/          zustand stores: session, viewport, selection, presence, objects
```

**Rendering rules:**
- Draw on one `<canvas>` per layer using `devicePixelRatio` scaling.
- Redraw only dirty tiles.
- Cache text measurement with an LRU of 10k entries.
- Target 60 fps for scrolling and ≤ 16 ms per frame on a 1440p viewport.

**Keyboard:** Excel-default shortcuts, plus the Alt-key menu sequences (Alt N V = pivot).

---

## 7. Python sandbox

- Image: `python:3.12-slim` + polars, pyarrow, pandas, numpy, scipy, duckdb, plus the `gridzero` SDK. Runs under gVisor. No network. Read-only root filesystem; `/tmp` tmpfs capped at 512 MB.
- Lifecycle: one sandbox per workbook, started lazily on the first `RunCode`, a custom-function call, or an AI tool call. It stops when the workbook is evicted. "Execute on wake" re-runs the module after rehydrate (E31).
- Custom functions: top-level `def`s in the module are registered as spreadsheet functions. The cell engine calls them through an IronCalc user-defined-function hook, and the sandbox's RPC executes them with a 5 s timeout per batch. Type marshalling follows PRD FR-23.

---

## 8. Non-functional requirements

| Metric | Budget | How we measure it |
|---|---|---|
| Open warm workbook (actor loaded) → first paint | ≤ 800 ms p95 | Playwright synthetic test |
| Rehydrate 1 GB workbook (cold) → first paint | ≤ 6 s p95 | Load test |
| `UpdateCell` → patch received (in region) | ≤ 120 ms p95 | Client RUM |
| Recalc after editing a cell with 1M dependents | ≤ 1.5 s | `bench/recalc_1m` |
| Scroll 5M-row data table | 60 fps, no blank frames > 100 ms | Perf trace |
| Import 5M-row / 600 MB CSV → finalized | ≤ 45 s | `bench/import_5m` |
| Sort or filter 5M rows (one column) | ≤ 2 s | `bench/table_ops` |
| Pivot 5M rows, 2 group-bys, 1 sum | ≤ 3 s | `bench/pivot` |
| Durability | Max loss ≤ 5 s of ops on host crash | Chaos test: kill -9 |
| Memory per active 5M-row workbook | ≤ 4 GB | Host metrics |
| Availability (control plane) | 99.9% monthly | Uptime monitor |

Reference host for benchmarks: m7i.2xlarge (8 vCPU, 32 GB, NVMe).

---

## 9. Security requirements (MVP)
- **Tokens:** every WebSocket and workbook-host HTTP request carries a routing token (JWT signed by the control plane, 10 min TTL, claims `{wb, user, role, exp}`). Viewers are rejected for any mutating action, enforced server-side.
- **Secrets:** connection credentials live only in Secrets Manager and are decrypted only inside connector workers.
- **Python sandbox:** gVisor, no egress, CPU/RAM/disk quotas, killed on timeout.
- **AI isolation:** the agent can reach only the SDK. The tool broker validates every call against the user's role.
- **Uploads:** staged in a separate bucket with a 24 h lifecycle; size checked before upload; the parser runs with memory caps.
- **Encryption:** S3 SSE-KMS; TLS everywhere.
- **Abuse limits:** rate-limit 200 actions/s per socket. Free tier: 1 active Python sandbox and 1 CPU-minute per run.
- **Compliance readiness:** audit log of share, export and connection events in a Postgres `audit_events` table. SOC 2 is post-MVP.

---

## 10. MVP scope (cut list)

**In:**
- grid, formulas (functions supported by IronCalc plus ≥ 20 additions such as XLOOKUP and FILTER if missing)
- formatting, sheets, named ranges
- CSV/TSV/Parquet/XLSX/JSONL/.gz import (upload and URL)
- Data Tables with computed columns, sort, filter, remove duplicates, text-to-columns
- pivots (compact/tabular/table), charts (bar/line/scatter/histogram, combo, dual axis), slicers
- conditional formatting (color scale, rules), data validation (list)
- real-time collaboration + presence + follow, comments
- share by email/link with owner/editor/viewer roles, make a copy, version history (list/name/restore), trash (7 days)
- Python code window + custom functions
- AI agent
- connections to Postgres and Snowflake (password/key pair), connected tables, manual refresh, scheduled refresh (Pro)
- CSV export (Pro), Free/Pro billing.

**Out (post-MVP, in order):**
1. write-back
2. published data sources
3. BigQuery/Databricks/Redshift connectors
4. S3 import
5. multi-region
6. SSO/SCIM/workspaces
7. export restrictions
8. BYOK AI
9. scheduled reports
10. XLSX export
11. Google Slides add-on
12. geo heatmaps
13. a process/VM per workbook
14. 1B-row enterprise nodes.

---

## 11. Milestones and acceptance criteria

The team is 4 engineers:
- **E-Core:** Rust engine and workbook host
- **E-Data:** tables, import, connectors
- **E-Web:** canvas grid and client
- **E-Plat:** control plane, infra, AI, Python sandbox

Total: **22 weeks to MVP GA.**

### M0 — Foundations and spikes (weeks 1–2)
- **S1 — IronCalc gate (E-Core).** Run 150 golden formulas from an Excel-generated test workbook. Benchmark recalc on 1M formula cells.
  **Pass:** ≥ 90% golden-file match, 1M-cell recalc ≤ 1.5 s, and the workbook model serializes to and from MessagePack.
  **Fail:** switch to plan B (our own evaluator on `grid_core` with IronCalc's function library ported incrementally). Re-plan by week 3; MVP slips 6 weeks.
- **S2 — Canvas grid (E-Web).** Render a 1M×50 synthetic viewport-served grid. **Pass:** 60 fps scroll and correct hit-testing.
- **S3 — Polars import (E-Data).** **Pass:** 5M-row CSV → Parquet + preview in ≤ 30 s on the reference host.
- **Infra (E-Plat):** monorepo, CI, preview deployments, Postgres, auth. **Pass:** sign up → empty home page in staging.

### M1 — Single-user spreadsheet (weeks 3–6)
Scope: the Session, Cells, Formatting, Sheets, Navigation and Names action groups; snapshot/op-log/rehydrate; home page, workbook list, rename and delete.
**Accept:**
- Type values and formulas, reload the page, and everything persists.
- Kill the host process and lose at most 5 s of edits.
- 50-step undo/redo.
- Copy/paste a 10k-cell range from Excel (TSV clipboard) correctly.
- Ctrl+arrow jumps, freeze panes, merge, number formats and borders all work.
- The open, rehydrate and `UpdateCell` budgets in §8 are met.

### M2 — Big data (weeks 7–9)
Scope: the import pipeline (upload/URL, preview dialog with destination, import type, header row and advanced CSV options), Data Tables, computed columns, sort/filter/distinct values, remove duplicates, text-to-columns, selection stats.
**Accept:**
- 5M-row CSV imports in ≤ 45 s and scrolls at 60 fps.
- Sort and filter of 5M rows take ≤ 2 s.
- A computed column over 5M rows takes ≤ 3 s.
- XLSX of 1M rows imports.
- Re-importing to the same destination recomputes all dependent formulas.

### M3 — Analysis objects (weeks 10–12)
Scope: pivots (fields pane, aggregations: sum, count, count unique, avg, min, max, median, percentile), charts (chart pane, series config, combo/dual axis, histogram buckets), slicers driving several objects, conditional formatting, data validation dropdowns.
**Accept:**
- The pivot over 5M rows meets the §8 budget.
- Editing the source data updates the pivot, charts and slicers within one patch cycle.
- A slicer filters 2 pivots and 1 chart at the same time.
- Chart expressions survive insert/delete of rows (reference shifting).

### M4 — Collaboration and sharing (weeks 13–15)
Scope: multi-session fan-out, presence/follow, comments, share dialog (email invite with notification email, link access), copy, version history (list, name, preview read-only, restore), trash.
**Accept:**
- 3 concurrent editors make 1,000 random edits each and all clients converge to identical state, verified by a hash check.
- A viewer cannot mutate the workbook (server rejects; covered by an integration test).
- Restoring version N gives a state equal to a replay up to N.
- An invite email arrives within 60 s.

### M5 — Python and AI (weeks 16–18)
Scope: sandbox service, code panel with Yjs, run/console, execute on wake, custom functions, the `gridzero` SDK, AI panel (threads, history, model picker, follow along, call-log rollup), token quotas.
**Accept:**
- `=double(B1)` works after Run and survives rehydrate.
- The sandbox cannot reach the network (test: `urllib` to example.com fails).
- An AI eval suite of 30 prompts (fill, formula, pivot, chart, summarize) scores ≥ 85% task success, with every change shown in the call log.
- A quota-exceeded user gets a clear error.

### M6 — Connectors, billing, hardening (weeks 19–22)
Scope: Postgres and Snowflake connections (create, test, store secret), connected tables (SQL editor, manual and scheduled refresh), Stripe Free/Pro with plan gates (workbook count, CSV export, scheduled refresh, trash), audit log, load and chaos tests, security review.
**Accept:**
- A 1M-row Postgres query lands in ≤ 20 s.
- A scheduled refresh runs within ±1 min.
- A Free user's second workbook is view-only (matches E25).
- 200 simultaneously active workbooks on 4 hosts hold the §8 budgets.
- The external pen-test has no high or critical findings open.
- **GA.**

---

## 12. Repository layout

```
gridzero/
  crates/
    grid_core/        refs, ranges, numfmt, tokenizer  (native + wasm)
    ironcalc/         vendored fork (D1)
    engine/           WorkbookActor, CellEngine adapter, ObjectStore, pivots/charts/slicers eval
    tables/           Polars TableStore, computed columns, filters
    importer/         csv/tsv/jsonl/parquet/xlsx readers, preview, type inference
    connectors/       postgres, snowflake
    storage/          snapshot/oplog/S3
    protocol/         action + patch types (serde), msgpack codec, TS type generation (ts-rs)
    wbhost/           axum server: ws channels, upload, routing tokens, eviction
  services/
    control/          Hono API, Drizzle schema, auth, billing, AI threads (AI SDK)
    sandbox/          gVisor runner + python/gridzero SDK
  apps/web/           React client
  bench/              recalc_1m, import_5m, table_ops, pivot, scroll
  tests/
    golden/           Excel-generated formula fixtures (.xlsx + expected .json)
    e2e/              Playwright specs per milestone
    convergence/      multi-client fuzzer
  infra/              Terraform (VPC, ECS, ASG, RDS, S3, CloudFront)
```

---

## 13. Test strategy
- **Formula golden files.** Each supported function has ≥ 5 cases authored in real Excel and exported. CI fails on any regression; the pass rate is published as a compatibility matrix.
- **Property and fuzz tests:** reference shifting on insert/delete; op-log replay equals the live state; MessagePack round-trip.
- **Convergence fuzzer:** N simulated clients with random actions, then compare state hashes. Runs nightly with 10k ops.
- **E2E (Playwright):** one spec per acceptance bullet in §11, run on every PR against preview environments.
- **Benchmarks:** the `bench/*` suite runs nightly on the reference host. A >10% regression fails the build.
- **AI evals:** 30-prompt suite scored by checking the workbook state, not the text. Runs nightly and on model changes.
- **Chaos:** kill workbook hosts during writes; verify durability ≤ 5 s.

---

## 14. Risk register

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| IronCalc lacks functions or performance at scale | Med | High | Spike S1 gate; upstream contributions; plan B evaluator | E-Core |
| Canvas grid complexity (IME, accessibility, selection edge cases) | High | Med | Hidden textarea for IME; an ARIA live region mirroring the active cell; 2 weeks of buffer inside M1 | E-Web |
| Memory blow-up from large tables per host | Med | High | Lazy Parquet, Polars streaming, per-actor memory cap and eviction, host bin-packing | E-Data |
| Python sandbox escape | Low | Critical | gVisor, no egress, seccomp, pen-test, separate host pool post-MVP | E-Plat |
| AI cost overruns on the Free tier | Med | Med | Weekly quotas, Sonnet default, prompt caching, compacting the history | E-Plat |
| Collaboration divergence bugs | Med | High | Single authoritative actor + seq; convergence fuzzer | E-Core |
| Scope creep toward enterprise features | High | Med | The §10 cut list is binding; changes need a decision-log entry | PM |

---

## 15. Decision log and open questions

| # | Question | Default if not decided by | Deadline |
|---|---|---|---|
| Q1 | IronCalc vs plan B | **Decided 2026-10-27: adopt IronCalc.** S1 passed: 99.4% golden, 0.82 s recalc at 1M formulas, snapshot round-trip OK. Adapter obligations A1–A3 are in [S1 report](spikes/S1-ironcalc.md). | Week 2 |
| Q2 | Product name / domain | "GridZero" placeholder | Week 4 |
| Q3 | Pricing (match Row Zero's $0/$12) | Free $0, Pro $12/user/mo | Week 18 |
| Q4 | Hosted AI model and provider | Anthropic API, latest Sonnet | Week 15 |
| Q7 | Staging host for M0 | **Decided 2026-10-28: Railway** (project `gridzero`, env `staging`) instead of AWS (D14). Revisit before M1 workbook hosts, which need NVMe-backed EC2 per §8. | Week 2 |
| Q8 | M1 engine adapter shape | **Decided 2026-10-28:** the workbook actor wraps IronCalc `UserModel` (undo/redo, clipboard, styles, merges) instead of the raw `Model`. The op-log stores `UserModel` diff bytes, so replay is exact, undo included. S1 obligations: **A1** open: full recalc on every edit measures 59 ms p95 UpdateCell→Changed at 100k formulas (within the §8 120 ms budget, above A1's 50 ms target), so dirty-tracking stays an M2 task. **A2** open: TSV paste goes through `paste_csv_string` (10k cells in 26 ms), and a fast path is still needed for imports. **A3** partly done: the snapshot envelope records the engine version, but the cross-version load test waits for a second engine version. | Week 6 |
| Q5 | Free-tier workbook limit | 1 editable workbook (others view-only) | Week 18 |
| Q6 | Python on the Free tier | Allowed, 1 CPU-min per run | Week 15 |

---

## 16. Definition of done (per feature)
1. Acceptance criteria pass in E2E tests on staging.
2. Benchmarks are within budget.
3. Golden and convergence suites are green.
4. Server-side permission checks exist.
5. Telemetry events are emitted (Sentry + OTel span + product analytics event).
6. Docs page written.
7. Feature flag removed or defaulted on.
