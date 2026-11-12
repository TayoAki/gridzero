# GridZero checked against Metabase

Checked on 12 November 2026 against the documentation in Metabase's public repository (`docs/`, about 526 pages,
last changed 11 November 2026). The aim is a complete list of what Metabase offers, so nothing is missed by accident.

**No Metabase code is used in GridZero.** Metabase's source is under the AGPL, and its `enterprise/` directory under
a commercial licence; copying either into GridZero would put GridZero under the AGPL or break the licence. This is a
feature comparison from public documentation, written in our own words.

How to read it: **Have** means GridZero does this today. **Partly** means some of it. **Missing** means it does not.
**By design** means GridZero does the job a different way on purpose. "Paid" marks what Metabase sells only on its
Pro and Enterprise plans, which matters when deciding what a free tier must have.

## Where GridZero is ahead

- **A real spreadsheet beside the reports.** Formulas, pivots, charts, Python, live co-editing. Metabase has editable
  tables (Paid, Postgres and MySQL only) and no formulas.
- **Modelling that settles itself.** After a scan GridZero settles keys, links and fields from the data and asks only
  what it cannot work out, with the number each answer gives. Metabase's semantic layer (models, metrics, segments,
  the Library) is curated by hand.
- **Checked answers.** A number a person confirmed becomes a test the agent is re-run against. Metabase verifies
  content with a badge (Paid) but does not re-test AI answers.
- **Every card says where its number came from**, how fresh it is, and whether a filter reached it.
- **Agent interfaces (A2UI).** The agent can answer with a small interface. Metabase's assistant answers with charts
  and text.

## The comparison

### 1. Asking questions and building queries

| Metabase | GridZero | Note |
|---|---|---|
| Visual query builder: pick data, join, custom column, filter, summarise, sort, limit | Partly | "Add a card" does one table, one total, up to two splits. No joins, custom columns, filters or several totals |
| Multi-stage queries (summarise, then filter or summarise again) | Missing | The agent can write such SQL; a person cannot build it by hand |
| Joins by hand, and implicit joins through foreign keys | Partly | Definitions join linked tables automatically; the card builder does not |
| Custom columns with an expression editor (about 60 functions) | By design | Computed columns live in the workbook table, with spreadsheet formulas |
| Aggregations: count, sum, average, min, max, median, percentile, distinct, share, conditional | Partly | Builder: count, sum, average, min, max. The rest through the agent or SQL |
| Cumulative sum and count, offset (previous row) | Missing | |
| Time bins (minute to year) and numeric binning | Partly | Day, week, month, quarter, year. No numeric binning |
| Preview results at each step | Have | The builder previews the card as you choose |
| See the SQL behind a question; convert to SQL | Missing | A card keeps its SQL but the page does not show it |
| Save a question on its own, reuse it in several dashboards | Missing | A card belongs to one report |
| Version history and revert for a question | Missing | Workbooks have versions; cards and reports do not |
| Column-header actions (distribution, distinct values, extract date parts) | By design | In the workbook grid |
| Object detail view for one record, with related records | Missing | |
| Command palette | Have | Ctrl K |
| Keyboard shortcuts across the app | Partly | The grid has Excel's; reports have none |

### 2. SQL

| Metabase | GridZero | Note |
|---|---|---|
| A SQL editor for people | Missing | Only the agent writes SQL; connected tables take a query in a dialog |
| Variables and field filters in SQL, optional clauses | Missing | Report filters reach a SQL card through the tables underneath instead |
| Snippets, and referring to saved questions as CTEs | Missing | |
| Run a selection, auto-format | Missing | |
| Explore SQL results further without SQL | Partly | A SQL card follows report filters and can be drilled to rows |

### 3. Visualisations

