# GridZero agent dashboards: plan

Status: decisions agreed (section 6), not started. Written 2026-11-10 from a review of the TubeGuruji course "Build AI Agent Dashboard Using Claude Code & Next.js" against what GridZero already has.

## 1. What the course builds, in one paragraph

A personal dashboard of widgets that AI agents create and keep up to date. You create named agents (avatar, colour, instructions), chat with them, and they use tools: web search, a cloud browser (Browserbase) that can fill forms and read sites you have signed in to, and third-party apps through Composio (Gmail, Slack, Notion, GitHub and so on). When an answer would be useful to see every day, the agent offers to turn it into a widget: it draws two or more designs, you pick one, it prepares small, medium and large sizes, and the widget goes on your dashboard. A schedule (for example 8:00 and 12:00 daily, in your time zone) re-runs the agent to refresh the widget, and agents can also run plain recurring tasks ("send me a Slack greeting at 8"). Dashboards have drag-and-drop layout, resizing, per-widget styling, background customisation and templates. Settings show token usage and cost per model over 90 days. Side-effects (sending, posting) ask for approval first.

## 2. Where GridZero already stands

| The course needs | GridZero today | Gap |
|---|---|---|
| Auth, Postgres, storage | Better Auth, Postgres, workbook volume, backups | None |
| Background jobs and schedules | Cron runner in the control service (`connected.ts`, every 15 s) for connected tables | Generalise it to agent runs |
| Encrypted third-party credentials | AES-256-GCM connection secrets | Reuse for app tokens |
| Data tools | Postgres, Redshift, Snowflake, Databricks, BigQuery queries; sandboxed Python with polars and DuckDB; formulas, pivots, charts over 1M+ rows | Expose them as agent tools |
| Charts | Chart objects with evaluated series over HTTP | Reuse as a widget type |
| Error reporting, audit log, rate limits | Built (PR #16) | None |
| LLM agent loop, chat UI | Not built (the "AI panel" was deferred) | New |
| Dashboards, widgets, layout | Not built | New |
| Cloud browser, third-party apps | Not built | New, optional |

**The angle that is ours and not the course's:** our widgets can be backed by real data the agent computed in a workbook (a warehouse query, a Python transform, a pivot over a million rows), not only by text the model wrote. "Revenue by region from Snowflake, refreshed at 7:00" is a GridZero widget; the course can only do it through screen-scraping or a third-party connector.

## 3. Product shape (recommended)

Keep the spreadsheet; add **Dashboards** and **Agents** beside Workbooks in the sidebar.

- An **agent** is a saved assistant: name, avatar, colour, instructions, which tools it may use, and the workbooks and connections it can see.
- A **dashboard** is a grid of widgets. A **widget** is a saved view plus a recipe for refreshing it.
- Every agent run (chat, scheduled, "update now") is recorded with its tool calls, tokens and cost.
- Agents work inside the user's permissions: they can read only workbooks the user can read, and write only where the user can edit.

## 4. Technical design

### 4.1 Agent runtime

- **Claude API with tool use, run by our control service** (TypeScript, `@anthropic-ai/sdk`), using the SDK's tool runner. Our tools touch our own data and sandbox, so we host the loop; Managed Agents (Anthropic-hosted loop, sessions, scheduled deployments) is the alternative if we later want Anthropic to host long-running agents.
- **Model:** `claude-opus-5-5` by default, with `output_config.effort` tuned per route (`low` for chat, `medium`/`high` for multi-step runs; its default is `medium`). Adaptive thinking is always on for this model. Turn on server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) and handle `stop_reason: "refusal"`. A cheaper model for routine scheduled refreshes is a later cost decision, made with measurements.
- **Streaming** to the browser over Server-Sent Events, with `eager_input_streaming` on client tools and schema validation of every tool input before running it.
- **Prompt caching** on the frozen system prompt and tool list; per-run budgets with task budgets (beta) and a per-user monthly cap.
- **Context:** conversations stored in Postgres; compaction (beta) for long chats.

### 4.2 Tools, in the order we would add them

1. **Built-in, server-side:** `web_search_20260209`, `web_fetch_20260209`.
2. **GridZero tools (ours):** list workbooks and sheets; read a range or a Data Table page; run SQL on a saved connection; run Python in the existing sandbox; write results into a Data Table; create a chart or pivot. Each enforces the user's role.
3. **Widget tools:** `propose_widget` (returns design variants as a widget spec, below), `save_widget`, `set_schedule`.
4. **Third-party apps:** either Anthropic's MCP connector (beta `mcp-client-2025-11-20`, any MCP server, we manage OAuth ourselves) or Composio (hosted OAuth for ~250 apps, a paid dependency). Decision below.
5. **Cloud browser:** Browserbase sessions with a live view and "take over / hand back" for sign-ins, so the agent never sees passwords. Optional; most value for sites with no API.

### 4.3 Widgets

