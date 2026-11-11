# GridZero

A cloud spreadsheet for billion-row data (a Row Zero–class product).

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Engineering plan: [docs/BUILD-SPEC.md](docs/BUILD-SPEC.md)
- Spike reports: [docs/spikes/](docs/spikes/)

## Layout
See BUILD-SPEC §12. The Rust crates live in `crates/` and `spikes/` (a single Cargo workspace). The TypeScript packages live in `apps/` and `services/` (a pnpm workspace).

## Status: Milestone 0
- [x] Monorepo scaffold
- [x] S1 IronCalc gate: **PASS** ([report](docs/spikes/S1-ironcalc.md))
- [x] S2 canvas grid spike: **PASS** ([report](docs/spikes/S2-canvas-grid.md))
- [x] S3 Polars import spike: **PASS** ([report](docs/spikes/S3-polars-import.md))
- [x] Infra: GitHub Actions CI, Postgres, email/password auth, staging on Railway. **M0 gate passed:** sign up → empty home page in staging.
- [x] Preview environments per pull request: Railway PR environments, forked from `staging` with their own Postgres and domain, and removed when the PR closes

## Status: Milestone 1 (single-user editing)
- [x] Workbook host (`crates/wbhost`): one actor thread per workbook, routing tokens signed by the control plane, idle eviction with a snapshot
- [x] Engine on IronCalc `UserModel`: Session, Cells, Formatting, Sheets, Navigation and Names action groups (BUILD-SPEC §5.2)
- [x] Durability: op-log of IronCalc diffs (fsync before ack), snapshot every N ops, exact replay on rehydrate
- [x] Web: canvas grid with formulas, number formats, borders, merges, freeze panes, resize, sheet tabs, find/replace, named ranges, context menus, Excel shortcuts and TSV paste
- [x] Home page: workbook list, create, rename, delete
- [x] Acceptance suite (`tests/e2e`, runs in CI): persistence across reload and restart; no acked edit lost on SIGKILL; 50-step undo/redo; 10k-cell TSV paste; Ctrl+arrow, freeze, merge, formats and borders; §8 budgets

| §8 budget (release build) | Measured | Budget |
|---|---|---|
| Warm open p95 | 13 ms | ≤ 800 ms |
| UpdateCell → Changed p95, 100k-formula sheet | 59 ms | ≤ 120 ms |
| Cold rehydrate (snapshot + op-log) | 14 ms | — |

Known M1 gaps: undo history is per workbook and shared by everyone editing it; workbook data lives on the host's local volume (S3 snapshots come later); conditional formats and data validation are M3.

## Status: Milestone 2 (big data)
- [x] Import pipeline: browser uploads (gzip-compressed in the browser) or URL imports go straight to the workbook host and are staged decompressed; preview dialog with destination, import type (cells or Data Table), header row, separator/quote autodetect and skip-N-rows. Formats: CSV/TSV/TXT, JSONL, Parquet, XLSX, each optionally `.gz`
- [x] Data Tables (`crates/tables`): Polars frames anchored at a cell, immutable Parquet per version, a JSON manifest op-logged with each change; scroll past Excel's 1,048,576-row limit
- [x] Computed columns: Excel-like formulas (`=[revenue] * (1 - COALESCE([discount], 0))`) compiled to Polars expressions
- [x] Sort, filter (by values or condition) and distinct values for tables and for filtered ranges of cells; remove duplicates; text to columns; selection stats (sum, average, count, min, max)
- [x] Re-importing to the same destination replaces the data; dependent cell formulas and computed columns recompute
- [x] One undo history for cells and tables (ReplaceAll and Freeze are now one undo step each)
- [x] Acceptance suite `tests/e2e/m2.test.mjs`, run at full size in CI

