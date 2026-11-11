# Confirmed definitions: what comes after the first slice

Status: outline for review, 2026-11-11. Companion to `DEFINITIONS-SPEC.md` (the design) and its §11
(what is built). Every outside fact here was read from the vendor's or project's own pages on
2026-11-11; anything not confirmed is marked "not verified".

## The order, and why

| # | Item | Why here |
|---|---|---|
| A | Widgets and dashboards read definitions | Until they do, nothing a person looks at depends on a confirmed number, so drift and previews have nothing to protect. |
| B | Check numbers on a schedule, drift questions | The promise "a number never changes silently". Needs A to be worth much. |
| C | MCP server | Small, and it puts confirmed numbers into the tools people already use. |
| D | BigQuery, then Snowflake, then Databricks scans | Where customers' data is. BigQuery first: free cost estimate, a sandbox with no card, and one OAuth client works for every customer. |
| E | Imports through the Ossie converters, and native semantic objects | Cheap evidence: a company with dbt or Power BI models gets a head start. Most useful once D exists. |
| F | Sheet formulas as evidence | GridZero's own advantage: it can see what people built by hand. |
| G | Files through DuckDB | Lets a customer with no warehouse use definitions. |
| H | SaaS sources through dlt | Depends on G or D for somewhere to land the data. |
| I | Iceberg tables through REST catalogs | Reuses G's DuckDB. Last, because per-person permissions are weakest here. |

Before D, one piece of groundwork is needed (item 0).

## 0. Groundwork: sign in to a source with OAuth

Today a member saves a database user name and password. That does not carry to warehouses:

- **Snowflake is ending password-only sign-in** for people (its published rollout ends in the
  Aug to Oct 2026 phase, per account). GridZero's existing Snowflake password connection is a dead
  end; key pair still works.
- Running "as the person asking" on Snowflake, BigQuery and Databricks means OAuth per member.

What to build: `source_credential` gains a kind (`password`, `oauth`) and stores a sealed refresh
token; one callback route; token refresh before each query.

| Warehouse | What the customer's admin does once | Tokens |
|---|---|---|
| BigQuery | Nothing in their project beyond normal grants. GridZero registers one Google OAuth client; BigQuery scopes are "sensitive", so Google must verify the app. | Refresh token with offline access (standard Google OAuth, not re-verified today) |
| Snowflake | Creates a security integration for GridZero (`TYPE = OAUTH`, custom client) | Access token 10 minutes by default; refresh tokens if the integration allows them. Admin roles are blocked from OAuth. |
| Databricks | Creates a custom app connection in the account console | Access token 60 minutes, refresh token 7 days by default |

Pin the session to a read-only role where the warehouse allows it (Snowflake: scope
`session:role:<role>`; Databricks: scope `sql`, not `all-apis`).

Done when: a member connects with OAuth, a query runs as them, and a revoked token gives a clear
"sign in again" instead of an error.

## A. Widgets and dashboards read definitions

Today a widget's source is one of `snapshot`, `metric` (an uploaded Ossie model) or `sheet`.

- Add a fourth source: `{ kind: "definition", definitionId, version, groupBy, limit, shape }`.
- `propose_widget` prefers it whenever the number came from `query_definition`.
- A widget remembers the version it last showed. When a new version is published it refreshes;
  when the definition is `disputed` it shows "under review"; when unconfirmed it shows the label.
- The change preview (spec §7.3) then lists every widget and dashboard that reads the definition,
  with old and new value, by running each widget's query against the proposed body.
- Dashboards stay personal for now; the widget refreshes with its owner's sign-in.

Done when: publishing a correction shows "3 widgets on 2 dashboards change" with numbers, and those
widgets show the new number afterwards.

## B. Check numbers on a schedule, and drift questions

- Reuse the scheduler that already runs widget refreshes: a new schedule kind `source_watch`, daily,
  running as the member who turned it on. If their sign-in stops working, it pauses and says so.
- Each run does a light scan (catalog and the profiles of columns that definitions use, not the
  whole source) and reruns every confirmed metric's check query.
- A check number must be for a period that has ended, or it changes every day by design. So
  confirming a metric with a time dimension stores "last full month", and the watch reruns that
  same month. Metrics with no time dimension compare against a tolerance band instead.
- What raises a question (spec §7.4): a new value in a column a rule depends on; a column or table
  a definition uses is gone (offer the closest name); the fixed-period number moved beyond
  tolerance; a table's grain stopped holding.
- A drift question goes to the definition's owner. The confirmed version keeps serving, marked
  "under review". Nothing is rewritten automatically.