- A widget is a **JSON spec, not generated code**: a type (`kpi`, `list`, `table`, `chart`, `sparkline`, `text`, `image`), its data, a theme (colours, background, corner radius) and layouts for small, medium and large. Our renderer draws it. This keeps model output out of the page as executable HTML/JS, which matters because widget data can come from web pages and emails that may carry prompt-injection text.
- The agent produces 2–3 design variants with structured outputs (`output_config.format`) so the spec always validates.
- **Data sources:** (a) a snapshot from the agent's last run, or (b) a live binding to workbook data (a range, chart, pivot or connected table) that updates whenever the workbook does, with no model call. (b) is the cheap, accurate path and our differentiator.
- **Sizes:** small (1×1), medium (2×1), large (2×2) on a 12-column grid; free resize snaps to the nearest designed size.

### 4.4 Schedules and runs

- Generalise the connected-table runner into one `schedule` table (cron, time zone, target: widget refresh or task), with leases so only one control instance runs a job, retries with backoff, and a run history.
- **Approvals:** any tool that sends, posts, writes outside GridZero or spends money needs approval. In chat that is a confirm card. For scheduled runs the user pre-approves a specific action on a specific target (for example "post to #general in Slack"), and anything outside that is held in an approval inbox.
- A run timeline on each agent: status, duration, tools used, tokens, cost, and errors.

### 4.5 Data model (new tables)

`agent`, `agent_tool_grant`, `conversation`, `message`, `run`, `run_step`, `usage` (tokens and cost per run and model), `dashboard`, `widget`, `widget_design` (variants and sizes), `schedule`, `approval`, `app_connection` (encrypted third-party tokens), `browser_context`.

### 4.6 Front end

New pages: Dashboards (grid with drag, resize, lock, per-widget style, background), Agent chat (chat, config panel, browser preview, schedules, run history), Apps (connections), Usage (90 days by model). Grid library: `react-grid-layout`. The chat UI streams tool calls and offers a widget card when the agent proposes one.

## 5. Phases

| Phase | Delivers | Done when | Size |
|---|---|---|---|
| 0. Decisions | Answers to section 6 | Agreed | – |
| 1. Agent core | Agents, a place to add your own Anthropic key (encrypted, validated), streaming chat, conversation history, web search and fetch, usage metering | A user adds their key, creates an agent, asks about current news, gets sourced answers; tokens and cost recorded per run | M |
| 2. GridZero tools | Read workbooks, run SQL on connections, run Python, write Data Tables, create charts and pivots, all under the user's role | "Pull last week's orders from Postgres, chart revenue by region" lands as a Data Table and chart in a workbook | M |
| 2b. Metrics (Apache Ossie) | Metrics catalogue; import/export Ossie YAML (and dbt and others through the converters); `query_metric` compiling to each warehouse's SQL; agents use metrics before free SQL | Revenue defined once answers the same in chat, a widget and an exported dbt model | M |
| 3. Dashboards and widgets | Dashboard pages, widget spec and renderer, design variants, three sizes, drag/resize, live bindings to workbook data | An agent answer becomes a chosen widget; a chart-bound widget updates when its workbook does | L |
| 4. Schedules and approvals | One scheduler for refreshes and read-only tasks, time zones, run history; approval cards for side-effects in chat | A widget refreshes at 8:00 every day with no one signed in; a scheduled run is never offered a sending tool | M |
| 5. Third-party apps | Composio behind an `AppProvider` interface; Apps page; connect from chat | "Summarise my 5 newest emails" works after connecting Gmail in chat; sending needs approval in chat | M |
| 6. Polish | Templates, widget and dashboard styling, "edit with AI", usage page | A new user starts from a template and customises it | S–M |
| 7. Security review and pen test (beta gate) | Covers the agent surface too: prompt injection through web/email/workbook content, tool scoping, approval bypass, cost abuse, SSRF through fetch, cross-user data access, key storage | Findings fixed; beta opens | M |
| After beta | Cloud browser (Browserbase: live view, take-over sign-in, session cleanup); pre-approved sends from scheduled runs; our platform key with Stripe plans; GridZero as an MCP server; agent export as Open Agent Spec | – | – |

Phases 1–4 make a complete product on their own; 5 adds reach. Because beta runs on users' own Anthropic keys, it does not wait for Stripe; our platform key does.

## 6. Decisions (agreed 2026-11-10)

1. **Shape: Dashboards and Agents sit beside the spreadsheet.** Workbooks, warehouses, Python and pivots stay first-class and are the data behind widgets.
2. **Model costs: users' own Anthropic keys first; our platform key later.** Beta runs on keys users paste in (stored encrypted like connection secrets, never shown again, validated on save). Our key with plan limits and per-user caps arrives with Stripe.
3. **Third-party apps: Composio for beta,** behind our own `AppProvider` interface so it can be replaced by Anthropic's MCP connector later without touching agents or the UI.
4. **Cloud browser: after beta.** Phase 6 moves to after the beta security review.
5. **Scheduled runs: read and report only during beta.** Scheduled runs may refresh widgets and write into the user's own workbooks; tools that send, post or change things outside GridZero are not offered to scheduled runs. Pre-approved sends come after the approval system and the security review.

## 7. Risks

