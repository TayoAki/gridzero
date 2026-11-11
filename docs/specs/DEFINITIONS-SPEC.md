# Confirmed definitions: the data platform layer

Status: draft for review, 2026-11-10. Owner: product. Builds on `docs/AGENT-BUILD-SPEC.md` §7 (metrics).

## 1. What this is

A business user connects a data source. GridZero works out the structure (what each table is, how
tables link), the metrics (revenue, active customers) and the business rules ("test orders don't
count"), then asks a person to confirm or correct them. Sheets and agents answer metric questions
only from what has been confirmed, or say clearly that an answer is unconfirmed.

The idea in one line: **the data narrows, the names suggest, usage confirms, and a person decides.**
No single signal is enough (the first probe on DataDungeon's data showed data alone proposes 22 keys
where 6 are real, and 15 links where 4 are real).

### 1.1 What GridZero has today (read from the code, 2026-11-10)

| Area | Today |
|---|---|
| Sources | A `connection` is one saved credential for Postgres, Redshift, Snowflake, Databricks or BigQuery, owned by one person. Nobody else can use it. |
| Reading a source | Only SQL someone typed. No catalog scan, no column profiles, no query history. |
| Definitions | A `metric_model` is an Apache Ossie YAML file uploaded by hand, stored unchanged, single-table only. No status, evidence, checks or owner. |
| Agents | Told by the system prompt to prefer a metric over SQL. Not enforced; answers are not labelled. |
| People | Email and password. No workspaces or teams. Only workbooks can be shared. |
| Safety | Read-only is enforced by the database for Postgres and Redshift, by a keyword check elsewhere. No cost estimate. No MCP server. |

### 1.2 Decisions this spec rests on

Made by the product owner:

1. GridZero does not build a warehouse, query engine, BI tool or connector library. Heavy work runs
   in the customer's warehouse. Connectors for files and SaaS apps come from a partner or open source (§12).
2. Open formats: Iceberg tables through standard REST catalogs, sqlglot for SQL dialects, DuckDB for
   files and local work.
3. Definitions export to Apache Ossie. Agents and other AI tools reach confirmed metrics over MCP.
4. Queries run as the person asking, so warehouse permissions still apply. Read-only, with a cost
   estimate before running.
5. Every change shows a preview (which answers and dashboards change) before it is published.
6. **Workspaces are added now.** A workspace owns sources and definitions and has members with roles.
7. **Each person uses their own credential.** A shared source holds the address; each member saves
   their own sign-in for it.
8. **Postgres is the first source type**, because it is the one GridZero can test for real.

## 2. Words used here

| Word | Meaning |
|---|---|
| Workspace | A company or team. Owns sources, definitions, questions and their history. |
| Member | A person in a workspace: `admin`, `editor` or `viewer`, with an optional team label ("Finance"). |
| Source | A place data lives (a warehouse database). Holds the address, never a secret. |
| Source credential | One member's own sign-in for one source, sealed like today's connection secret. |
| Scan | One read of a source's catalog, column profiles and query history. No AI. |
| Definition | One shared fact about the data: an entity, a link, a dimension, a metric or a rule (§4). |
| Evidence | Why GridZero believes a definition: "used in 214 queries by 9 people". |
| Check | A test run on a definition (§5). The set of checks is the grader. |
| Check number | The value a confirmed metric returned for a fixed period at confirmation. Rerun to detect drift. |
| Question | Something the data cannot settle, put to a person with numbered choices (§6). |
| Change | A proposed edit to a definition, with old and new numbers, waiting to be published (§7). |

## 3. The flow

```
Connect → Scan → Draft → Check → Interview → Confirm and correct → Enforce and watch
          (no AI)  (AI)   (no AI)   (AI words,     (person)            (no AI to decide,
                                     data numbers)                      AI to explain)
```

### 3.1 Connect

- An admin or editor adds a source to the workspace: kind, name and address (host, port, database, schema).
- Each member who wants to run queries saves their own credential. A member without one can read
  definitions and stored answers but cannot run anything.
- Warehouses first. Files (through DuckDB) and SaaS apps (through a connector partner) reuse the same
  later stages: once data is a table, the flow does not care where it came from.

### 3.2 Scan (no AI)

Runs as the member who started it, with their credential. Everything below is collected by SQL that
runs in the warehouse; GridZero stores results, never whole tables.

| Collected | How | Used for |
|---|---|---|
| Catalog | `information_schema` (tables, columns, types, declared keys, comments) | Entities, declared keys and links |
| Column profiles | One aggregate query per table: row count, distinct and empty counts per column, min and max; up to 20 most common values for columns with few distinct values | Key candidates, status-like columns, test flags |
| Key candidates | Unique and never empty, with a name that looks like a key | Entity grain |
| Link candidates | Every value of column A appears in key K of another table, and the names match | Links with cardinality |
| Query history | The warehouse's own log (Snowflake `QUERY_HISTORY`, BigQuery `INFORMATION_SCHEMA.JOBS`, Databricks `system.query.history`, Postgres `pg_stat_statements`), plus the SQL of every GridZero connected table on this source | Which joins, measures and filters people really use, how often, by how many people |
| Sheet formulas | Formulas and computed columns over connected tables in GridZero workbooks | Measures people built by hand (later slice) |
| Existing definitions | Ossie YAML and, through the Ossie converters, dbt/MetricFlow, LookML, Power BI models, Snowflake semantic views and Databricks metric views | Imported as `inferred` with evidence "imported from …" |

Rules:
- Tables above 1,000,000 rows are profiled on a sample (the warehouse's own sampling clause) and the
  scan says so.
- A scan has a row and time budget shown before it starts (§9.3).
- Query history is parsed with sqlglot into joins, named measures and filters. Query text is kept only
  as counts and normalised fragments; literal values are replaced with `?` unless they are short
  category values (`'cancelled'`), which rules need.
- History is optional. Without it the scan still works; definitions just have weaker evidence.

### 3.3 Draft (AI)

Input: the scan's evidence, never raw rows beyond the common-value samples. Output: definition records
with status `inferred`.

- **Deterministic first.** Keys, links, recurring measures and recurring filters come from the scan
  by rule. They exist even with no AI key.
- **Then AI** names things in business language, writes one-line descriptions, groups measures that
  are the same idea under different names, proposes dimensions, and proposes rules that the data hints
  at (a `status` column with the value `cancelled`; an `is_test` flag).
- Each definition gets a confidence (`high`, `medium`, `low`) computed from its evidence, not chosen
  by the AI (§4.3).
- The AI may not invent a column or table. Every expression is parsed and checked against the catalog;
  anything that does not resolve is dropped and logged.

### 3.4 Check (the grader, no AI)

Every drafted or edited definition is run through the checks in §5. A failed check does not delete
the definition; it lowers confidence, sets `needs_answer`, and usually becomes a question.

### 3.5 Interview

GridZero asks only what the data cannot settle, ranked, about 5 to 10 at setup (§6).

### 3.6 Confirm and correct

A person confirms a definition as it stands, or corrects it in plain English. The AI rewrites the
definition, the checks rerun, and the old and new numbers show side by side before anything is
confirmed (§7).

### 3.7 Enforce and watch

Agents answer from confirmed definitions or label the answer (§8). Each confirmed metric keeps a
check number, and drift raises a question instead of silently changing a number (§7.4).

## 4. The definition record

One row per definition, one table for all five kinds. Table `definition`.

### 4.1 Common fields

| Field | Type | Notes |
|---|---|---|
| `id` | text | |
| `workspace_id`, `source_id` | text | |
| `kind` | `entity` \| `link` \| `dimension` \| `metric` \| `rule` | |
| `name` | text | Machine name, unique per workspace and kind: `net_revenue`. |
| `label` | text | What people see: "Net revenue". |
| `description` | text | One or two plain sentences. |
| `body` | json | Kind-specific (§4.2). |
| `status` | `inferred` \| `needs_answer` \| `confirmed` \| `disputed` | §4.4 |
| `confidence` | `high` \| `medium` \| `low` | Computed (§4.3). |
| `evidence` | json list | §4.3 |
| `owner_id` | member, optional | Who answers questions about it. |
| `confirmed_by`, `confirmed_at` | member, time | Set only by a person. |
| `check_number` | json, optional | `{ sql, value, period, taken_at, tolerance }`, metrics only. |
| `version` | integer | Goes up with each published change. |
| `created_at`, `updated_at` | time | |

### 4.2 Bodies

- **entity**: `{ table, grain: [columns], grain_holds: true|false|unknown, row_count }`. "One row per order."
- **link**: `{ from_entity, from_columns, to_entity, to_columns, cardinality: "many_to_one"|"one_to_one", coverage }`.
  `coverage` is the share of `from` rows that find a match.
- **dimension**: `{ entity, expression, is_time, values?: [..] }`.
- **metric**: `{ entity, expression, filters: [rule names], time_dimension?, unit?, additive: true|false }`.
  `expression` is one aggregate in the source's dialect; rules it depends on are named, not copied in.
- **rule**: `{ entity, expression, meaning }`, a filter with a business name: `active_hero` = `is_active = TRUE`.

Expressions are stored in the source's own dialect and transpiled with sqlglot for export.

### 4.3 Evidence and confidence

Each evidence item is `{ type, text, count?, people?, ref? }`. `text` is the plain sentence shown to people.

| Type | Example text |
|---|---|
| `declared` | "Declared as the primary key in the database." |
| `profile` | "Unique and never empty in 48,210 rows." |
| `name` | "Column name matches the key `customer_id`." |
| `usage` | "Used in 214 queries by 9 people in the last 90 days." |
| `import` | "Imported from the dbt semantic model `orders`." |
| `sheet` | "Same formula in 3 workbooks." |
| `check` | "Matches Finance's reported $1.11M for October." |
| `conflict` | "`total_gold` is SUM(gold) in 4 queries and SUM(value_gold) in 1." |
| `answer` | "Confirmed by Priya Nair on 12 Nov 2026." |

Confidence is a rule, so the same evidence always gives the same level:

- `high`: declared, or two independent kinds of evidence (for example profile and usage) with no failed check and no conflict.
- `medium`: one kind of evidence with a matching name, no failed check.
- `low`: data alone, or any failed check, or a conflict.

### 4.4 Statuses

```
inferred ──(a check fails, or a conflict)──▶ needs_answer
inferred ──(a person confirms)──▶ confirmed
needs_answer ──(a person answers)──▶ confirmed
confirmed ──(drift, or a member objects)──▶ disputed
disputed ──(the owner or an admin decides)──▶ confirmed
```

- Only a person moves a definition to `confirmed`. Editors and admins can confirm; viewers cannot.
- `disputed` keeps serving the last confirmed version, with a visible note, until it is settled.
- Every status move is written to `definition_event` (who, when, from, to, why).

### 4.5 Ossie export

Verified against `apache/ossie` on 2026-11-10: the released spec is **0.1.1**; `main` is
`0.3.0.dev0`, a draft. GridZero already reads the flat 0.3 shape (`name`, `datasets`, `metrics` at
the root), so the exporter writes that shape and takes the version as a setting.

| GridZero | Ossie |
|---|---|
| entity | `datasets[]`: `name`, `source`, `primary_key` from `grain` |
| dimension | `datasets[].fields[]` with `dimension: { is_time }` |
| link | `relationships[]`: `from` (many side), `to` (one side), `from_columns`, `to_columns`. Ossie has no cardinality field; many-to-one is implied. |
| metric | `metrics[]`, `expression.dialects[]` for the source dialect plus `ANSI_SQL` when sqlglot can produce it |
| rule | Folded into each metric's expression as `SUM(CASE WHEN <rule> THEN x END)`, and listed in the extension below so it survives a round trip |
| label, description, synonyms | `label`, `description`, `ai_context` |

Ossie has no place for status, owner, evidence or checks, and its roadmap lists governance as future
work. GridZero carries them in `custom_extensions` with `vendor_name: GRIDZERO` and a JSON string:
`{ status, confirmed_by, confirmed_at, owner, confidence, evidence, check_number, rules }`. Other
tools ignore it; GridZero reads it back on import.

**Only confirmed definitions are exported by default.** An option includes the rest, each marked
with its status. Governance (row filters, masking) is not exported: it stays in the warehouse, which
is why queries run as the person asking.

## 5. Checks

Each check returns `pass`, `warn` or `fail`, a plain sentence, and the numbers behind it. Checks are
SQL run in the warehouse plus a read of the expression's syntax tree (sqlglot). No AI.

| # | Check | What it does | When it fails |
|---|---|---|---|
| C1 | Grain | Counts rows against distinct values of the entity's grain. | "`orders` has 1,204 rows but 1,180 order ids: 24 orders appear twice." |
| C2 | Join multiplies rows | For each link a metric crosses, tests whether the "one" side really has one row per key, and compares the metric with and without the join. | "Joining `refunds` counts 31 orders more than once and adds $4,210." |
| C3 | Empty values in averages | An `AVG` or ratio over a column with empty values. | "`AVG(gold)` skips 1 hero with no value. Count them as 0?" |
| C4 | Test and cancelled rows | A flag (`is_test`, `is_deleted`) or a status value (`cancelled`, `void`, `test`, `refunded`) on the entity that the metric does not filter on. | "9 orders are from a store marked as test and add $1,912." |
| C5 | Time zones | A day, week or month cut on a timestamp when the table or a linked one has a time-zone column, or the column is UTC. | "Weeks are cut in UTC. 14 orders fall in a different week in store time." |
| C6 | Double counting | Summing a column that repeats per child row; `COUNT(*)` where `COUNT(DISTINCT key)` differs; `SELECT DISTINCT` used to remove duplicates that differ in another column. | "`COUNT(*)` gives 60, distinct orders 52." |
| C7 | WHERE and HAVING | A condition on a row-level column placed in HAVING, or an aggregate compared in WHERE; a filter on the outer side of a LEFT JOIN that turns it into an inner join. | "The filter on `r.status` removes orders with no refund." |
| C8 | Trusted number | Compares the metric for a stated period with a number the business gives (or an imported report). Uses the result comparison from DataDungeon's grader. | "GridZero gets $1.24M, Finance's report says $1.11M." |
| C9 | Conflict | The same name with different formulas, or the same formula under different names, across history, sheets and imports. | "`revenue` has 2 formulas. 6 dashboards use A, Finance uses B." |
| C10 | Resolves | Every table and column in the expression exists and the expression parses in the source dialect. | Dropped before anyone sees it. |

C1 to C7 and C10 need no person. C8 and C9 usually produce a question.

## 6. Interview rules

1. **Ask only what the data cannot settle.** If a check passes and evidence is `high`, do not ask;
   show it for one-click confirmation instead.
2. **Rank by impact × doubt.**
   - Impact: how much depends on the answer. Number of metrics, dashboards, widgets and sheets that
     use the definition, plus how often it appears in query history, plus the size of the difference
     between the choices as a share of the number.
   - Doubt: `low` confidence, a failed check, or a conflict.
3. **About 5 to 10 at setup.** The rest wait in a backlog and surface when their definition is first used.
4. **Every question offers choices with numbers.** The numbers come from running each choice, never
   from the AI:
   > Revenue last month. A) $1.24M gross, used by 6 dashboards. B) $1.11M net of refunds, Finance's report.