| §8 budget (release build, laptop) | Measured | Budget |
|---|---|---|
| Import 5M-row CSV (upload, preview, finalize) | 3.3 s | ≤ 45 s |
| Sort 5M rows (one column) | 0.54 s | ≤ 2 s |
| Filter 5M rows (one column) | 0.20 s | ≤ 2 s |
| Computed column over 5M rows | 0.24 s | ≤ 3 s |
| Import 1M-row XLSX | 12 s | — |
| Scroll the 5M-row table in the browser | draw p99 2.3 ms, 0 blank frames at 20k px/s, jump fill 18 ms | 60 fps, no blank frame > 100 ms |

Known M2 gaps: cell formulas cannot reference Data Table cells yet (tables feed computed columns now, and pivots in M3); `.zip` uploads; Data Tables load fully into memory (no streaming for files larger than RAM); sorting a range moves values and formulas but not cell styles.

## Status: Milestone 3 (analysis objects)
- [x] Pivot tables over Data Tables or ranges: Rows / Columns / Values / Filters pane; Sum, Count, Count unique, Average, Min, Max, Median, Percentile; date grouping (year, quarter, month, day); grand totals. Output is read-only and recomputes when the source changes
- [x] Charts (ECharts, loaded on demand): column, bar, line, area, scatter, pie, histogram, combo series and a right axis; every series is a reference evaluated on the server, skipping filtered-out rows; drag to move or resize
- [x] Slicers: a chip that edits one column filter of a Data Table or filtered range, so every pivot and chart reading that source follows it
- [x] Conditional formatting on IronCalc's rules (value, text, blanks, duplicates, top/bottom N, above/below average, formula, color scales, data bars, icon sets: arrows, traffic lights, flags, symbols)
- [x] Cell formulas read Data Table and pivot cells (`=B5`, `=SUM(F2:F9)`, `=SUM(sales!C:C)`, `VLOOKUP` over a pivot) and recompute when the table is sorted, filtered or re-imported or the pivot changes
- [x] Pivot drill-down: double-click a pivot value or label to get the source rows behind it as a Data Table on a new sheet
- [x] Chart data over HTTP: `GET /wb/{id}/chart/{chart}?token=` returns the evaluated series as JSON, with an ETag so an unchanged workbook answers 304
- [x] Dropdown lists (data validation) from typed values or a range, enforced on edit
- [x] References in the object manifest (chart series, pivot sources and anchors, slicers, validations, tables, filters) shift with inserted and deleted rows and columns; tables and pivots can now move down when rows are inserted above them
- [x] Acceptance suite `tests/e2e/m3.test.mjs` (full size in CI)

| §8 budget (release build, laptop) | Measured | Budget |
|---|---|---|
| Pivot 5M rows, 2 group-bys, 1 sum (update → tiles) | 0.10 s | ≤ 3 s |