- Routing by team and by who wrote the queries (spec §6.7), left out of the first slice, belongs
  here: drift questions are the ones that most need to reach the right person.

Done when, in a test: a new status value appears, the next watch raises one question with the
number each choice gives, and the metric's value does not move until someone answers.

## C. MCP server

Verified: the current MCP revision is **2026-07-28**. Remote servers use Streamable HTTP, now
stateless (one POST endpoint, no session handshake). The older HTTP+SSE transport is deprecated.

- Mount at `/mcp` in the existing Hono service with the official packages
  (`@modelcontextprotocol/server` 2.x and `@modelcontextprotocol/hono`), which also serve older
  clients by default.
- Tools: `list_definitions`, `get_definition`, `query_definition`. Read-only. Every result carries
  status, who confirmed it and the SQL, and returns structured content as well as text.
- **Sign-in decides who can connect.**

| Client | Personal access token | OAuth |
|---|---|---|
| Claude Code, VS Code | Yes | Yes |
| Claude custom connectors | Only a beta header shared by a whole organisation | Yes |
| ChatGPT | No | Yes |

- So: ship personal access tokens first (a day or two: a `token` table, hashed, per member), which
  covers coding tools. Then make GridZero an OAuth authorization server (PKCE, client ID metadata
  documents, protected-resource metadata) to reach Claude and ChatGPT. Better-Auth, already in use,
  has an OAuth provider plugin; whether it covers client ID metadata documents is not verified.
- Queries still run with the member's own source sign-in. A member without one gets definitions but
  no numbers, as in the app.
- Skip the public MCP registry: it is in preview and lists public servers only.

Done when: Claude Code, pointed at `/mcp` with a token, answers "what was net revenue?" with the
confirmed number and who confirmed it, and an unconfirmed metric comes back marked as such.

## D. Scans on BigQuery, Snowflake and Databricks

The engine already asks for SQL and receives rows, so each warehouse needs: catalog queries, a
profiling dialect, a history reader, a cost estimate, and the OAuth from item 0.