5. **Each choice is a ready definition.** Picking one applies it; nothing is rewritten after the click.
6. **"Something else" is always offered** and opens the plain-English correction (§7).
7. **Route each question to one person**, in this order: the definition's owner; the member whose
   team label matches the people who wrote most of the queries; the person who has confirmed the most
   definitions on the same entity; an admin. Anyone can pass a question to someone else.
8. **One idea per question, in business words.** No table or column names unless the person asks
   ("Should orders from the QA store count?" not "Filter on `is_test`?").
9. **Say what happens next.** Each question shows what will change: "3 dashboards and 1 agent answer
   will change."
10. **Never ask twice.** An answer is stored as evidence and reused; the same question is raised
    again only on drift.
11. **The AI writes the wording; the checks decide what is asked.** With no AI key the question still
    appears, built from a template for its check.

The AI interviewer is tested by turning DataDungeon's mock interviews around: the AI asks, the
scripted customer answers, and `discoveryScore` counts how many hidden facts the questions uncovered.

## 7. Confirm, correct, publish

### 7.1 Confirm

One click on a definition with no open question. Sets `confirmed`, `confirmed_by`, `confirmed_at`
and, for a metric, stores the check number for the last full month (or the whole table when there is
no time dimension).

### 7.2 Correct in plain English

