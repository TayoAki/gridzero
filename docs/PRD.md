# PRD — "GridZero": A Cloud Spreadsheet for Billion-Row Data

*A product requirements document reverse-engineered from Row Zero (rowzero.com)*
Author: tayom · Date: 2026-10-26 · Status: Draft v1

---

## 0. How this PRD was produced (evidence ledger)

The reference product was studied with the REA reverse-engineering toolkit and with the public website. It was not decompiled beyond the client assets that any visitor's browser downloads. Each claim below is tagged:

- **[O] Observed**: seen directly in runtime capture or shipped code.
- **[M] Marketing/docs**: stated on rowzero.com pages or docs. Not independently verified.
- **[I] Inferred**: my reasoning from the evidence.

| # | Finding | Tag | Evidence |
|---|---|---|---|
| E1 | The web client is a React SPA. It is code-split into about 50 esbuild-style chunks on CloudFront (`/307eb22e3/chunk-*.js`, `client-*.js`, `AppComponent-*.js`). | O | REA `capture_browser_scenario` ev_56cb1280…; static grep |
| E2 | A Rust core compiled to WebAssembly ships to the browser: `workbook_core_bg.wasm`, about 376 KB, built with wasm-bindgen 0.2.118 and serde-wasm-bindgen. Crates: `workbook_core` (formula_parser2.rs, dependency.rs, sql_parser.rs, mention.rs, parse_number.rs) and `workbook_numfmt` (locale and date formats). Exposed functions include `parse_cell_or_range_reference`, `shift_formula_text`, `sanitize_formula`, `formula_intellisense` and `parse_python_cell_formula_json`. Build host was `ec2-user`. | O | strings in the WASM file |
| E3 | Formula parsing and number formatting run on both client and server (the same Rust crate is shared). The client parses for UX, such as highlighting, intellisense and reference shifting. The server is authoritative for evaluation. | I | E2 + E5 |
| E4 | Workbook compute is regional. The client pings `workbooks-{us-east-1,us-east-2,us-west-2,eu-central-1,ap-south-1,ap-southeast-2}.rowzero.com/health`, logs "Closest region us-east-1", then calls `/api/2/workbooks/{id}/getOrRehydrate?isReconnect&healthCheck&regionLatencies`. | O | runtime capture |
| E5 | Each workbook has its own stateful server process, reached by WebSocket at `wss://workbooks-<region>…/workbook/{id}/{token}?channel=sheet\|code&auth=…`. The marketing site says each workbook gets a dedicated EC2 instance. "Rehydrate" means the workbook is loaded from object storage onto a compute node when it is opened. | O + M | runtime capture; /features/performance; /security |
| E6 | Client→server messages are JSON: `{reqId, payload:{requestType:"workbook", Action:"GetData", clientVersion:1, …}}`. Server→client frames are **binary**. Sizes ran from 51 B to 69 KB, and the first viewport arrived as about 69 KB. | O | WebSocket frames |
| E7 | **Server-side viewport virtualization.** `GetData` sends a `visibilityManifest` containing screenPosition `0!A1`, screen width and height in px, horizontal and vertical buffers of 440 px, a default column width of 88 and row height of 22, and per-table pagination. The server returns only the cells the user can see. | O | WebSocket frame reqId 1 |
| E8 | Presence uses the same socket (`requestType:"status"`) and carries peerId, alias, color, selection, mouse position and `followingPeerId`, which backs the "Follow" feature. | O | WebSocket frames reqId 0 and 7 |
| E9 | There is a separate `channel=code` WebSocket for the Python code window. It uses a binary protocol. | O | runtime capture |
| E10 | The client↔server RPC surface has **149 named actions**, for example UpdateCell, CopyPaste, Undo/Redo, BeginPivot, UpdatePivotTable, CreateSlicers, ApplyColumnFilters, BeginSort, RemoveDuplicates, TextToColumns, FreezePanes, MergeRange, GetDependencyChain, GetDagDiagnostics, SetRecalculationPaused, CancelEvaluation, GetFileImportPreview, FinalizeFileImport, SetConnectedTableWritebackManifest, AddScheduledReport, UpdateCode, AddComment, GetSummaryStatsForSelection, CtrlUp/Down/Left/Right and ScrollToXYPosition. The full list is in Appendix A. | O | static grep of `executeWorkbookAction` |
| E11 | The control-plane REST API lives at `/api/2/…` and covers user, workbooks, folders, entities (move/starred), credentials (including S3), dataSources, templates, workspaces, privateEndpoints, crossWorkbookReference, inviteUsers and stripe/cancelSubscription. | O | static grep |
| E12 | Feature flags found in the client: showTemplates, pauseRecalculation, createFolders, entitySearch, starredEntities, dataSources, granularWriteback, exportXlsx, scheduledReports, reportSheetPrototype, echartsGeoheatmaps, slidesPasteFormat, lambdaConnections, databricksGenieOne, aiChatSkipWeeklyTokenLimit and teradataHcscNos. | O | static grep |
| E13 | Client libraries detected: React, CodeMirror 6 (code and formula editors), ECharts (charts and geo heatmaps), d3, Sentry (errors) and Segment (analytics). The grid is drawn on a 2D canvas, with text measured through a canvas context and cell size caches. | O | static grep (fingerprints only) |
| E14 | The Python runtime supports duckdb, pandas, polars, pyarrow and tldextract. Data tables are passed to Python as polars DataFrames. Python can define custom functions but cannot modify the sheet. | M | /docs/code-window |
| E15 | Pricing: Free $0 (1 workbook, 5 GB), Pro $12/user/mo, Business $20/user/mo, and Enterprise at a custom price (1B+ rows, BYOK AI, SSO/SCIM, Private Link, a dedicated data plane). | M | /pricing |
| E16 | Row Zero has been acquired by Databricks (press-release link in the site banner). | M | homepage link |