| | BigQuery | Snowflake | Databricks |
|---|---|---|---|
| Query history | `region-X.INFORMATION_SCHEMA.JOBS`, 180 days, near real time | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`, 365 days, up to 45 minutes behind | `system.query.history`, 365 days, about an hour behind |
| Who can read other people's queries | Needs `bigquery.jobs.listAll` (Resource Viewer). Otherwise `JOBS_BY_USER`: own queries only. | Needs `GOVERNANCE_VIEWER` or imported privileges. Otherwise the 7-day table function: own queries only. | **Admin only by default, and the SQL text comes back `<REDACTED>`** unless the reader is in the PII-access group. |
| Literal values in the text | Kept (not verified) | Kept (not verified) | Redacted as above |
| Declared keys | Not enforced; in `INFORMATION_SCHEMA` | Not enforced on standard tables | Informational only |
| Cost before running | Dry run: bytes, free | `EXPLAIN`: partitions and bytes, a small cloud-services charge | `EXPLAIN COST`: a plan, no bytes or price, needs a running warehouse |
| Sampling | `TABLESAMPLE SYSTEM`, still Preview, not on views | `SAMPLE` by row or block | `TABLESAMPLE`; `n ROWS` is just a LIMIT |
| Free place to test | Sandbox, Google account, no card | 30-day trial, no official emulator | Free Edition; no account console, so no custom OAuth app |

Consequences:
- **Declared keys are hints on all three.** The scan's own uniqueness check stays the evidence.
- **History is a privilege, not a given.** Design for three levels: everyone's queries (an admin
  granted it), the member's own queries, none. The scan result says which it had. On Databricks
  the realistic default is none, so GridZero's own connected tables and sheet formulas (item F)
  matter most there.
- Unlike Postgres, BigQuery and Snowflake keep literal values, so rules such as
  `status <> 'cancelled'` can be learned from history there.
- The cost limit becomes per warehouse: bytes on BigQuery (and `maximumBytesBilled` as a hard
  stop), partitions and bytes on Snowflake, row counts from table metadata on Databricks.
- Read-only is by role and scope plus GridZero's single-SELECT check; none of the three has a
  read-only session switch.

Order: BigQuery, Snowflake, Databricks. Each needs a real account to count as done; the stand-ins in
today's tests cannot answer history or estimate queries. **This needs you to provide a test account
per warehouse** (or approve me creating trials with a throwaway address).

Done when, per warehouse: the DataDungeon harness's keys and links scores are reproduced on the
same dataset loaded into the real warehouse, and a scan of a 100-million-row table stays inside the
estimate it showed.

## E. Imports: Ossie converters and native semantic objects

Verified in `apache/ossie-converters` (HEAD of 2026-11-11):

| Source | Converter | Can import into Ossie? | Input |
|---|---|---|---|
| dbt / MetricFlow | Python | Yes | `semantic_manifest.json` (not the raw YAML) |
| Power BI | Python | Yes | `model.bim`, or a `.pbip` / TMDL folder (TMDL needs Microsoft's .NET library) |
| Cube | Python | Yes | YAML models only |
| Databricks metric views | Java 21 | Yes | Metric view YAML v1.1 |
| LookML | Python | **No, export only** | — |
| Snowflake | Python | **No, export only** (to Cortex Analyst YAML) | — |

So two of the six on your list cannot be imported through the converters today:
- **LookML:** wait for the converter's import (on its roadmap), or parse LookML ourselves. I would wait.
- **Snowflake semantic views:** read them directly instead. `SHOW SEMANTIC VIEWS` lists them and
  `SYSTEM$READ_YAML_FROM_SEMANTIC_VIEW` returns the definition as YAML. Small mapping of our own.
- **Databricks metric views** can also be read live: the YAML is in the view text of
  `DESCRIBE TABLE EXTENDED … AS JSON` (seen in search results, not opened directly), then through
  the converter.

How:
- The converters are not on PyPI and there is no single command. Build a sidecar image (Python 3.12,
  uv, a Java 21 runtime with the Databricks jar) pinned to one converters commit; the control
  service runs one converter per upload on temporary files, with no network.
- **Version trap:** the converters write Ossie `0.2.0.dev0`; core `main` is `0.3.0.dev0`, which is
  what GridZero exports today. Read both, and decide which one to write (see "Decisions").
- Everything imported arrives as `inferred` with evidence "Imported from the dbt model `orders`",
  goes through C10 and the other checks, and raises a conflict question when it disagrees with what
  the scan found. An import is evidence, not a confirmation.
- Add Ossie's own validator and compliance fixtures to CI for our export.

Done when: a dbt project's manifest becomes draft definitions with their metrics matched to scanned
tables, and a metric that disagrees with query history raises one question with both numbers.

## F. Sheet formulas as evidence

What exists: a Data Table's computed columns are stored as formulas (`[revenue] * (1 - [discount])`),
pivots store their value fields and aggregations, and connected tables record the SQL they came
from. Cell formulas live in the workbook engine. Agents can already read tiles through the host.

- Add one read-only host action, `GetDefinitionsEvidence`, returning for a workbook: connected
  tables (source SQL, table id), computed columns (name, formula), pivots (source table, values and
  aggregation, filters) and named ranges. No cell values.
- Map each back to source columns through the connected table's SQL (sqlglot already resolves
  this), so "a pivot summing `amount` filtered to status = completed" becomes a named-total
  observation like any other, with the person who built it.
- Evidence text: "Same total in 3 workbooks by 2 people."
- Only workbooks owned by or shared with workspace members are read, and only their structure.
- Plain cell formulas (`=SUMIFS(…)` over a range) are a later step: they need range-to-table
  tracing and are much noisier.

Done when: a pivot built by two people on a connected table shows up as usage evidence on the
matching metric, and a computed column nobody else uses does not become a metric.

## G. Files through DuckDB

Verified: DuckDB 2.0 (LTS, October 2026), MIT. Reads Parquet, CSV, JSON and XLSX, locally and over
HTTP and S3. It has `information_schema`, so the engine's scan SQL runs on it as it did in the
proof. The Node client `@duckdb/node-api` is current but still marked incomplete; the Python client
is complete.

- A new source kind `files`: a set of uploaded files, or the Data Tables of chosen workbooks
  (already Parquet on the workbook host).
- Run DuckDB in a Python worker beside the semantic engine, not in the control process, one process
  per job, in the existing bubblewrap sandbox. Lock it down: external access off except an allowed
  directory, extensions preloaded then installs disabled, configuration locked, memory and thread
  limits. DuckDB's own docs say these settings are not a substitute for a sandbox; use both.
- "Runs as the person asking" becomes "the person can open the file or workbook", checked by
  GridZero, since a file has no permissions of its own.
- Files above memory stay on disk; DuckDB streams Parquet, which removes today's "Data Tables load
  fully into memory" limit for scanning.

Done when: a workbook with two imported files gets entities, a link between them and a metric, and
an agent answers from the confirmed metric.

## H. SaaS sources through dlt

Verified: dlt 1.32, Apache-2.0, a Python library. It has 3 general sources (REST API, SQL
databases, files) and 31 maintained ones, including HubSpot, Salesforce, Stripe, Shopify, Zendesk,
Jira, Notion and Google Ads. It loads into 25 destinations, among them DuckDB, Postgres, Snowflake,
BigQuery and Databricks.

- GridZero does not become a warehouse: dlt loads into the customer's own warehouse when they have
  one (then item D scans it), or into a DuckDB/Parquet store per workspace (then item G scans it).
- One worker process per tenant per run, with that tenant's credentials passed as arguments. dlt's
  global secrets and environment variables must not be used: they would be shared across tenants.
- dlt's schema file is evidence the scan cannot get elsewhere: primary keys, merge keys, parent and
  child links and column descriptions as the SaaS API declares them. Import it as `declared`.
- Start with three sources customers ask for (my guess: Stripe, HubSpot, Salesforce) and the
  generic REST source. Incremental loads; state is kept in the destination.
- SaaS OAuth: Composio already handles app sign-in for agents. Whether its tokens can be handed to
  dlt is not verified; if not, each source needs its own OAuth app.
- Licence boundary: the library and listed sources are Apache-2.0. dltHub sells a separate package
  (change data capture, a "premium" Iceberg destination). The open Iceberg support versus the paid
  one is unclear on their pages and matters for item I.
- Alternatives, unchanged from the spec: Airbyte and PyAirbyte are both ELv2, which forbids
  offering them as a hosted service; Fivetran's embedded product has a $12k annual minimum and
  prices on usage across all end customers.

Done when: a workspace connects Stripe, charges land in its store, and "refunded charges" is asked
as a question with numbers.

## I. Iceberg tables through REST catalogs

Verified: Iceberg format versions 1 to 3 are adopted. Catalogs that speak the REST API include
Apache Polaris (1.8, top-level project), Databricks Unity Catalog, AWS Glue and S3 Tables, Google's
BigLake metastore, Microsoft OneLake and Cloudflare's catalog. **Snowflake Open Catalog no longer
takes new customers** and sends them to Horizon. DuckDB's Iceberg extension attaches to a REST
catalog with OAuth or a bearer token and uses credentials the catalog hands out per table.

- A source kind `iceberg`: catalog URL, warehouse name, and each member's own catalog sign-in.
  Reuse item G's DuckDB worker: `ATTACH … (TYPE iceberg, …)`, then the same scan SQL.
- Cheaper scans: schema, column comments, per-file null counts and min/max, and row totals come
  from Iceberg metadata without reading data. Distinct counts are only there if an engine wrote
  them, so the scan still samples.
- Declared keys: Iceberg's identifier fields, which the spec says are not guaranteed unique. A hint.
- **The weak point is permissions.** A catalog hands out storage credentials for a whole table.
  Row filters and column masks are generally not applied to outside engines such as DuckDB. So
  "warehouse permissions still apply" holds at table level only. Either say so plainly and let an
  admin exclude tables, or, for tables that have row or column policies, query through the owning
  engine (item D) instead. I recommend the second as the rule.
- A per-person sign-in needs the catalog to accept a user token; a shared service principal would
  break "runs as the asker". Glue documents exchanging a user's token; others vary.

Done when: a Polaris catalog (run locally in tests) is scanned, a metric is confirmed, and a member
without a grant on a table gets no number from it.

## Gaps from the first slice, and where they close

| Gap | Closes in |
|---|---|
| Questions routed only to owner or first admin | B |
| Time zone, late data and duplicate answers stored but not applied | Its own step after A: each needs a tested SQL rewrite (latest copy per id, local-time bucketing) |
| Metrics cannot cross a one-to-many link | Same step: total the child per parent first, as the IV-01 solution does |
| Preview lists metrics, not widgets | A |
| AI spend for names and corrections not counted | Small change with A: record spend without an agent |
| First-rows sampling | D (each warehouse's own sampling clause) |
| Members need an existing account | With C's OAuth work: invitations by email |

## Decisions I need from you

1. **Test accounts** for BigQuery, Snowflake and Databricks: do you provide them, or may I create
   trial accounts with a throwaway address?
2. **Which Ossie version to write:** the released 0.1.1, the converters' 0.2.0 draft, or core's
   0.3.0 draft that we write today. I recommend reading all and writing 0.2.0 until the converters
   move, because the point of exporting is that other tools can read it.
3. **Iceberg tables with row or column policies:** refuse to scan them directly (my recommendation),
   or scan with a warning.
4. **LookML:** wait for the converter's import (my recommendation), or write our own parser.
5. **OAuth for MCP now or later:** tokens alone reach coding tools; Claude and ChatGPT need OAuth.