1. The person writes what is wrong: "Revenue should leave out the QA store and B2B deals."
2. The AI proposes a new body. It may add or change rules, filters and expressions; it may not touch
   another definition without listing it.
3. C10 runs. If the new expression does not resolve, the person is told and nothing changes.
4. All checks rerun.
5. The person sees: old number, new number, the difference, the new SQL in a collapsed section, and
   the impact list (§7.3).
6. Publish or discard. Publishing writes a new version; the old version stays in history and can be restored.

### 7.3 Preview

Before any change is published, GridZero lists what reads the definition and how each number moves:
metrics that use a rule, widgets that use a metric, schedules, and agent answers stored as widgets.
Each line shows old and new value. Things GridZero cannot recompute (an agent's free-text answer)
are listed as "will be marked out of date".

### 7.4 Watch

On every scheduled scan (daily by default, as the source's admin credential holder):

| Signal | Raises |
|---|---|
| A new value in a status-like column a rule depends on | Question: "`status` now has `on_hold`. Does it count as active?" |
| A column or table in a confirmed definition was renamed or removed | Definition becomes `disputed`; question with the closest match offered |
| The check number for the fixed period changed beyond tolerance | Question with old and new number: "October revenue was $1.11M at confirmation and is $1.19M now." |
| The grain no longer holds | Question |
| A metric jumps more than its usual range period over period | Note on the metric; question only if a check also fails |

Drift never changes a number silently. The confirmed version keeps serving, marked "under review".

### 7.5 Corrections in chat

When a person tells an agent "that's wrong, revenue excludes refunds", the agent calls
`propose_definition_change`. It becomes a change with status `proposed`, with old and new numbers,
routed to the definition's owner. The chat answer is labelled unconfirmed until the change is published.

## 8. How agents use definitions

### 8.1 Tools

| Tool | Does |
|---|---|
| `list_definitions` | Confirmed metrics, dimensions and rules for the member's workspaces, with label, description and status. |
| `query_definition` | Runs a metric, grouped and filtered by dimensions, as the asking member. Returns the number, the SQL, the definition's status and who confirmed it. |
| `propose_definition_change` | Files a correction (§7.5). Never publishes. |
| `run_sql` (exists) | Still available, but its results are always labelled unconfirmed. |

### 8.2 Rules (enforced in code, not only in the prompt)

1. For a question about a metric, the agent must call `list_definitions` first. `run_sql` refuses to
   run until that has happened in the run.
2. Every tool result carries a `grounding` field: `confirmed`, `unconfirmed` or `sql`.
3. The run keeps the lowest grounding it used. If it is not `confirmed`, the server adds a fixed
   label to the end of the stored reply, whatever the model wrote:
   - "Unconfirmed: this uses a definition nobody has confirmed yet."
   - "Unconfirmed: no shared definition exists for this, so I wrote a query."
4. Confirmed answers end with their source: "Net revenue, confirmed by Priya Nair on 12 Nov."
5. Widgets and scheduled answers store the definition id and version. When a new version is
   published they refresh; when a definition is `disputed` they show "under review".
6. An agent can never confirm, publish or change a status.

### 8.3 MCP

GridZero exposes a read-only MCP server at `/mcp` with `list_definitions`, `get_definition` and
`query_definition`. A caller signs in as a member with a personal access token (and OAuth later), so
queries still run with that member's own credential. Only `confirmed` definitions are listed unless
the caller asks for others, and every result carries its status. This lets Claude, ChatGPT, Copilot
or an in-house agent use the same confirmed numbers. Not in the first slice.

## 9. Permissions, safety, cost

### 9.1 Who can do what

| Action | Viewer | Editor | Admin |
|---|---|---|---|
| Read definitions, ask agents | ✓ | ✓ | ✓ |
| Save own credential, run queries | ✓ | ✓ | ✓ |
| Start a scan, answer questions, confirm, correct | | ✓ | ✓ |
| Add a source, invite members, settle a dispute, set owners | | | ✓ |

### 9.2 Run as the asker

Every query (scan, check, metric, agent) runs with the credential of the member who caused it. There
is no workspace-wide credential. Scheduled scans and refreshes run as the member who created the
schedule, and stop with a clear message if that credential stops working. Row filters and masking in
the warehouse therefore apply as usual, which is also why two members can see different numbers; the
result says whose access it used.

Stored scan results (profiles, common values) are visible to every member, so a scan stores no row
data beyond common values of low-cardinality columns, and an admin can exclude tables and columns
from scanning.

### 9.3 Read-only and cost

- Generated SQL is built from parsed expressions and is a single `SELECT`. Postgres and Redshift also
  run it in a read-only transaction.
- Before a scan or a metric run, GridZero asks the warehouse for an estimate and shows it: Postgres
  `EXPLAIN` (estimated rows and cost), BigQuery dry run (bytes), Snowflake and Databricks `EXPLAIN`
  (partitions and bytes). Above a workspace limit the run needs a click to proceed; scheduled runs
  above the limit are skipped and reported.

### 9.4 AI use

The draft, the wording of questions and corrections use the acting member's own AI key and count
against their monthly cap, like agents do today. With no key, the deterministic draft, the checks
and template questions still work.

## 10. Where the code lives

```
apps/web            Definitions pages: sources, scan, review (questions), definition detail
services/control    Workspaces, sources, credentials, definitions, questions, changes; runs all SQL
                    through connectors.ts as the asking member; makes AI calls
services/semantic   Python, sqlglot. Pure functions: what to scan, parse history, infer keys and
                    links, run checks, build questions, export Ossie. Holds no credentials and
                    opens no connections.
```

`services/semantic` is started by the control service as a child process and speaks JSON lines. It
works in steps: it returns the SQL it needs run, control runs it and sends the results back, until
the step is done. So one engine serves every warehouse and the proof harness (which answers the same
steps from DuckDB).

New tables: `workspace`, `workspace_member`, `source`, `source_credential`, `scan`, `definition`,
`definition_event`, `question`, `definition_change`. The existing `connection` and `metric_model`
tables stay as they are; a person can turn one of their connections into a workspace source.

## 11. The first slice

Built (2026-11-10), with `tests/e2e/definitions.test.mjs` covering each line:
- Workspaces with members and roles; a Postgres source; each member's own sign-in. Nothing runs
  for a member who has not saved one.
- Scan: catalog, declared keys and links, profiles, inferred keys and links, history from
  `pg_stat_statements` (when the member may read it) and from members' GridZero connected tables.
  A row estimate is shown before the scan.
- Draft by rule, plus obvious totals (`SUM(amount)`, row counts) marked low confidence when nobody
  has been seen using them. AI adds labels and descriptions when the member has a key.
- Checks C1 to C7, C9 and C10; C8 when a person types a trusted number.
- Review screen (`/definitions`): ranked questions, each choice with the number it gives, one-click
  confirm with a check number, dispute, and correction in plain words or by formula with old and
  new numbers before publishing. Every change is kept in the definition's history.
- Agents: `list_definitions`, `query_definition`, `propose_definition_change`; `run_sql` is refused
  until definitions were listed; the server labels every reply that is not confirmed.
- Ossie export of confirmed definitions, everything else on request.

Added after the first slice (2026-11-11): **workbook tables as a source.** A workbook's Data Tables
are scanned and queried with DuckDB in the engine's worker (the roadmap's "files through DuckDB",
for files already imported). The source is created on first use, in the person's own workspace if
they have none. Access is "can open the workbook", since a file has no permissions of its own.
Agents get `list_tables` and `query_tables`; widgets can rerun a table query or a definition.

Built differently from the sections above, or not yet:
- **Questions are routed to the definition's owner, else the first admin.** The team-label and
  "who wrote most of the queries" routing in §6.7 is not built. Anyone can pass a question on.
- **Only two kinds of answer change a definition by themselves:** leaving rows out (adds a rule and
  applies it to the metrics on that table) and choosing between formulas. Answers about time zones,
  late data, duplicates and units are stored as evidence; use a correction to act on them.
- **Postgres query history has no literal values** (`pg_stat_statements` replaces them with `$1`),
  so rules cannot be learned from it. Rules come from flag and status columns and from answers.
- **The preview lists metrics that change, not widgets or dashboards** (§7.3). Widgets still read
  the older metric models, not definitions.
- **AI used for names and corrections is not yet added to the member's monthly spend**, because
  spend is recorded per agent run. The cap is still checked before each call.
- **The cost limit is on estimated rows** (50 million), from Postgres's planner.
- A metric reads one table plus rules and dimensions one many-to-one link away. No metric spans a
  one-to-many link yet, which is where C2 matters most.
- Sampling for tables above 1,000,000 rows takes the first rows, not a random sample.
- Members must already have a GridZero account to be added to a workspace.

Not built, in rough order of what comes next: check numbers on a schedule and drift questions
(§7.4); the impact preview across widgets; the MCP server (§8.3); importing dbt, LookML and Power
BI through the Ossie converters; Snowflake, BigQuery and Databricks scans against real accounts;
sheet formulas as evidence; files through DuckDB; SaaS sources through a connector partner;
Iceberg REST catalogs.

## 12. Connectors for files and SaaS apps (evaluation, not yet a decision)

Checked against each vendor's own pages on 2026-11-10.

| Option | Licence | How GridZero would use it | Fit |
|---|---|---|---|
| dlt | Apache-2.0 | A Python library run in our own worker; loads into the customer's warehouse or DuckDB | Best fit for a small team: no licence limits, no extra service to run. We own scheduling and credentials. |
| Airbyte | Core and connectors ELv2, which bars offering it as a managed service or exposing its UI or API in a product | PyAirbyte in a worker, or Airbyte's hosted embedded product | Large catalog, but the licence needs a lawyer's read before embedding. PyAirbyte's own licence could not be verified. |
| Fivetran | Proprietary SaaS ("Powered by Fivetran") | Their API creates a destination per customer; customers enter credentials in Fivetran's embedded card | Least to build and most reliable, at a per-customer price not stated publicly. Data flows through a third party. |

Recommendation: dlt first for files and the few SaaS sources customers ask for most; revisit Fivetran
if connector upkeep becomes the bottleneck.

## 13. Facts checked for this spec

| Claim | Result (2026-11-10) |
|---|---|
| Ossie spec "v1" on 27 Jan 2026 | The date is right; the version is not. The repository's released version is 0.1.1; `main` is 0.3.0.dev0 and marked draft. Some vendors call it v1.0. |
| Ossie is Apache incubating | Yes, since 22 Jun 2026. |
| Members: Snowflake, Databricks, dbt Labs, Salesforce, Cube, AtScale | Yes. ServiceNow could not be confirmed from an official source. |
| Microsoft and Google contribute | Microsoft: yes, first commit 16 Sep 2026. Google: reported as "in the process of joining"; no commits found. |
| Two-way Power BI converter, 30 Sep 2026 | Yes, in `apache/ossie-converters/microsoft`. Converters also exist for dbt, Cube, Databricks metric views, Snowflake, LookML (export) and about 17 others. |
| AWS, SAP | No evidence of either. |
| MCP under the Agentic AI Foundation; A2A at the Linux Foundation | Yes. A2A is a separate Linux Foundation project, not under that foundation. |
| Apache Polaris top-level project, Feb 2026 | Yes, 19 Feb 2026. |
| No standard covers governance | True of Ossie (no row filter, masking, owner or status fields; listed as future work). Other standards were not surveyed. |

## 14. Proof before building

The pipeline is first run on DataDungeon's four datasets and three mock interviews, and scored
against the lesson answer keys. Results, including what failed, are in the DataDungeon repository at
`research/semantic-inference/REPORT.md`. The slice in §11 is built from the same engine.

## 15. Open questions

1. Should a definition be able to span two sources (orders in Postgres, refunds in Snowflake)? This
   spec says no: one source per definition.
2. Who pays for AI during setup once there is a platform key and plans?
3. Should confirmed definitions need a second person for some metrics ("Finance must confirm revenue")?
4. How long is query history kept, and may its text be shown to other members as evidence?