**Logged-in session (free account, test workbook, 2026-10-26)**

| # | Finding | Tag | Evidence |
|---|---|---|---|
| E17 | **The AI agent has exactly one tool, `run_python`.** Its input has four fields: `userFacingDescription`, `executionPlan`, `evidencePlan` and `code`. The model writes Python against a workbook SDK. Observed calls: `sheet("0")`, `update_cell(s,"A1","1")`, `drag_range(s,"A1:A2","A1:A10")`, `get_cell_values_in_range(s,"A1:B10")` and `create_graph_from_range(destination=sheet_range(s,"D1:J14"), y=[…], graph_type=SeriesType.Bar, title=…)`. The tool output is a list of `{operationName, input, success}` records. That list is what the UI shows as "3 cell updates · 1 graph · 1 range fill · 1 range read". | O | ev_f4352e80… (`/api/2/ai/threads/{id}/turns`) |
| E18 | AI transport: `POST /api/2/ai/threads` with `{invocationContext:{type:"workbook",workbookId,activeSheetId}, requestedModelCanonicalId:"claude-sonnet-5", message:{parts:[{type:"text",text}],role:"user"}}`. The response is an SSE stream in the **Vercel AI SDK UI-message-stream** format: start, start-step, reasoning-*, tool-input-start, 126× tool-input-delta, tool-input-available, tool-output-available, text-delta, finish. The provider metadata says **Amazon Bedrock**. Thread history comes from `GET /api/2/ai/threads/{id}/turns`. The model auto-names the thread. | O | ev_f4352e80… |
| E19 | Assistant replies embed cell links such as `<rowzero:Sheet1!B1>`, which render as clickable range chips. The panel has "Follow along" (the view tracks the agent's edits), New thread, History and a model picker. | O | a11y tree + transcript |
| E20 | Every mutating sheet action carries the client's `visibilityManifest` (viewport, buffers, selection anchor, selected graphs). That lets the server reply with the recomputed visible window in the same round trip. Observed: `UpdateCell {cell:"0!C1", rawCellContents:"=double(B1)"}`, `GoToSelection {selection, viewportPlacement:"ensureVisible"}` and `UpdateCode {code, startClean:true}`. | O | ev_b7441de7… |
| E21 | Python code editor: a CodeMirror panel (View → Code editor; Ctrl+Enter runs it). Keystrokes sync over the binary `channel=code` socket, likely Yjs (the client bundle includes yjs). Run sends `UpdateCode` on the sheet channel. Functions defined in the editor became callable as formulas: `=double(B1)` worked. | O + I | ev_b7441de7… |
| E22 | `getOrRehydrate` returns `{workbookId, language:"python", workbookWorkspace{…}, endpoint:"https://workbooks-us-east-1…/workbook/{id}/{token}", workbookRegion, title, requesterSharingAccess, workbookAccountType:"FREE", routingToken, …}`. That is the control plane handing the client a signed, region-pinned compute endpoint. | O | ev_f4352e80… |
| E23 | Charts are fetched over **HTTP GET from the workbook host**, not the socket. The config JSON includes `config{graphType, rect{x,y,w,h}, title, legend*, ySeries[{type:"bar", expressionId,…}], yMin/yMax, log scales, histogramConfig, geoHeatmapConfig}`, plus `expressionByExpressionId` (formula strings like `=~Sheet0!A1:A10`), `evaluationsByExpressionId` (column-oriented data) and `errorsByExpressionId`. Each chart series is a formula expression. | O | ev_f4352e80… |
| E24 | Free-tier connection types offered: Athena, Databricks, Oracle, Postgres, Redshift, Snowflake, SQLServer and Teradata. The wizard has three steps: type → name → details. A global, read-only S3 credential `s3://rowzero-public-datasets` is pre-provisioned for every user. | O | ev_e3…/a11y; credentials/list |
| E25 | `POST /api/2/workbooks/list` takes `{ownershipFilter, workspaceFilter, offset, sort{field:"lastAccessedAt",direction}, limit}`. Each row includes role, sharing access, copy/move/remove permissions, owner, deleteState and `isViewOnlyDueToFreeTierLimit`, which shows the free-tier limit is enforced as view-only. `POST /api/2/entities` is a generic typed entity search (e.g. `entityTypes:["dataSource"]`). | O | ev_f4352e80… |
| E26 | UI inventory. **File:** New, Restart, Make a copy, Import, Share, Rename, Download, Version history, Move to trash, Settings. **Edit:** Undo/Redo, Cut/Copy, Copy as image, Find and replace. **View:** gridlines, Code editor, AI Agent, Freeze, Comments, Zoom. **Data:** Sort, Filter, Remove duplicates, Text to columns, Conditional formatting, Data validation, Named ranges, Recalculate sheet/all, Sync time functions, Lock cells, Import files/URL/S3. **Insert:** Chart, Pivot table, Slicer, Dropdown, Connected table. **Toolbar:** undo/redo, zoom, B/I/U, font size, format painter, text/fill color, borders, accounting/percent/number formats, precision, number-format dropdown, merge, alignment, wrap. **Home:** New, Search (Ctrl K), Home/Starred/Workbooks/Connections, and three create-new tiles (Blank, File upload, Database query). | O | ev_7268d99c…, ev_e6fe8cb3… |

| E27 | **A pivot table is an "internal formula" anchored at a cell.** Insert → Pivot table opens a dialog (source range; insert into a new or existing sheet). On Create, the client sends `BeginPivot`, then `CreateNewSheet`, then `InsertInternalFormula {cell:"1!A1", manifest:{pivot:{version:"v1", id, rootCell, rows:[], columns:[], values:[], filters:[], valuesAxis:"columns", subtotalVisibility:"all", grandTotalVisibility:"all", repeatRowLabels:true, displayMode:{type:"spill", rowLayout:"compact"}, source:{type:"filteredRange", range:"0!A1:A10"}, spill:true}}}`. The editor is a side pane titled "Configure pivot table" with source/Edit, Fields and Options tabs, Rows/Columns/Values/Filters wells and field search. The pivot sheet shows a "Pivot details" button. | O | ev_2bfe04ee…, ev_8447ba02… |
| E28 | **A slicer needs a filtered range or data table.** Otherwise a toast says to select one. Data → Filter sends `CreateFilteredRange {range}`. Insert → Slicer sends `SummarizeFilteredRanges` and opens a "Create slicer" dialog with a checkbox list of columns. Apply sends `CreateSlicers {manifests:[{version:"v1", name:"A", sheet, slicedRange:"0!A1:A10", filteredRangeColumns:["A"], filters:[{type:"Categorical", filter:{operator:"Include", value:[]}}], rect:{x,y,width:250,height:48}, collapsed:true, redrive:true}]}`. The slicer then appears as a floating chip ("All selected"). | O | ev_b51d2806…, ev_9b041684… |
| E29 | **Share dialog** (REST, not socket): `GET /api/2/workbooks/{id}/users` returns sharees (role, access, lastAccessedAt, shareExpiresAt, accessProvenance) plus `restrictions{whoCanCopy, whoCanShare, allowMultipleOwners, maxShareDurationDays, maxSharees}` and `policies{workbookNamedSharing:ANYONE, workbookLinkShare:PUBLIC, workbookLinkAccess, workbookCopy, workbookAllowedSharers…}`. `POST /workbooks/{id}/precheckAccess {emails, groups, entityType, role:"writer"}` validates invitees before sharing. The UI has an email combobox, a user/role/last-accessed table, Copy link, and an "Anyone with the link can [View]" switch. | O | ev_2bfe04ee… |
| E30 | **Version history:** File → Version history → (Name current version \| See version history). `GET /api/2/workbooks/{id}/history` returns `[{seq, timestampMillis}]`. The seq numbers are sparse (12, 11, 10, 8, 5), so versions are periodic snapshots of an operation sequence, not every edit. The panel has "All versions" and "Named versions" tabs. | O | ev_9b041684… |
| E31 | The Python console has an **"Execute on wake"** switch (on by default), so Python code re-runs when the workbook is rehydrated onto a compute node. Every sheet edit triggers `GetSummaryStatsForSelection`, which drives the status-bar "Count 10 Sum 55". | O | ev_da8853ba… |

| E32 | **File import is a client-generated `importId` plus a direct upload to the workbook node.** The flow:<br>1. Data → Import files opens a dialog: drop zone or "Select files…" (multi-select), the formats CSV, TSV, JSONL, Parquet and XLSX (beta), and "Or import from URL".<br>2. Choosing a file **POSTs the bytes straight to the compute host** at `https://workbooks-<region>…/workbook/{id}/{token}/ImportFile?isPaste=false&importId=<uuid>&fileExtension&importSize&importCompressed&auth`. A `content-encoding` header is present, so the client compresses the file before upload (I). The control plane is not involved.<br>3. The client polls `GetFileImportProgress {importId}` and then calls `GetFileImportPreview`. The server parses and type-infers the data: ISO dates came back as dates and numbers were normalised.<br>4. The preview dialog shows a preview table, Destination (New sheet / …), Import type (Import into cells / data table), a Header-row switch, and Advanced options (Separator, Quote, Escape — all Autodetect — and Skip X rows). Status reads "Finished 5,000 rows", with Back and Import buttons.<br>5. Import sends `FinalizeFileImport {importId, destination:null (new sheet), manifest:null, exploded:true (into cells), importedBy, source:"<filename>", pasteIntoHidden:true}`. A new sheet (Sheet2) was created with the data.<br>Uploads that are never finalised are simply abandoned. | O | ev_ad9c41f0…, ev_f8869b79… |

**Coverage limits:**
- REA static analysis (ev_c1851093…) reports *partial* coverage. One chunk exhausted the analyzer heap.
- File import was driven with a synthetic 5,000-row CSV. The file chooser was supplied through CDP `Page.setInterceptFileChooserDialog`, because REA has no upload action. The upload's request body was deliberately not recorded. Large-file behaviour, Parquet/XLSX parsing and the "Import type: data table" path were not exercised.
- Not exercised: connector credentials (no warehouse connected), write-back, scheduled refresh, and editing pivot fields.
- The binary sheet and code frame encodings are still not decoded. REA retains no binary payloads.
- Server internals (language, storage format, evaluation engine) are not observable. The architecture claims about them come from marketing pages or are inferred.

---

## 1. Summary

GridZero is a browser spreadsheet that feels like Excel or Google Sheets but runs on a dedicated cloud compute node for each workbook. That lets it handle **10M+ rows on free plans and 1B+ rows on enterprise plans**. It connects live to data warehouses, and query results refresh on a schedule. Users can write results back to the warehouse. It also includes a built-in Python window and an AI agent that works through auditable spreadsheet actions.

**Wedge:** analysts who hit Excel's 1,048,576-row limit or Sheets' 10M-cell limit, and data teams who want to stop the ungoverned CSV exports that come out of BI tools.

## 2. Problem

1. Spreadsheet limits. Excel and Sheets crash or refuse files above roughly 1M rows, and big CSV, Parquet and JSONL files won't open at all.
2. The CSV-export anti-pattern. Data moves from the warehouse to a CSV on a laptop. That creates security risk, stale numbers and manual rework every week.
3. BI tools are rigid for business users, and SQL and Python are inaccessible to most of them.
4. AI analysis tools are black boxes. Finance and ops users need to audit every step.

## 3. Target users & personas

| Persona | Need | Primary features |
|---|---|---|
| **Spreadsheet power user** (FP&A, ops, marketing analyst) | Excel skills at warehouse scale | Grid, 400+ functions, pivots, charts, shortcuts |
| **Query writer / analytics engineer** | Hand governed datasets to business users | Connections, SQL editor, published Data Sources, scheduled refresh |
| **Data/IT admin** | Security and governance | SSO/SCIM, RLS inheritance, export restrictions, workspaces, region lock |
| **Technical analyst** | Advanced modeling | Python window, custom functions, sensitivity analysis |
| **Exec / report consumer** | Up-to-date dashboards | Viewer role, slicers, scheduled reports, Slides sync |

## 4. Goals & non-goals

**Goals (v1)**
- G1: Open a 10M-row file and scroll, sort, filter and pivot it with p95 interaction latency under 300 ms.
- G2: Excel-compatible formula language. Ship the top 200 functions at launch and reach 400+ by GA.
- G3: Live connectors to Postgres, Snowflake, BigQuery, Databricks and S3, with scheduled refresh.
- G4: Real-time multi-user collaboration with presence.
- G5: An AI agent that acts only through workbook actions that are logged and replayable.

**Non-goals (v1)**
- Full XLSX round-trip fidelity for macros, VBA and complex chart styles. Import data plus basic formatting only.
- Offline or desktop mode.
- On-prem deployment. This is deferred to the Enterprise phase.

## 5. Scope & phasing

| Phase | Scope |
|---|---|
| **MVP (0→3 mo)** | Canvas grid, cells, formulas (top 100), file import (CSV/Parquet/XLSX/gz), Data Tables, sort/filter, basic pivot, bar/line chart, sharing (owner/editor/viewer, public link), single region |
| **V1 (3→6 mo)** | Connectors with connected tables, SQL editor and scheduled refresh; real-time collaboration and presence; comments; slicers; conditional formatting; data validation; version history; Python window; AI agent (hosted model); Free/Pro/Business billing |
| **V2 (6→12 mo)** | Write-back, published Data Sources with query variables, multi-region, SSO/SCIM, workspaces, export restrictions, BYOK AI, scheduled reports, Google Slides add-on, cross-workbook references, templates gallery |
| **Enterprise** | Customer-managed object storage, Private Link, GovCloud, a dedicated data plane, custom connectors, on-prem connectivity |

## 6. Functional requirements

### 6.1 Workbook & grid
- FR-1: An infinite-feeling grid rendered on **canvas**. The client requests only the visible viewport plus a buffer (E7). Default cell size is 88×22 px. Rows and columns can be resized, hidden, grouped and frozen.
- FR-2: Sheets can be created, deleted, duplicated, reordered, renamed, colored, hidden and protected.
- FR-3: Editing covers cell edit, copy/cut/paste (including paste-into-hidden), fill/drag, insert/delete cells, merge/unmerge, undo/redo, find/replace, and Ctrl+arrow jumps computed on the server (E10).
- FR-4: Formatting covers number formats with locales, borders, a theme, conditional formats, data validation, hyperlinks and gridlines.
- FR-5: A selection summary bar shows sum, avg and count, computed on the server (`GetSummaryStatsForSelection`).

### 6.2 Data Tables (the core big-data primitive)
- FR-6: A **Data Table** is a fixed-footprint object anchored at a cell. It displays a full dataset without writing values into cells, and it paginates internally (`dataTablePaginationByTableKey`). It is the render mode for file imports, connected tables, pivot output and `DATATABLE()` results.
- FR-7: Computed columns are row-level formulas over a table. Users can hide and reorder columns, filter, sort, "explode" a table to cells, and toggle spill mode.

### 6.3 Formula engine
- FR-8: An Excel-compatible grammar with A1 and range refs, cross-sheet refs, named ranges, array formulas and spill.
- FR-9: A dependency DAG with incremental recalculation. It can be paused (`SetRecalculationPaused`) and cancelled (`CancelEvaluation`), and exposes diagnostics (`GetDagDiagnostics`, `GetDependencyChain`).
- FR-10: Functions: at least 400 by GA, plus proprietary ones such as MULTILOOKUP.
- FR-11: A **shared Rust crate** for parsing and number formatting. It compiles to WASM for the client (intellisense, reference shifting, validation) and runs natively on the server (E2, E3).

### 6.4 Analysis
- FR-12: Pivot tables in three modes: compact, tabular and data table. Aggregations: sum, avg, count, count unique, min, max, median, first, last and percentiles. Also date grouping, label aliases, sort specs, drill-down detail sheets and an expand/collapse state.
- FR-13: Charts: bar, line, scatter, histogram, combos and dual axes, plus pivot charts that update live. Uses ECharts or equivalent. Geo heatmaps come in V2.
- FR-14: Slicers are interactive filters bound to source data. One slicer can drive several pivots and charts.
- FR-15: Data cleaning tools: remove duplicates, text-to-columns, and color sort.

### 6.5 Data in / out
- FR-16: File import of CSV, TSV, TXT, Parquet, JSONL, XLSX, .gz and .zip, from upload, URL or S3. The browser compresses the file and uploads it **directly to the workbook node** under a client-generated `importId` (E32). The server parses it, infers types and stages a preview. The preview dialog offers destination, import type (cells vs data table), header row, separator/quote/escape autodetect and skip-N-rows, plus a progress bar and cancel. Then the client calls `FinalizeFileImport`. Max size is 5 GB on self-serve plans. Re-importing to the same location recomputes all dependents.
- FR-17: Connections for Postgres, Snowflake, BigQuery, Databricks, Redshift, Athena, Oracle, SQL Server, Teradata and S3. Auth options are OAuth, password, key pair and IAM role. A connection inherits the warehouse's RLS through the user's own credentials.
- FR-18: Connected tables can run SQL, use the query builder or use a published Data Source. Refresh is manual or scheduled (Business+). Two modes: Data Table and "standard" spill-to-cells.
- FR-19: Published Data Sources are shareable queries with query variables, column selection and filters. They run as the end user under OAuth or as a service account.
- FR-20: Write-back creates or appends a warehouse table from a range, with a preview (`GetConnectedTableWritebackPreview`).
- FR-21: Export to CSV (Pro+), XLSX (flagged), and a Google Slides add-on that syncs charts and tables.

### 6.6 Python
- FR-22: A per-workbook Python window that works like a Jupyter cell and runs over its own `code` channel (E9). Functions defined there can be called as `=foo(A1:A100)`.
- FR-23: Type marshalling: text→str, number→float, date→date, datetime→datetime, struct→dict, Data Table↔polars DataFrame, and range→iterable. The package allowlist is pandas, polars, duckdb, pyarrow, numpy and scipy. Code runs in a sandbox with no network access by default.

### 6.7 AI agent
- FR-24: A chat side panel. The agent's single tool is **`run_python(userFacingDescription, executionPlan, evidencePlan, code)`** (E17). The model writes Python against a sandboxed workbook SDK. The minimum SDK surface:
  - `sheet()`, `sheet_range()`
  - `update_cell`, `drag_range`, `get_cell_values_in_range`
  - `create_graph_from_range`, `create_pivot`
  - `import_data_source`, `run_query`
  - enums such as `SeriesType`.

  Each SDK call is executed as a workbook action and logged as `{operationName, input, success}`. The UI rolls those up into an expandable summary (e.g. "3 cell updates · 1 graph"). Results stay as normal, editable workbook objects. Replies can embed `<app:Sheet!A1:B2>` range chips. "Follow along" moves the viewport to each edit.
- FR-24a: Transport is `POST /ai/threads` streaming SSE in the Vercel AI SDK UI-message format (E18). Thread history is served from `/ai/threads/{id}/turns`, and the model auto-titles each thread.
- FR-25: Threads are saved per workbook, can be linked, and are auto-compacted. Runs continue on the server after the tab closes.
- FR-26: NL→SQL through warehouse semantic layers, such as Databricks Genie and Snowflake Cortex Analyst.
- FR-27: Weekly token quotas on self-serve plans. Enterprise BYOK supports Anthropic, OpenAI, Gemini and Bedrock (via assume-role). AI-enabled workbooks are **network isolated**, so the agent's only egress is through the internal tool broker.
- FR-28: The workbook exposes an MCP server so external agents can drive it (M).

### 6.8 Collaboration & org
- FR-29: Real-time multi-user editing with presence (cursor, selection, color), a "Follow" mode, comments with replies and @mentions.
- FR-30: Roles are owner, editor and viewer. Sharing can be by named user, SCIM group or link (public, workspace or none). "Dynamic copy" links (`?copy`) give each visitor their own copy.
- FR-31: Folders, starring, search, templates, trash (Pro+) and version history (Pro+).
- FR-32: Org policies cover sharing, connection creation, export and copy/paste restrictions, lifecycle rules, network isolation, region lock and workspaces.

## 7. System architecture

### 7.1 Reconstructed reference architecture (observed + inferred)

```
Browser (React SPA + canvas grid + Rust/WASM core)
   │  HTTPS  /api/2/*  (control plane: users, workbooks, folders, credentials, data sources, billing)
   │  HTTPS  workbooks-<region>/health  (latency probe → pick region)
   │  GET    /api/2/workbooks/{id}/getOrRehydrate  → assigns/boots compute node, returns WS token
   ▼
Regional workbook fleet  (one stateful process per open workbook; dedicated VM on enterprise)
   ├─ WS channel=sheet : JSON actions in, binary viewport/patch frames out, presence fan-out
   ├─ WS channel=code  : Python kernel
   ├─ Formula engine + DAG (shares workbook_core crate with client)
   ├─ Columnar data store for Data Tables (in-memory; spills to disk)
   └─ Connector workers → customer warehouses (optionally via PrivateLink)
Object storage (S3/Blob; optional customer-owned bucket in their VPC: durable + staging buckets per region)
AI tool broker (internal) ↔ inference provider (hosted Bedrock or customer BYOK)
```

### 7.2 Proposed build (design choices, not observed)

| Layer | Choice | Rationale |
|---|---|---|
| Client | React + TypeScript, custom canvas grid renderer, CodeMirror 6, ECharts | Matches the reference stack. Canvas scales and the DOM does not. |
| Shared core | Rust crate (`grid_core`): formula parser, AST, reference shifting, number formats → `wasm-bindgen` for the client | One grammar, so client and server never disagree |
| Workbook server | Rust (tokio + axum WebSocket). Process-per-workbook on Firecracker microVMs or K8s pods | Isolation and dedicated memory, as in the "dedicated data plane" model |
| Columnar storage | Apache Arrow in memory, Parquet snapshots to S3, DataFusion/Polars for Data Table ops (filter, sort, group-by, pivot) | Billion-row columnar operations are proven here |
| Cell model | Sparse map of cells plus a dependency DAG; Data Tables are referenced as whole objects | Keeps the cell graph small while tables stay huge |
| Wire protocol | JSON requests (actions) and a binary response encoding (MessagePack or FlatBuffers) holding viewport tiles and diffs | Mirrors E6. The reference's exact encoding is unknown. |
| Collab | Server-authoritative operation log, sequenced per workbook (no CRDT needed, since a single process owns the workbook) | Simpler than CRDTs given the single-owner process |
| Persistence | Periodic snapshot plus an op-log tail to S3; "rehydrate" means restore the snapshot and replay ops | Fast cold start and version history for free |
| Scheduler/router | A control plane assigns each workbook to a regional node, tracks liveness and evicts idle workbooks | Matches getOrRehydrate |
| Python | Pyodide is too slow for big data. Use a server-side sandboxed CPython in its own container with Arrow zero-copy to polars | The reference uses a separate channel and polars |
| AI | Code-as-action: one `run_python` tool runs in the workbook's Python sandbox against an SDK whose functions map 1:1 to workbook actions (E17). Use the Vercel AI SDK on the server, with Bedrock or Anthropic as the provider. The workbook is network-isolated. | Matches the reference. One tool with code gives the model loops and verification, and the call log keeps it auditable. |
| Charts | A chart is stored as config plus formula expressions for each series, title and label. It is evaluated on the server and served as JSON from the workbook host (E23). | Charts update automatically with their source data, and the AI can create them just by writing formulas |
| Control plane | Postgres + a REST API (`/api/v1`), Stripe billing, OIDC/SAML SSO, SCIM | Standard SaaS setup |

### 7.3 Core protocol (v1 draft)

```jsonc
// client → server
{ "reqId": 12, "type": "action", "action": "UpdateCell",
  "args": { "cell": "0!B7", "input": "=SUM(B1:B6)" }, "clientVersion": 1 }

{ "reqId": 13, "type": "action", "action": "GetData",
  "args": { "viewport": { "anchor": "0!A1", "w": 1186, "h": 532,
            "bufX": 440, "bufY": 440 }, "tablePages": { "t1": 2000 } } }

{ "reqId": 14, "type": "presence", "selection": ["0!B7"], "cursor": [412, 96] }

// server → client (binary-encoded)
{ "ack": 12, "seq": 9812 }                 // op accepted, global sequence
{ "patch": { "seq": 9812, "cells": [...], "tables": {...} } }  // broadcast to all viewers
{ "presence": [{ "peer": "a1", "sel": [...], "color": "#F6B213" }] }
```

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Scale | Free/Pro/Business: 5 GB per workbook (about 10M+ rows). Enterprise: 1B+ rows on a scale-up node. |
| Latency | Viewport fetch p95 under 150 ms in-region. Edit→recalc→patch p95 under 300 ms for 1M-row dependents. Sort/filter of 10M rows under 2 s. |
| Cold start | Rehydrate of a 1 GB workbook under 5 s (lazy-load columns). |
| Availability | 99.9% for the control plane. A workbook node failure means rehydrate on another node with at most 5 s of data loss (op-log fsync). |
| Security | SOC 2 Type II, HIPAA (BAA), GDPR; encryption at rest (SSE/KMS) and TLS in transit. Workbooks are isolated per process. RLS is enforced by warehouse credentials. Secrets live in KMS-backed vaults. |
| Multi-region | Latency-probe region selection, plus a region lock for data residency. |
| Observability | Sentry for client errors; OpenTelemetry traces from action to engine; a per-workbook DAG diagnostics endpoint. |

## 9. Pricing & packaging (initial; benchmarked to the reference, E15)

| Plan | Price | Key limits |
|---|---|---|
| Free | $0 | 1 workbook, 5 GB, AI with a weekly quota, connectors, collaboration; no CSV export |
| Pro | $12/user/mo | Unlimited workbooks, version history, CSV export, trash |
| Business | $20/user/mo | Scheduled refresh, write-back, consolidated billing, workspace link sharing |
| Enterprise | Custom | 1B+ rows, BYOK AI, SSO/SCIM, workspaces, export restrictions, Private Link, dedicated data plane, own bucket |

Compute cost per open workbook is the main gross-margin risk. Mitigations: idle eviction after N minutes, plus snapshot-and-rehydrate on reopen.

## 10. Success metrics

- Activation: % of signups who import or connect data within 10 minutes. Target: 40% or more.
- "Big data moment": % of active workbooks with more than 1M rows.
- Weekly active editors per paid seat.
- Connected-table share: % of workbooks with a scheduled refresh (Business+). This is the governance value.
- AI: % of AI-created objects the user keeps (not undone).
- Infra: compute cost per weekly active workbook; p95 action latency.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Excel function fidelity gaps erode trust | Golden-file test suite against Excel outputs for each function; publish a compatibility matrix |
| Per-workbook compute cost | Tiered node sizes, aggressive idle eviction, columnar compression |
| Incumbent response (Excel/Sheets limits rising; Databricks now owns Row Zero, E16) | Stay warehouse-agnostic and multi-cloud; target Snowflake/BigQuery shops and SMBs that Databricks deprioritizes |
| AI data exfiltration | Network-isolated workbooks; tool broker as the only egress; BYOK |
| Collab conflicts at scale | A single authoritative process per workbook with sequenced ops |

## 12. Open questions

1. Binary frame format: build our own (FlatBuffers) or use MessagePack? The reference format was not decoded.
2. Should Python run in the workbook process (fast, less isolated) or as a sidecar (safer)?
3. Is there an XLSX export fidelity target for v1?
4. Is MCP exposure of workbooks in scope for V1 or V2?
5. Region roadmap: start in us-east-1 only, or two regions from launch?

---

## Appendix A — Reference workbook action surface (149 actions, observed E10)

AddComment, AddCommentReply, AddDataTableColumn, AddScheduledReport, AnnotateValidHyperlinks, ApplyColorSort, ApplyColumnFilters, ApplyColumnFiltersToSheet, ApplyColumnVisibility, ApplyConditionalFormat, ApplySort, ApplySortToRange, BeginFind, BeginPivot, BeginRemoveDuplicates, BeginSort, CancelEvaluation, CancelFind, CancelImport, ClearAllPivotSorts, ClearPivotLabelAliases, CompleteInitialImport, CopyPaste, CreateFilteredRange, CreateMediaContainer, CreateNamedRange, CreateNewSheet, CreatePivotDetailSheet, CreatePrototypeReportSheet, CreateSlicers, CtrlDown, CtrlLeft, CtrlRight, CtrlUp, CutPaste, DeleteComment, DeleteCommentReply, DeleteData, DeleteFilteredRange, DeleteMediaContainers, DeleteNamedRange, DeletePrototypeReportSheet, DeleteScheduledReports, DeleteSheet, DeleteSlicers, DoubleClickDrag, Drag, DragColumns, DragRows, DuplicateSheet, ExpandDateTimeFilterSet, ExplodeDataTable, FinalizeFileImport, FindOne, FormulaIntellisense, FreezePanes, GetComments, GetConnectedTableOverrides, GetConnectedTableWritebackPreview, GetDagDiagnostics, GetData, GetDataValidationListValues, GetDependencyChain, GetDistinctColors, GetDistinctColumnValues, GetFileImportPreview, GetFileImportProgress, GetFilteredRangeColumnTypes, GetNamedRanges, GetPivotTable, GetPrototypeReportSheetData, GetPrototypeReportSheetsIndex, GetScheduledReport, GetSummaryStatsForSelection, GetTextToColumnsPreview, GetWorkbookSettings, GetWorkbookTheme, GoToSelection, GroupRange, InsertCells, InsertInternalFormula, InsertRange, LogInteraction, MergeRange, NextFindResult, Ping, PreviewTextImport, Redo, ReevaluateEverything, RemoveDuplicates, RemoveHyperlinks, RemoveRange, RenameSheet, ReorderColumns, ReorderSheets, ReplaceAll, ReplaceOne, ResizeDataTable, ResyncTime, RevertTableEdit, ScrollToXYPosition, SelectAll, SetColumnVisibility, SetConnectedTableKeyColumns, SetConnectedTableWritebackManifest, SetMentionStatus, SetPivotSort, SetPivotSortSpec, SetRecalculationPaused, SetRowVisibility, SetSheetColor, SetSheetVisibility, SetWorkbookTheme, SummarizeDataTables, SummarizeFilteredRanges, TextToColumns, ToggleCodeRerun, ToggleGridlines, TogglePivotGroupExpandyCollapsy, ToggleTableSpill, Undo, UngroupRange, UnmergeRange, UpdateBorderFormats, UpdateCell, UpdateCode, UpdateColumnWidths, UpdateComment, UpdateCommentReply, UpdateConditionalFormats, UpdateConnectedTableCredentialId, UpdateConnectedTableRefreshManifest, UpdateDataTableColumn, UpdateDataTableColumnDisplayName, UpdateDataValidations, UpdateFileImportManifest, UpdateFormat, UpdateFormats, UpdateMediaContainer, UpdateNamedRange, UpdatePendingConnectedTableManifest, UpdatePivotSource, UpdatePivotTable, UpdatePrototypeReportSheet, UpdateRowHeights, UpdateScheduledReport, UpdateSheetProtection, UpdateSlicers, UpdateWorkbookSettingsV2

Use this list as the MVP/V1 backlog checklist. Every action becomes an engine command and also an AI-agent tool.

## Appendix B — Control-plane endpoints observed (E11)

`/api/2/ai/threads` (POST, SSE), `/ai/threads/{id}/turns`, `/workbooks/{id}/users`, `/workbooks/{id}/precheckAccess`, `/workbooks/{id}/history`, `/api/2/user`, `/user/about`, `/user/setFlags`, `/user/checkEmailVerification`, `/workbooks`, `/workbooks/list`, `/workbooks/{id}/getOrRehydrate`, `/folders`, `/folders/create`, `/entities`, `/entities/move`, `/entities/starred`, `/entities/destinations`, `/credentials`, `/credentials/list`, `/credentials/create`, `/credentials/addS3Credential`, `/getCredentialPermission`, `/dataSources`, `/dataSources/create`, `/dataSources/list`, `/templates`, `/templates/create`, `/templates/list`, `/templates/prepare`, `/workspaces`, `/privateEndpoints/list`, `/crossWorkbookReference/create`, `/inviteUsers`, `/checkBusinessDomain`, `/submitFeedback`, `/submitEnterpriseInquiry`, `/stripe/cancelSubscription`, `/events` (telemetry beacon)