| Metabase | GridZero | Note |
|---|---|---|
| Table, with reorder, hide, resize, freeze, row numbers | Partly | A plain table of up to 6 columns and 50 rows |
| Conditional formatting in tables; mini bars in cells; links and images in cells | Missing | |
| Pivot table with totals | Partly | Pivots exist in workbooks, not as a report card |
| Line, bar, area, combo, row (horizontal) | Have | |
| Scatter and bubble | Have | |
| Pie, donut, sunburst | Have | |
| Number, trend against a previous period | Have | "Compare with the period before" on a figure |
| Progress bar against a goal | Missing | Gauge is the nearest |
| Gauge, funnel, waterfall, sankey, treemap, box plot | Have | |
| Histogram, radar, heatmap, stacked | Have | Radar and heatmap are not in Metabase's list |
| Maps: pin, grid, region, custom GeoJSON | Missing | The largest chart gap |
| Detail card (one record) | Missing | |
| Custom visualisation plugins (Paid) | Missing | |
| Goal lines, trend lines, values on points | Partly | Trend line, forecast and unusual-point flags. No goal line |
| Axis options: log scale, ranges, split axes, labels | Missing | Charts choose their own |
| Per-series colour, name, line style | Partly | One colour theme per card |
| Stacked and 100% stacked | Partly | Stacked only |
| Number, date and currency formatting per column | Missing | Numbers are shortened automatically; no per-card format |
| Custom tooltips | Missing | |

### 4. Dashboards

| Metabase | GridZero | Note |
|---|---|---|
| Grid of cards: drag, resize | Have | |
| Tabs on a dashboard | Missing | |
| Heading and Markdown text cards | Partly | A text card exists; only an agent can add one |
| Link cards, iframe cards | Missing | |
| Several series from different questions on one card | Missing | |
| Hide a card when it has no results | Missing | It says "Nothing matches the filters" |
| Fullscreen, dark mode, auto-refresh | Have | Present mode does all three |
| Duplicate a dashboard | Missing | |
| Version history for a dashboard | Missing | |
| Export a dashboard as PDF | Missing | Excel only |
| Section templates | Partly | Two starter templates (Sales, Operations) |
| Timeline events shown on charts | Missing | |
| Action buttons that write to the database | Missing | Agents write only with approval |

### 5. Filters, cross-filtering, drill-through