Known M3 gaps: formulas see at most 10,000,000 table or pivot cells at once (and only rows above Excel's 1,048,576 limit); table-name references cover single columns, not `[#All]` or `[@column]`, and are recognised when typed into a cell, not in pasted text; text values formulas read from tables stay in the workbook's shared-string list until the workbook is rebuilt.

Pivots with two or more row fields have +/− toggles on their groups. `=SUM(sales[units])` reads a Data Table column by name and follows the table as it grows or filters; tables with spaces in their names are written with `_` (`my_data[units]`).

### M4: collaboration and sharing

Everyone on a workbook sees each other's selections, and clicking someone's avatar follows them. **File** has comments, version history (name, preview, restore), make a copy and move to trash; workbooks stay in Trash for 7 days. **Share** invites people as editors or viewers by email, or opens the workbook to anyone signed in who has the link.

Set `RESEND_API_KEY` and `MAIL_FROM` on the control service to send invitation emails. Without them the share dialog shows an invitation link to pass on by hand. `MIRROR_MAX_CELLS` on the workbook host sets how many table or pivot cells formulas can read (default 10,000,000). Reading all 10 million took about 2.5 GB on the host, and every later edit in that workbook recalculates all of it, so give the host enough memory or lower the limit.

Known M4 gaps: undo is still shared by everyone on a workbook; invitations are single-use links because sign-up does not verify email yet; `?copy` links that give each visitor a copy and share expiry dates are not built; link access needs an account; comments have no @mentions; versions live on the workbook host's volume, not in Postgres (BUILD-SPEC Q12).

### M5: Python

**File → Code editor** opens a shared Python window. **Run** (Ctrl+Enter) runs the module, and its top-level functions become spreadsheet functions: define `double`, then use `=double(B1)`. With **Execute on wake** on, the module runs again whenever the workbook loads. Code can use `import gridzero as gz` (`services/sandbox/gridzero.py`) to read cells and tables and, from a Run, to change the workbook.

Python runs inside [bubblewrap](https://github.com/containers/bubblewrap) with no network. The workbook host's image includes it. Hosts that forbid it, like Railway, use Landlock and seccomp instead (`services/sandbox/lockdown.py`, x86-64 Linux only), which share the host's kernel and so are a weaker boundary. If neither can be applied, Python is refused. To try Python on a machine without it, create `services/sandbox/venv` from `services/sandbox/requirements.txt` and set `SANDBOX_DIR`, `SANDBOX_PYTHON` and `SANDBOX_ALLOW_UNISOLATED=1`; that mode has no real isolation.

Known M5 gaps: the AI panel is not built; a Run blocks everyone on that workbook until it ends (at most 120 s); custom functions are assumed to depend only on their arguments, since results are remembered until the next Run; a function returns one value, and dates arrive as numbers; `run_query` raises an error; limits are per process (4 GB of address space, 4 threads per library, 120 s per Run).

### M6: connections and connected tables

**Data → Connected tables…** saves a connection and turns a SQL query into a Data Table that can be refreshed by hand or on a schedule. The control service needs `CONNECTION_SECRET_KEY` (any long random string); keep it safe, because changing it makes saved connections unreadable.

| Warehouse | Signs in with | Notes |
|---|---|---|
| Postgres | User and password | Streams with `COPY`, inside a read-only transaction |
| Amazon Redshift | User and password | Port 5439 by default; reads through a cursor, inside a read-only transaction |
| Snowflake | Password or key pair | SQL API |
| Databricks | Personal access token | SQL Statement Execution API on a SQL warehouse; results up to 25 MB |
| Google BigQuery | Service account key (JSON) | Standard SQL; the account needs BigQuery Job User and Data Viewer |

Sharing, copies, trash and connection events are in `audit_events` (`GET /api/v1/workbooks/:id/audit`, owner only).

`tests/load/many-workbooks.mjs` runs many active workbooks and reports edit latency and host memory.

Known M6 gaps: Stripe and plan limits are not built; Snowflake, Databricks and BigQuery have only been tested against stand-ins for their APIs, and Redshift only against Postgres, not real accounts; Snowflake, Databricks and BigQuery queries are only as read-only as the role, token or service account you give them; SQL Server, Oracle, Teradata, Athena and S3 are not built; the 4-host target needs routing between hosts, which does not exist yet; `run_query` from Python is not connected.

**File → Download this sheet as CSV** exports a sheet's displayed values (cells, Data Tables as currently filtered, pivot output) from `GET /wb/{id}/export.csv?token&sheet` on the workbook host.

**Account** (`/account`) deletes the account: `DELETE /api/v1/account` with the password and `confirm: "DELETE"` purges every owned workbook from the host, then removes the user with their shares, sessions and connections. **Terms** and **Privacy** (`/terms`, `/privacy`) are drafts that describe how the app handles data today; the bracketed company name, contact and date must be filled in, and a lawyer should review them before launch.

**Errors.** The control service logs every server error, and every browser error reported to `POST /api/v1/client-errors`, as one JSON line. Set `SENTRY_DSN` on the control service to also send them to Sentry (`SENTRY_ENVIRONMENT` defaults to the Railway environment name); the DSN never reaches browsers.

`vendor/ironcalc_base` is IronCalc 0.9.1 with one accessor added (`UserModel::get_model_mut`); see `vendor/README.md`.

## Agents and dashboards

Full spec: `docs/AGENT-BUILD-SPEC.md` (the product plan is `docs/AGENT-DASHBOARD-PLAN.md`).

**Setup.** Agents run on `claude-opus-5-5`. A person can bring their own key under **AI settings** (`/settings/ai`): an Anthropic key, or an OpenRouter key, which reaches the same model. The key is checked with its provider, stored sealed with `CONNECTION_SECRET_KEY`, and never shown again. A monthly spending cap (default $20) stops runs once reached, and the same page shows a setup checklist and spend by day and by agent.

Set `OPENROUTER_API_KEY` on the control service to include some AI for people who have no key of their own. Their runs then go through OpenRouter on that key, up to `PLATFORM_AI_USER_CAP_USD` per person per month (default $2) and `PLATFORM_AI_TOTAL_CAP_USD` for everyone together (default $100). Past either, they are asked to add their own key. Sign-up does not verify email, so the total cap is what limits abuse; also set a spending limit on the key at OpenRouter.

**Agents** (`/agents`). An agent has a name, avatar and instructions. Chat replies stream in with each tool step shown; agents can search the web and read pages, and their history is kept per agent.

**Uploaded tables.** Ask an agent about a file you imported as a Data Table and it looks at the whole table, not the first rows: `list_tables` profiles every column, drafts definitions and raises the questions that decide what the numbers mean (a person with no workspace gets one of their own, with the workbook as a source), and `query_tables` runs read-only SQL over every row with DuckDB, in a worker that can read those tables and nothing else. Dashboard widgets can rerun such a query or a shared definition, so they follow the data without a summary sheet. Limits: a table must sit alone at the top of its sheet and have at most 2,000,000 rows, and a filter applied in the sheet also limits what queries see (the agent is told).

**Workbook and warehouse tools.** Agents can list and read workbooks, run SQL on the user's saved connections, write a CSV to a new Data Table and make charts. Once an agent has read a sheet, a query result, a metric or app data, web search and fetch are switched off for the rest of that run, so private data is not sent to the web.

**The shell.** Every signed-in page sits in one frame: a rail for sections, a list for the section you are in, tabs for what is open, the agent in a panel on the right (told which workbook or report is open), and a bottom bar that says how far the numbers on screen can be trusted. Search is Ctrl K; the agent panel is Ctrl J; light and dark themes are under the cog. Open any page once with `?preview=1` to see the 47 planned screens under `/preview`: they hold sample data and each lists what it needs from the backend (`docs/specs/BACKEND-NEEDS.md`, written by `node apps/web/scripts/backend-needs.ts`).

**Metrics** (`/metrics`). Upload an [Apache Ossie](https://github.com/apache/ossie) semantic model for one connection; GridZero compiles a metric, with grouping and filters, to that warehouse's SQL. Agents prefer metrics over writing SQL, and a model exports back byte-for-byte for use in other tools.

**Definitions** (`/definitions`). A workspace (a company or team, with admins, editors and viewers) connects a Postgres source; each member signs in to it with their own database user, and every query runs with that member's access. A scan reads the catalog, column profiles and query history, drafts tables, links, metrics and rules with the evidence for each, and asks only what the data cannot settle, each choice with the number it gives. People confirm or correct definitions (old and new numbers show before a change is published), and agents answer from confirmed definitions or the server labels the reply "Unconfirmed". Confirmed definitions export as Apache Ossie. A confirmed number, or an agent reply someone marks as correct, becomes a trusted answer: agents are shown it first, and it is a test the agent is put through again whenever its prompt, tools or model change. Spec and what is not built yet: `docs/specs/DEFINITIONS-SPEC.md`. The scan needs Python 3.10+ with `pip install -r services/semantic/requirements.txt` (set `SEMANTIC_PYTHON` if it is not `python3`).

**Dashboards** (`/dashboards`). An agent proposes a widget in chat (number, trend, bars, table, list or text, in up to three designs) and the user adds one to a dashboard. Widgets refresh from a metric, a workbook range, or by re-running the agent on its prompt; cards can be resized, restyled, reordered and deleted. New dashboards can start from the Sales or Ops template, which adds a matching agent.

**Schedules.** A widget refresh or an agent task can run daily or weekly in the user's local time. Scheduled runs only read: they never get tools that write, propose widgets or act in apps, and a task's answer appears in the agent's chat.

**Connected apps** (`/apps`). With `COMPOSIO_API_KEY` set, users connect Gmail, Slack, Notion, GitHub and six more apps. Agents read from them directly; anything that sends, creates, changes or deletes becomes an approval card, and approving runs exactly the arguments shown, once. See `services/control/src/apps/README.md`.

Known gaps: definitions scan Postgres only and have not been run against a customer's database; the Docker image change that adds Python for the scan has not been built; the Composio integration is typechecked against its SDK but has not been run against a live Composio project; all agent tests use a stand-in for the Anthropic API, so a manual check with a real key is still needed; the security review is in `docs/SECURITY-REVIEW.md`.

## Environments
| Env | URL | Hosting |
|---|---|---|
| Staging | https://control-staging-1dfe.up.railway.app | Railway project `gridzero`, environment `staging`: Postgres plus a `control` service built from the root `Dockerfile` on every push to `master` |
| Staging workbook host | wss://wbhost-staging.up.railway.app | `wbhost` service built from `crates/wbhost/Dockerfile`, with a volume at `/data` |
| PR previews | `control-gridzero-pr-<n>.up.railway.app` (posted on the PR by Railway) | One Railway environment per open pull request, cloned from `staging` |
| Production | https://control-production-6a47.up.railway.app | Environment `production`: its own Postgres, workbook host (`wss://wbhost-production.up.railway.app`) and secrets. It deploys from the `production` branch, not `master` |

**Releasing to production:** once a change has been checked on staging, fast-forward the `production` branch to it (`git push origin master:production`); Railway deploys it. Production's Postgres and workbook volumes have Railway backups daily (kept 6 days), weekly (27 days) and monthly (89 days); restore from the volume's Backups tab.

`BETTER_AUTH_URL` is set to `https://${{RAILWAY_PUBLIC_DOMAIN}}` so each environment trusts its own domain.

Staging deviates from BUILD-SPEC D14 (AWS) on purpose: the move to AWS is deferred until workbook hosts exist (M1).

## Local development
```bash
pnpm install
# Postgres: any local instance, or in-memory PGlite: npx @electric-sql/pglite-socket --port=54329 --max-connections=10
cp services/control/.env.example services/control/.env   # then set DATABASE_URL and a random BETTER_AUTH_SECRET
pnpm --filter @gridzero/control dev    # API on :8787, runs migrations on boot
pnpm --filter @gridzero/web dev        # app on :5173, proxies /api to :8787
pnpm --filter @gridzero/control test   # API integration tests (need DATABASE_URL)
cargo run -p wbhost                    # workbook host on :8790 (set WB_TOKEN_SECRET to match control's .env)
cargo build --release -p wbhost && cargo build --release -p importer --features fixtures --bin gen-fixtures
E2E_RELEASE=1 pnpm --filter @gridzero/e2e test   # M1 + M2 acceptance suites (needs DATABASE_URL; E2E_HEAVY=1 for full-size budgets)
pnpm --filter @gridzero/control db:generate   # new migration after editing src/db/schema.ts
```

## Rust
```bash
cargo check --workspace
cargo run --release -p s1_ironcalc -- all   # S1 gates
```