- **Prompt injection.** Web pages, emails and shared workbooks can contain instructions aimed at the agent. Mitigations: approval for every side-effect, tools scoped to the user, widget specs instead of generated code, tool results marked as untrusted data in the prompt, and no credentials ever placed in the model's context.
- **Cost.** Scheduled agents run whether or not anyone looks. Mitigations: live bindings to workbook data where possible (no model call), per-user caps, task budgets, caching, and usage shown to the user.
- **Third-party terms.** Browser automation on sites without permission, and scraping behind logins, can break those sites' terms; keep it user-initiated and on the user's own accounts.
- **Scope.** The course demo shows many features at once; shipping phases 1–4 well beats shipping 1–8 thinly.

## 8. Portability: Apache Ossie for metrics, open standards for agents

The aim: what a user builds in GridZero (their business definitions and their agents) should not be locked in.

### 8.1 Apache Ossie: portable metric definitions (adopt)

[Apache Ossie](https://github.com/apache/ossie) (incubating, Apache-2.0, formerly Open Semantic Interchange) is a vendor-neutral YAML/JSON format for **semantic models**: datasets (tables and their fields), relationships, and **metrics** with their SQL per dialect, for example `completed_amount = SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)`. Its stated purpose is that a KPI means the same thing in every BI tool and AI agent. [apache/ossie-converters](https://github.com/apache/ossie-converters) translates to and from dbt, Cube, Databricks, BigQuery, GoodData, Hex and others. The spec is pre-1.0 (`0.3.0.dev0` in its examples), so we pin a version and expect changes.

It does **not** describe agents. What it gives us is better for this product: agents that answer from agreed definitions instead of improvising SQL, and definitions that travel with the customer.

How GridZero uses it:
- **Metrics catalogue.** A per-workspace list of Ossie semantic models. Import from a file, or from dbt/Cube/Databricks and others through the converters; author and edit in GridZero; export as Ossie YAML at any time.
- **Agents answer through metrics first.** A `query_metric` tool (metric, dimensions, filters, time grain) compiles the model to SQL for the connected warehouse's dialect and runs it on the existing connectors. The agent writes free SQL only when no metric fits, and says so. This is the main defence against confidently wrong numbers.
- **Widgets bind to metrics,** not raw SQL, so changing a definition updates every widget that uses it, and the widget shows which definition it uses.
- **Workbooks can be a source.** A Data Table or connected table can be a dataset in a semantic model, so a spreadsheet user's cleaned data becomes a governed metric.
- **Validation** against Ossie's published JSON schema in the control service (TypeScript), with no Python dependency; its compliance cases (query and portability) become part of our tests.

### 8.2 Portable agents (standards that do exist)

- **MCP server for GridZero (recommended).** Expose GridZero's tools (`query_metric`, read a workbook, run Python, create a widget) as an MCP server. Then the same capabilities work from Claude, ChatGPT, Copilot or any MCP-capable agent, not only from GridZero's own agents. This is the portability users will actually feel.
- **Agent definitions as data.** Store each agent as a plain document: instructions, tool grants, schedules and the metrics it may use. Offer export as [Open Agent Spec](https://github.com/oracle/agent-spec) (Apache-2.0, framework-agnostic agent definitions), once we have checked how well it maps; Agent Spec is young, so this is a "later" item, not a foundation.

## 9. Prior art: OpenDuet (reviewed 2026-11-10)

[CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) (MIT, ~2,000 stars, "early development") is a proactive personal assistant: a morning brief from Gmail and Calendar, triage of what needs you, tasks it keeps working on in its own sandboxed computer, scheduled routines, and a "Make" tab that produces dashboards and pages. It is a skin on CopilotKit's OpenBot platform (Bun, Docker, a container per bot) and will not start without a CopilotKit Intelligence project, a hosted service that keeps threads and memory.

**Not a base for GridZero.** It is a separate application with its own server, database and hosted dependency; adopting it would mean running two products side by side, and its centre is an inbox assistant, not data and dashboards.

**Patterns worth taking (ideas, written our own way):**
- Approvals with three answers, **Refuse / Allow once / Always allow**, with every changing action checked against policy and recorded. Fits section 4.4.
- A **masked secret box** for logins, so a password reaches the site and never the agent's conversation; saved credentials are write-only. Fits the cloud browser after beta and app sign-ins.
- An **outgoing-message check** for sensitive data (card numbers, health details) before anything is sent.
- **Take-over control** of the agent's browser that first lets the action already in progress finish, then stops new ones.
- **Evals per feature** (it measures triage and reply suggestions on labelled sets); we should do the same for widget proposals and scheduled summaries.
- A **setup checklist** that reports each dependency (model key, connected apps) as Ready, Not checked or Needs setup, from a live check. Fits the bring-your-own-key flow in phase 1.

**Worth a short spike in phase 1:** CopilotKit's open-source React components for chat and tool-driven UI ("generative UI"), to see whether they save building the chat panel and widget cards ourselves without pulling in Intelligence.

## 10. Not copying

The plan takes the general idea (agents that build and refresh dashboard widgets), which many products share. It does not copy the course's code, prompts, branding or visual design, and does not depend on its sponsors' services except where we choose them on merit (Browserbase, Composio).