| Metabase | GridZero | Note |
|---|---|---|
| Filter types: date, text, number, boolean, location, ID | Partly | Text, number range, date range |
| Date variants: relative, single date, month and year, quarter | Partly | Presets and a custom range |
| Filters in the header or on a card | Have | The date bar is on top; slicers are cards |
| Connect a filter to each card by hand | By design | A filter reaches every card whose tables have that column; the card says if it did |
| Linked filters (one limits another's values) | Missing | |
| Default and required filter values | Missing | Choices are kept per device |
| Filter values in the URL | Missing | Needed to send someone a filtered link |
| Apply button instead of filtering at once | Missing | |
| Cross-filtering by clicking a chart | Have | |
| Click behaviour: go to another dashboard, question or URL | Missing | |
| Drill-through menu: zoom in, see records, break out by, compare | Partly | "Rows behind it" with count and totals. No zoom or break-out |
| Brush a time range on a chart to filter | Missing | |
| Time-grouping control for viewers (day, week, month) | Missing | Fixed when the card is made |

### 6. Alerts and delivery

| Metabase | GridZero | Note |
|---|---|---|
| Alert when a question has results | Missing | |
| Alert when a figure crosses a goal | Have | On a figure card, once per crossing |
| Dashboard subscriptions by email on a schedule | Have | |
| Slack delivery | Missing | |
| Webhook delivery | Missing | |
| Attach CSV, Excel or a PDF | Missing | The email carries figures and small tables |
| Skip sending when there is nothing to send | Partly | It refuses to send a report with no cards |
| Different filter values per subscription (Paid) | Missing | |
| Test send | Have | "Send now" |
| An admin view of every alert, with failures | Partly | Each person sees their own; a failed send shows why |

### 7. Data modelling

| Metabase | GridZero | Note |
|---|---|---|
| Table and field names, descriptions, visibility | Partly | Definitions have labels and descriptions; no hiding of tables or fields |
| Semantic types (currency, email, URL, country…) | Missing | Columns are text, number or date |
| Models (curated datasets) | By design | Entities and links, settled from the data |
| Metrics with a formula and dimensions | Have | Definitions of kind metric and dimension |
| Segments (saved filters) | Have | Rules |
| Glossary of business terms | Partly | Each definition has a description; there is no separate glossary |
| Transforms that write tables back to the warehouse | Missing | |
| Dependency graph and lineage (Paid) | Missing | A change shows which definitions it affects |
| Entity-relationship diagram (Paid) | Missing | Links are listed, not drawn |
| Git-backed versioning of content (Paid) | Missing | Export as Apache Ossie YAML only |
| JSON unfolding | Missing | |
| Materialise a model in the database | Missing | |

### 8. Data sources

| Metabase | GridZero | Note |
|---|---|---|
| PostgreSQL, Redshift, Snowflake, Databricks, BigQuery | Have | |
| MySQL, MariaDB, SQL Server, Oracle, ClickHouse, Athena, MongoDB, Druid, Presto, Trino, SparkSQL, SQLite, Vertica | Missing | Thirteen drivers Metabase has and GridZero does not. MySQL and SQL Server matter most |
| SSH tunnels | Missing | |
| Upload CSV | Have | Also Excel, JSON and Parquet |
| Google Sheets sync (Paid) | Have | A published sheet, as a file at a web address |
| Scheduled sync and scan | Have | Connected tables refresh on a schedule; a scan profiles them |
| Encrypt connection details | Have | |
| Community driver SDK | Missing | |

### 9. Permissions

| Metabase | GridZero | Note |
|---|---|---|
| Groups, with permissions per group | Partly | Workspace roles (admin, editor, viewer); no custom groups |
| Collection permissions (curate, view, none) | Partly | Sharing is per workbook and per report |
| Row-level security by user attribute (Paid) | Missing | A database source runs each member's own sign-in, which carries the database's row rules |
| Column security (Paid) | Missing | |
| Connection impersonation (Paid) | Have | Every member signs in to a database source as themselves |
| Download limits (Paid) | Missing | |
| Block a group from a database | Partly | By not giving them a sign-in |
| Allowlist for embedded domains and images | Partly | Images in agent interfaces must be https; there are no iframes |

### 10. People and sign-in

| Metabase | GridZero | Note |
|---|---|---|
| Email and password, invites | Have | |
| Password reset by email | Missing | Email verification and reset are not wired |
| Google sign-in | Missing | |
| Two-factor (Paid) | Missing | |
| SAML, JWT, OIDC, LDAP, SCIM (mostly Paid) | Missing | |
| API keys | Missing | |
| Session timeout, login history | Missing | |

### 11. Sharing and embedding

| Metabase | GridZero | Note |
|---|---|---|
| Public link for a dashboard | Have | With filters |
| Public link for one question; public CSV download | Missing | |
| Embed in another site with a signed link, locked filters | Missing | |
| Embedding SDK, web components, theming (Paid) | Missing | |
| Remove branding (Paid) | Missing | |
| Tenants (Paid) | Missing | The planned client workspaces for agencies cover this ground |

### 12. Organisation

| Metabase | GridZero | Note |
|---|---|---|
| Collections (folders), personal collections | Missing | Flat lists |
| Search across titles and SQL | Partly | Search finds workbooks, reports and agents by name, not definitions or card contents |
| Bookmarks and pins | Missing | Open tabs are remembered |
| Trash with restore | Partly | Workbooks only |
| Verified and official content (Paid) | Have | Confirmed, settled and draft are shown everywhere |
| Events and timelines on charts | Missing | |
| Data reference (browse tables and fields) | Partly | "How we count" lists definitions; tables are seen in the workbook |
| Automatic exploration of a table (X-ray) | Partly | A scan profiles every column and drafts totals; it does not build a dashboard |
| Set a dashboard as the home page | Missing | |

### 13. AI

| Metabase | GridZero | Note |
|---|---|---|
| Assistant that turns a question into a chart | Have | |
| Generate and fix SQL | Have | The agent writes and corrects its own queries |
| Reuses existing questions first | Have | It answers from confirmed definitions and checked answers first |
| Research mode: plan, generate many charts, rank them | Missing | |
| Assistant in Slack | Missing | |
| Bring your own model provider | Have | Anthropic and OpenRouter |
| Restrict AI to verified content (Paid) | Have | Answers are labelled by what they rest on |
| Usage limits per person or group (Paid) | Partly | A spending cap per person |
| Review of AI conversations (Paid) | Partly | Every run and tool call is recorded; there is no admin screen |
| MCP server so other AI tools can query | Missing | GridZero's agents can use outside tools; outside AI tools cannot query GridZero |
| Thumbs up or down on answers | Partly | "Mark as correct" |
| Interfaces drawn by the agent | Have | A2UI 1.0; Metabase has nothing like it |

### 14. Documents, apps, write-back

| Metabase | GridZero | Note |
|---|---|---|
| Documents: rich text with live charts, comments | Missing | A text card is the nearest |
| Actions that insert, update or delete rows | Missing | |
| Editable tables (Paid) | Have | The workbook grid |
| Data apps built by an AI agent (Paid, beta) | Missing | |

### 15. Administration

| Metabase | GridZero | Note |
|---|---|---|
| Caching of results | Partly | Staged tables are kept for five minutes; cards keep their last result |
| Usage analytics (Paid) | Missing | |
| Audit log | Partly | Workbook and connection events are recorded; there is no screen |
| Export and import all content as files (Paid) | Missing | |
| White-label: colours, logo, name (Paid) | Missing | |
| Language and regional formats | Missing | English only |
| Report timezone | Missing | Dates are UTC |
| Metrics endpoint for monitoring | Missing | Error tracking only |

### 16. For developers

| Metabase | GridZero | Note |
|---|---|---|
| A documented public API (about 600 paths) | Partly | The API exists and is used by the web app; it is not published as a reference |
| Command-line tool | Missing | |

## What is missing, in the order worth building

Chosen by how often a buyer would notice, not by how much Metabase has.

1. **A query builder for people.** Joins, filters, several totals and custom columns in "Add a card", and showing
   the SQL behind a card. Today anything past one table and one total needs the agent.
2. **A SQL editor.** Analysts expect to write a query and chart it.
3. **Filters in the link.** Send someone a report already filtered; default filter values.
4. **Dashboard tabs, text and heading cards a person can add, duplicate a report.**
5. **Password reset by email and Google sign-in.** Sign-in basics; without reset a locked-out customer needs support.
6. **Slack and webhook delivery, and a PDF or Excel attached to the email.**
7. **Maps.** The one common chart family not drawn.
8. **MySQL and SQL Server connectors, and SSH tunnels.**
9. **Collections.** Folders for reports and workbooks once there are more than a handful.
10. **Per-person row limits on a shared report.** Needed before an agency can share one report across clients.
11. **Number, date and currency formats per card; conditional formatting in tables; goal lines.**
12. **Embedding a report in another site with a signed link.**
13. **Version history for reports and cards.**
14. **Drill menus: zoom in on a period, break out by another field.**
15. **Documents.** Writing with live charts in it.
16. **An MCP server and API keys**, so other AI tools and scripts can query GridZero with a person's permissions.

Not worth copying now: LDAP, SAML and SCIM (until an enterprise buyer asks), the thirteen long-tail drivers, custom
visualisation plugins, transforms and model persistence (GridZero's tables are already in the workbook), tenants (the
client workspaces planned for agencies do this job).
