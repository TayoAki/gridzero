# What the planned screens need from the backend

The web app now has two kinds of screen.

- **Real screens** sit in the new shell (rail, list, tabs, main, agent panel, bottom bar) and use the API that exists: workbooks, reports, agents, How we count, apps, settings.
- **Planned screens** (47 of them, under `/preview` once a page is opened with `?preview=1`) are designed and filled with sample data. None is connected. Each one declares what it would need, in `apps/web/src/preview/meta/*.ts`.

The second half of this file is generated from those declarations by `node apps/web/scripts/backend-needs.ts`. Run it again after changing a planned screen. The first half is a hand-written reading of it.

## The connections

Twenty outside systems. The screens name eighteen; BigQuery and Databricks are the same work as Snowflake.

| # | Connection | Screens | Today |
|---|---|---|---|
| 1 | Shopify | H1, H2, I1, K1, L2, L4 | Not built |
| 2 | Meta Ads | H1, H3, I1, K1, L4 | Not built |
| 3 | Google Ads | H1, L4 | Not built |
| 4 | Instagram | I5, K2 | Not built |
| 5 | TikTok | I5, K2 | Not built |
| 6 | LinkedIn | I5, K2 | Not built |
| 7 | Accounting ledger (QuickBooks, Xero or NetSuite) | K3, K8, M5 | Not built |
| 8 | Billing (Stripe) | K3 | Not built |
| 9 | Sales system (Salesforce or HubSpot) | K9 | Not built |
| 10 | Snowflake | J1 to J6, K4, K6, K7, M1 | Partly: SQL runs against it for connected tables; no scan for definitions, no per-person sign-in |
| 11 | BigQuery | as Snowflake | Partly, the same |
| 12 | Databricks | as Snowflake | Partly, the same |
| 13 | Metrics project (dbt) | J5, K4, M2 | Not built |
| 14 | Version control (GitHub or GitLab) | K4, M2 | Not built |
| 15 | Tableau | M4 | Not built |
| 16 | Power BI | M4 | Not built |
| 17 | Chat alerts (Slack or Teams) | J4, K6, K9, K10, M3, M5 | Partly: the Apps page can connect them and send with approval; nothing sends an alert on its own |
| 18 | Company sign-in and directory (Okta or Entra) | J6, J8, J9, K11, M7 | Not built |
| 19 | The agency's own web address | L5 | Not built |
| 20 | The agency's own email sender | G3, L5 | Not built |

Connections 1 to 9 are one piece of engineering used nine times: sign in to an account, pull its data into tables on a schedule, record when it last worked, and say what is affected when it stops. The roadmap already proposes dlt for this.

## The backend work, in the order the screens need it

Each line is a capability several screens share. The detailed endpoints, jobs and stored data are in the generated part.

| # | Capability | Unlocks | Builds on |
|---|---|---|---|
| 1 | **Clients.** A client is a named workspace with contacts, branding and its own data, reports and counting rules. | G1, I1, L4 | Workspaces, members and roles |
| 2 | **Reports as things you send.** A report belongs to a client and a month, has a state (draft, held, sent), can be copied to another client or month, and is sent by link, PDF or email. | G2, G3, G5, L1, L7 | Dashboards, widgets, schedules, sharing |
| 3 | **The client's page.** A read-only page for someone with no account, under the sender's name, optionally answering questions from confirmed numbers only. | G4, I5, L5, L6 | Share links; grounding labels |
| 4 | **Sync.** Connections 1 to 9, the scheduled pull, health checks and "what is affected". | H1 to H3, K1 to K3, K9 | Data Tables; connected-table schedules |
| 5 | **Notice and hold back.** Before a send or a refresh, compare with the last period and with data completeness; hold and explain when it looks wrong. The same engine flags two reports that disagree. | L2, M3, H3 | Checks C1 to C10; trusted numbers |
| 6 | **Written commentary** from confirmed numbers, learning from edits. | L3 | Agents; trusted answers |
| 7 | **Warehouse scan** with each person's own sign-in and a cost estimate first. | J1, K4 | The Postgres scan and estimate |
| 8 | **Drill to rows, and a person's own query beside the agent's.** | J2, K7, K8 | `query_definition`, `run_sql` |
| 9 | **What moved since last time,** with drivers, and a brief before each review. | J3, K9, M5 | Needs saved snapshots at each review |
| 10 | **Threshold alerts** checked on a timer, with an owner and one action. | J4, K10 | Schedules; chat alerts |
| 11 | **Trace and write-back.** The path from a widget to a definition to tables; confirmed definitions written to the team's own project as a change request. | J5, M2, K6 | Ossie export; definition versions |
| 12 | **Access you can prove.** See as another person, a query log with warehouse cost, column masking, a statement of what is sent to the AI, and a mode where nothing is stored outside the warehouse. | J6, J7, J10, M1 | Run-as-asker; AI usage page |
| 13 | **Company sign-in** with groups mapped to roles. | J9, K11 | Better-Auth |
| 14 | **Existing dashboards read the same definitions.** | M4 | Ossie export |
| 15 | **Measurement.** Time saved for an agency; requests and time to a trusted answer for a data team. | L7, J8, K5, M6 | Run and usage records |
| 16 | **Things that are not code.** An independent security audit, an uptime commitment, a choice of region. | K11, M7 | |

Capabilities 1 to 6 are the agency track. 7 to 15 are the warehouse track. Number 5 serves both.

## What is real today

- The shell, search, the "For you" list, light and dark themes, the phone layout.
- Home with three ways to start, including a sample file that imports as a Data Table.
- The agent beside whatever is open, told which workbook or report that is.
- How we count, in four tabs: Questions, How we count, Checked answers, Changes.
- Everything that was there before, inside the shell.

<!-- generated:start -->

47 planned screens name 173 different needs: 15 built, 30 partly built, 128 not built.

### Connections to outside systems (18)

| Need | Today | Screens | What it has to do |
|---|---|---|---|
| Snowflake | Partly | J1, J2, J3, J4, J5, J6, M1, K4, K6, K7 | Read the catalog, column summaries and 90 days of query history from ANALYTICS. Querying Snowflake from connected tables works today; scanning it for definitions does not. |
| Chat alerts (Slack or Teams) | Partly | K9, K10, J4, K6, M3, M5 | Ask the owner sends the deal owner a message about one deal. Apps connections with approval exist; this message type does not. |
| Shopify | Not built | L2, L4, H1, H2, I1, K1 | The store connection whose sign-in ran out; needs to be reconnected and to say when it last brought data in. |
| Company sign-in and directory (Okta or Entra) | Not built | J6, J8, J9, K11, M7 | Pick people and groups to check by their company identity. |
| Meta Ads | Not built | L4, H1, H3, I1, K1 | Connect the client's ad account for spend and results. |
| Accounting ledger (QuickBooks, Xero or NetSuite) | Not built | K3, K8, M5 | Journal entries, the list of accounts and which periods are closed. |
| Metrics project (dbt) | Not built | J5, M2, K4 | Read the project's manifest for model-to-model and model-to-source links, test results and last run time. |
| Email sender (agency's own domain) | Not built | G3, L5 | Deliver the email from the agency's address. Today mail goes out only for invites, from our own address. |
| Google Ads | Not built | L4, H1 | Connect the client's ad account for spend and results. |
| Instagram | Not built | I5, K2 | Followers, reach, engagement and the posts themselves for the month. |
| LinkedIn | Not built | I5, K2 | Followers, impressions and engagement by post for the month. |
| TikTok | Not built | I5, K2 | Followers, views and engagement by post for the month. |
| Version control (GitHub or GitLab) | Not built | M2, K4 | Create a branch, commit the change and open a change request; read its review and merge state. |
| Billing (Stripe) | Not built | K3 | Invoices, payments, refunds and subscriptions. |
| Custom web address | Not built | L5 | Serve client pages from the agency's own address, such as reports.brightside.co, with a secure connection. |
| Power BI | Not built | M4 | Read each report's model and measures, and publish confirmed definitions as a model it can read. |
| Sales system (Salesforce or HubSpot) | Not built | K9 | Open deals with amount, stage, close date and owner, plus the history of changes to those fields. |
| Tableau | Not built | M4 | Read each dashboard's data sources and calculated fields, and publish confirmed definitions as a data source it can read. |

### API endpoints (61)

| Need | Today | Screens | What it has to do |
|---|---|---|---|
| GET /api/v1/public/reports/:token | Not built | G4, L6 | Serve one report by a private link with no sign-in, as it stood when it was sent. |
| GET /api/v1/reports/:id/precheck | Partly | G2, G3 | Before copying, say which widgets are ready, which need an answer and which have no matching column. |
| GET /api/v1/sources/:id/export | Built | M2, M4 | The Ossie export of confirmed definitions is the starting point for converting a definition into the project's format. |
| GET /api/v1/workspaces/:id/activity/export | Not built | K11, M7 | Download the log for a date range, or send it on to the company's own log store. |
| GET /api/v1/workspaces/:id/pilot | Not built | K5, M6 | Return the pilot's team, start date, baseline and weekly figures for the scorecard. |
| GET /api/v1/workspaces/:id/sync-connections | Not built | H1, H2 | Show which services are already connected for this client, so a connected one is not offered again. |
| POST /api/v1/alerts/:id/assign | Not built | K10, J4 | Give the alert to a named person and tell them. |
| POST /api/v1/clients | Not built | G1, L4 | Start a new client from the list. |
| POST /api/v1/definitions/:id/rows | Not built | J2, J3 | Return the rows behind a definition's value for a period and filter, paged, with the total they add up to and the count of rows left out. |
| GET /api/v1/adoption | Not built | J8 | Return the three headline figures, the by-team table and the most-asked questions still going to the data team. |
| GET /api/v1/alerts | Not built | J4 | List queues with their count, limit, state and timeline. |
| GET /api/v1/briefs/:id | Not built | M5 | Return the brief: what moved, the cause, the rows behind it and the suggested next steps. |
| GET /api/v1/clients | Not built | G1 | Return every client the person can see with the state of this month's report, how many numbers are unconfirmed and the date the data runs to. |
| GET /api/v1/definitions/:id/history | Built | J5 | List versions with who confirmed each and when. |
| GET /api/v1/definitions/:id/trace | Not built | J5 | Return the chain widget, definition, model, source table, with column-level mapping and freshness for each step. |
| GET /api/v1/definitions/:id/value | Built | J2 | Give the number and the SQL shown beside the rows. |
| GET /api/v1/forecast/changes | Not built | K9 | Compare now with a chosen snapshot: deals slipped, pulled in, lost or changed in size, grouped by owner. |
| GET /api/v1/queries | Not built | J7 | List and filter the log, total it by person, and export it. |
| GET /api/v1/reports/:id/compare | Not built | J3 | Return then and now for each number, the ranked drivers and what could not be explained, against a chosen earlier review. |
| GET /api/v1/runs/:month | Not built | L1 | Return one month's run across all clients: each report's outcome, time, data date and the steps the run took. |
| GET /api/v1/shared-reports/:token | Not built | I5 | Serve a finished report to someone without an account, with no product controls. |
| GET /api/v1/sources/:id/posts | Not built | K2 | Return posts for a period, sorted by reach, with their picture and caption. |
| GET /api/v1/sources/:id/review | Built | I3 | Already returns the ways of counting and open questions for a table; the simple view shows the same items in one list. |
| GET /api/v1/sources/:id/scan/estimate | Partly | J1 | Return tables, warehouse cost in dollars and minutes per step for a Snowflake source. Today it returns a row estimate for Postgres only. |
| GET /api/v1/summary/time-saved | Not built | L7 | Return, per month, reports sent, reports held and fixed, hands-on hours, client questions answered and passed on. |
| GET /api/v1/sync-connections/:id/affected | Not built | H3 | List the reports, widgets and scheduled sends that read from this connection. |
| GET /api/v1/usage | Partly | J7 | AI spend per person for the month. Spend on naming and corrections is not yet included. |
| GET /api/v1/workspaces | Built | I1 | Already returns the person's workspaces; the screen uses the count to decide whether to show the switcher. |
| GET /api/v1/workspaces/:id/connected-tools | Not built | M4 | Return each tool, its dashboards, which definition and version each reads, and when it was last checked. |
| GET /api/v1/workspaces/:id/data-location | Not built | M1 | Return the latest check, its history and a downloadable evidence file. |
| GET /api/v1/workspaces/:id/pilot/export | Not built | M6 | Download the results and the method as a document the director can pass on. |
| GET /api/v1/workspaces/:id/week | Not built | K1 | Return the latest weekly summary for the phone page and the email. |
| POST /api/v1/alerts/:id/snooze | Not built | K10 | Stop repeats for a set time without closing the alert. |
| POST /api/v1/changes/:id/publish | Partly | K6 | Publish the change. Today this updates the definition and its metrics; it must also update every report that reads it, in one step. |
| POST /api/v1/clients/:id/rules/propose | Not built | L4 | Compare the new client's data with a similar client's rules, say which match, and for each difference give the choices with the number each leads to. |
| POST /api/v1/conflicts/:id/resolve | Not built | M3 | Point both reports at the confirmed definition, or record why they are meant to differ. |
| POST /api/v1/definitions/:id/copies | Not built | J2 | Make a personal, unconfirmed copy of a definition that can be edited and later sent for review. Today a correction changes the shared definition after a preview; there is no personal copy. |
| POST /api/v1/definitions/:id/correct | Built | K6 | Propose the change and return old and new numbers and what it affects. |
| POST /api/v1/definitions/:id/dispute | Built | I3 | Behind the This is wrong button. |
| POST /api/v1/definitions/:id/reconcile | Not built | K8 | Compare the definition's total for a period with the trusted figure, return match or gap, and record who confirmed it. |
| POST /api/v1/definitions/:id/write-back | Not built | M2 | Build the file change for a confirmed definition, check the project still builds, and open the change request. |
| POST /api/v1/metrics/:id/query | Built | J5 | Show the SQL for the number. |
| POST /api/v1/public/reports/:token/questions | Not built | L6 | Take a question from the report page and answer it from that report's data, or say it has been passed to the agency. |
| POST /api/v1/questions/:id/answer | Built | I3 | Answer the open question (do test orders count) from this screen. |
| POST /api/v1/reports/:id/access-check | Not built | J6 | Run a report's queries once per chosen person and return each result, or 'hidden' where the person has no access or no saved sign-in. |
| POST /api/v1/reports/:id/commentary | Not built | L3 | Draft or redraft the month's summary for a report, with options such as shorter or more on ads, and return each figure used with its rule. |
| POST /api/v1/reports/:id/copy | Partly | G2 | Copy a report's layout and counting rules to another client or month and work the numbers out from that client's data. Copying a workbook exists; copying across clients with rules does not. |
| POST /api/v1/reports/:id/release | Not built | L2 | Let the agency send a held report after a fix, or as it is with a line saying where the data ends. |
| POST /api/v1/reports/:id/send | Not built | G3 | Send one report to chosen people as a link, a PDF or an email with a subject and a note. |
| POST /api/v1/sources/:id/import | Partly | K4 | Take a metrics project, return the metrics found, which match and which differ, and create definitions for the ones the person brings in. Today only the product's own YAML export can be read back. |
| POST /api/v1/sources/:id/queries/compare | Not built | K7 | Run a person's query and the AI's draft, return both totals and the rows present in one result and not the other. |
| POST /api/v1/sources/:id/scan | Partly | J1 | Start the scan for a Snowflake source with the chosen schemas and warehouse. Exists for Postgres and workbook tables. |
| POST /api/v1/sync-connections/:id/reconnect | Not built | H3 | Sign in again for an existing connection and fill the missing days straight afterwards. |
| POST /api/v1/sync-connections/:id/sync | Not built | H2 | Run one connection now when the person presses Sync now. |
| POST /api/v1/workspaces/:id/sync-connections | Not built | H1 | Start a sign-in for one client and one service, then store the granted access against that client's workspace. |
| PUT /api/v1/branding | Not built | L5 | Save the agency's name, logo, colour, web address and sending address, and each client's own logo. |
| PUT /api/v1/me/profile | Not built | I2 | Save the answer (or the skip) and allow it to be changed later from settings. |
| PUT /api/v1/reports/:id/schedule | Partly | G5 | Save the day, time, people and format for a report's monthly send, and pause it. Schedules exist for agent tasks and widget refresh, not for sending. |
| PUT /api/v1/workspaces/:id/group-roles | Not built | J9 | Save which directory group gets which role. |
| PUT /api/v1/workspaces/:id/masked-columns | Not built | J10 | Add and remove masked columns, list where each appears, and return suggestions for columns that look personal. |
| PUT /api/v1/workspaces/:id/sso | Not built | J9 | Save the sign-in connection, test it, and turn on 'require single sign-on'. |

### Background jobs (25)

| Need | Today | Screens | What it has to do |
|---|---|---|---|
| Scheduled sync | Not built | H2, I1, K1, K2, K3, K9 | Fetch each connection on its timetable (daily at 06:00 here) and add only what is new or changed. |
| Find the rows that explain a gap between two numbers | Not built | K7, K8, M3 | Group the rows that differ by cause (here, 41 late refunds) so the difference reads as a sentence. |
| Anomaly check before send | Not built | L1, L2 | Check each rebuilt report before it sends and hold the ones that look wrong. |
| Hold scheduled sends while a change or conflict is open | Not built | K6, M3 | Stop the scheduled sends of affected reports until the change is published or discarded. |
| Measure requests and time to a checked answer each week | Not built | K5, M6 | Each week, count questions asked, how long each took to reach a checked answer, and how many distinct people asked. |
| Monthly report run | Partly | G5, L1 | On the day, rebuild the report for the month before and send it. The timer exists; rebuilding and sending do not. |
| Store and ads data sync | Not built | L1, L2 | Bring in each client's store and ad data before the reports rebuild, and notice when a source stops. |
| Adoption rollup | Not built | J8 | Each night, count questions per team, how many ended on confirmed definitions without the data team, the time taken, and repeats. |
| Check connected dashboards against confirmed definitions | Not built | M4 | Each morning, compare every dashboard's formula with the confirmed one and mark it in step or out of step. |
| Check for the same name defined by different formulas | Partly | M3 | Run across reports as well as definitions, and before each scheduled send. Today the check runs across definitions in a source. |
| Compare imported metrics with the warehouse and with dashboard formulas | Not built | K4 | For each metric, compute the number both ways and record the difference in value and in rows. |
| Daily check for rows held outside the warehouse | Not built | M1 | Each day and after each update, prove no result rows are stored and list outbound connections, and keep the result as evidence. |
| Directory sync (people and groups) | Not built | J9 | Add, change and remove members as the directory changes (SCIM or polling), sign leavers out and pause their schedules. |
| Driver ranking for a change | Not built | J3 | Split a change in a ratio such as margin into the parts due to each dimension or cost line, so the parts add up to the whole. |
| Forecast snapshot | Not built | K9 | Keep a copy of the pipeline at the time of each forecast call (Mondays 09:00) to compare against. |
| PDF maker | Not built | G3 | Turn the report page into a PDF with the client's logo on each page. |
| Prepare a brief before each review | Not built | M5 | The evening before, compare each confirmed number with its value at the last review, pick the ones that moved most and find the rows behind each move. |
| Sync health check | Not built | H3 | After every failed or missed run, mark the connection as needing attention with a plain reason and the last good day. |
| Threshold check every minute | Not built | K10 | Read the watched number each minute, compare with its limit, and open or close an alert when it crosses. |
| Threshold check on a schedule | Not built | J4 | Count each queue every 15 minutes, compare with its limit, and record when it went over and came back. |
| Warehouse cost collection | Not built | J7 | Read Snowflake's usage views and attach a dollar cost to each logged query by its query id. |
| Warehouse scan (catalog, column summaries, query history) | Not built | J1 | Run the scan in the background, sample large tables, read ACCOUNT_USAGE.QUERY_HISTORY, and stop if the cost passes the limit. |
| Web address and sender check | Not built | L5 | Check regularly that the web address still points to us and the sending address is still approved, and say so on the screen. |
| Weekly digest | Not built | K1 | Each Monday after the sync, work out the three numbers, compare with the week before and write the one thing that changed. |
| Write-back status sync | Not built | M2 | Watch each open change request until it merges or closes, and raise a question when the project's version differs from the confirmed one. |

### Stored data (47)

| Need | Today | Screens | What it has to do |
|---|---|---|---|
| Report send log | Not built | G3, G4, G5, L1 | Keep who was sent what, when, and whether they opened it. |
| Monthly run record | Not built | L1, L2, L7 | Keep each run's steps and each report's outcome so the summary can be shown later. |
| Synced tables | Partly | H2, I1, K3 | Land fetched orders as a Data Table like an uploaded file, but one that grows on its own and remembers when it was last filled. |
| Which reports and dashboards use each definition | Partly | K6, M3, M4 | List the 17 reports, their owners, viewers and next scheduled send. Today the preview lists the metrics that change, not the reports. |
| Activity log across the workspace | Partly | K11, M7 | Who signed in, ran a query, changed a definition or shared an answer. Today changes are kept per definition and per workbook, not in one log. |
| Branding (logo, colour, name) | Not built | G4, L5 | The client's logo at the top and the agency's name in the footer. |
| Checked answers | Built | J3, J8 | Hold the ledger totals Finance typed in and show whether each still matches. |
| Client contacts | Not built | G3, G5 | Names, email addresses and roles of the people at each client who receive reports. |
| Client question log | Not built | L6, L7 | Keep each question, who asked, the answer given and whether it was passed on, for the agency to read. |
| Company-wide model key | Partly | J10, M1 | One key set by an admin for everyone. Today each member saves their own key. |
| Confirmed definitions with versions | Built | J2, M2 | Show the version, who confirmed it and when, and compare the copy's number with it. |
| Counting rules per client | Partly | G2, L3 | Copy the rules as unconfirmed for the new client and mark the ones that cannot be worked out, such as a missing refunds column. Rules with a confirmed state exist per workspace. |
| Definitions with confirmed status | Built | I3, K1 | Label, plain rule, current value and who confirmed it. |
| Each person's own warehouse sign-in | Partly | J1, J6 | Save a Snowflake user and role per member so the scan sees only what that member may read. Built for Postgres sources; Snowflake sign-in (key pair or OAuth) is not. |
| Pilot baseline and weekly measurements | Not built | K5, M6 | Store the starting week's figures and one row per week after it: requests, time to a checked answer, people asking. |
| Post previews | Not built | I5, K2 | Image, caption and date of each post, kept so the page still shows them if the post is later removed. |
| Report (per client and month) | Partly | G1, L3 | Know which dashboard is a client's report for a given month and whether it is a draft, due, held or sent. Dashboards exist; the month and the state do not. |
| Report template | Not built | G2, L4 | Hold a report's widgets and the rules they use apart from any one client's data, so it can be laid over another client. |
| Request queue counts from the data team's ticket tool | Not built | K5, M6 | The 'before' side: how many requests reached the data team each week and how long they took. Entered by hand or read from the ticket tool. |
| Sync history | Not built | H2, H3 | Each run with its time, rows added, rows changed and result, for the list of recent syncs. |
| Trusted number entered by a person and checked against the definition | Partly | K8, M5 | The figure Finance trusts for the period. Today a person can type it once during review; it is not kept per period. |
| Warehouse query log with cost | Not built | J7, J8 | Record every query Grid Zero runs: who, what, rows read, time, the warehouse's query id, and whether it was stopped. |
| Access check record | Not built | J6 | Keep who checked, as whom and when, without keeping the numbers. |
| AI usage per person | Built | K5 | Who asked and how often, to count people asking and show which requests no longer reach the team. |
| Alert limits, owners and history | Not built | J4 | Store the limit, the owning team, who is assigned and the timeline of each alert, including related events such as a late file. |
| Alert rules and history | Not built | K10 | Each rule's number, limit, owner and where to send; each alert's start, peak, who was assigned and when it cleared. |
| Client table | Partly | G1 | One row per client with a name, who looks after it and which workspace holds its files. Workspaces exist; a client as a named thing on top of one does not. |
| Commentary drafts and edits | Not built | L3 | Keep each draft and every edit the person makes, so later drafts follow their way of writing. |
| Company's own model key | Partly | K11 | One key set for the whole workspace by an admin, used for every AI call. Today each member can save a key of their own. |
| Definitions with status, versions and owner | Built | K4 | Imported metrics arrive as drafts owned by the person named in the project, ready to confirm. |
| Forecast snapshots | Not built | K9 | The saved copies, with coverage, target and each deal's amount and close date at that moment. |
| Hours-before figure per agency | Not built | L7 | The hours the agency said reporting took before, so there is something to compare against. Shown as an example until it is entered. |
| Lineage (widget to definition to model to source table) | Not built | J5 | Store which widgets read which definition and which tables and columns a definition reads. Widgets still read the older metric models, so the widget link is missing today. |
| Period close status | Not built | K3 | Which months are closed and when, read from the ledger, shown on the table and in the bottom bar. |
| Product state stored in the customer's warehouse | Not built | M1 | Keep definitions, versions, the query log and settings in a schema in the customer's own database in place of Grid Zero's database. |
| Queries written by a person, saved with the answer | Not built | K7 | Keep the analyst's SQL, who ran it and when, so an answer can be shared with the query attached. |
| Question outcomes (asked, answered, accepted, sent to the data team) | Partly | J8 | Record for each question who asked, their team, whether the answer used only confirmed definitions, whether it was accepted, and whether it became a request. Agent runs and review questions are stored, but not these outcomes. |
| Read-only SQL run by agents with the SQL shown | Built | K7 | The AI's draft query and its result, shown in full. |
| Reconciliation history per period | Not built | K8 | One row per period: both totals, the gap, the cause, who confirmed. |
| Record of what was sent to the AI | Not built | J10 | Keep, per question, which columns and how many rows were sent, so an admin can show it for one question. |
| Report branding | Not built | I5 | The sender's name, the client's colours and logo, and the web address the page is shown under. |
| Review schedule: which meeting, when, who attends, which numbers | Not built | M5 | So the brief is prepared for the right people at the right time. Entered by hand at first. |
| Review snapshots (numbers saved at each review) | Not built | J3 | Keep each report's numbers, definition versions and period at the time of a review so a later one can be compared with it. |
| Security and contract documents for download | Not built | M7 | Audit report, data processing agreement, list of subprocessors, completed security questionnaire. |
| Starting setups | Not built | I2 | For each of the five answers: the home tiles, the report templates and the order in which connections are offered. |
| Workspace members and roles | Partly | J9 | Members and roles exist, added by hand; they need a marker for 'managed by the directory'. |
| Workspace profile | Not built | I2 | The chosen description, stored per person and copied to the first workspace they create. |

### Rules the product must enforce (22)

| Need | Today | Screens | What it has to do |
|---|---|---|---|
| Client-facing words use confirmed numbers only | Partly | G4, L3, L6 | Leave out any number that is not confirmed and show who confirmed the rest and when. |
| Each client's data stays separate | Partly | G1, G2, L6 | Workbooks, reports, counting rules and the analyst only ever show the chosen client's things. Workspace membership covers part of this. |
| Queries run as the viewer, never a shared sign-in | Partly | J2, J6, M1 | The rows come back under the asker's own user, and a colleague who reruns a shared drill gets only their own rows. |
| Client page is read-only with no product controls | Not built | G4, L5 | No editing, menus or sign-in to the product, and nothing outside this one report. |
| Hold back on a big change or missing days | Not built | G5, L2 | Also hold the send when data does not cover the whole month or a number has moved by more than 40%. |
| Independent security audit | Not built | K11, M7 | An audit by an outside firm, with a report that can be sent on request under a confidentiality agreement. |
| Row and cost check before a query runs | Partly | J1, J7 | Turn the estimate into warehouse dollars and stop the scan above a set amount. Today the limit is 50 million estimated rows from the Postgres planner. |
| Single-business layout | Not built | I1, I3 | When an account has one workspace and no clients, hide the switcher and client words everywhere; show them once a second one is added. |
| Closed periods do not change | Not built | K3 | If a closed month's figures differ on a later sync, flag it instead of quietly replacing them. |
| Column masking before anything is sent to the AI | Not built | J10 | Replace the values of masked columns, matched by name across all tables, in summaries and results before they are sent. |
| Data stays in a chosen region | Not built | K11 | The company picks where its data is stored and processed, and the page shows the choice. |
| Group to role mapping | Not built | J9 | The higher role wins when someone is in two groups; nobody outside a mapped group can sign in. |
| Hold scheduled sends on stale data | Not built | H3 | A report that reads from a broken connection is not sent to a client until someone decides. |
| One alert per breach | Not built | K10 | Send once when the limit is crossed and once when it clears; repeat only if nobody has been assigned after a set time. |
| Read-only access to connected accounts | Not built | H1 | Ask each service for read permission only, and show the list of what is read on the screen before sign-in. |
| Results are shown, not kept | Not built | M1 | Query results pass through to the browser and are never written to disk or cache outside the warehouse; saved reports keep the query, not the rows. Today connected tables and workbooks store result rows. |
| Row cap on results sent to the AI | Partly | J10 | Never send more than 500 rows of a result; tell the model how many there were. A cap may exist in the agent tools but is not a setting an admin can see. |
| Send only when every number is confirmed | Not built | G5 | Do not send if any number in the report is unconfirmed; tell the agency instead. |
| Sign-up question is optional | Not built | I2 | Skipping gives the general setup; the answer never hides a feature, it only changes what is offered first. |
| Simple view until needed | Not built | I3 | Hide changes, checked answers and database sign-in until the workspace has at least one of each. |
| Spend limits per person | Partly | J7 | A daily warehouse limit per person next to the monthly AI cap. The monthly AI cap exists; the warehouse limit and an admin page to set both do not. |
| Uptime commitment 99.9% | Not built | M7 | A written commitment, a public record of past uptime, and what the customer is owed when it is missed. |

### By screen

**G · Clients and delivery**

- G1 Switch client (for agency reporting lead): Client table; GET /api/v1/clients; POST /api/v1/clients; Report (per client and month); Each client's data stays separate
- G2 Reuse a report (for agency reporting lead): POST /api/v1/reports/:id/copy; Report template; Counting rules per client; GET /api/v1/reports/:id/precheck; Each client's data stays separate
- G3 Send the report (for agency reporting lead): POST /api/v1/reports/:id/send; GET /api/v1/reports/:id/precheck; PDF maker; Email sender (agency's own domain); Client contacts; Report send log
- G4 What the client sees (for client contact (previewed by the agency reporting lead)): GET /api/v1/public/reports/:token; Client page is read-only with no product controls; Client-facing words use confirmed numbers only; Branding (logo, colour, name); Report send log
- G5 Send it every month (for agency reporting lead): PUT /api/v1/reports/:id/schedule; Monthly report run; Send only when every number is confirmed; Hold back on a big change or missing days; Client contacts; Report send log

**H · No more exports**

- H1 Connect a store (for Agency reporting lead): Shopify; Meta Ads; Google Ads; POST /api/v1/workspaces/:id/sync-connections; GET /api/v1/workspaces/:id/sync-connections; Read-only access to connected accounts
- H2 Synced and fresh (for Agency reporting lead): Shopify; Scheduled sync; Synced tables; Sync history; POST /api/v1/sync-connections/:id/sync; GET /api/v1/workspaces/:id/sync-connections
- H3 Sync needs attention (for Agency reporting lead): Meta Ads; Sync health check; POST /api/v1/sync-connections/:id/reconnect; GET /api/v1/sync-connections/:id/affected; Sync history; Hold scheduled sends on stale data

**I · Fitting the other profiles**

- I1 One business, no switcher (for Shopify store operator): Shopify; Meta Ads; Single-business layout; GET /api/v1/workspaces; Synced tables; Scheduled sync
- I2 What describes you (for Anyone signing up): PUT /api/v1/me/profile; Workspace profile; Starting setups; Sign-up question is optional
- I3 How we count, simple view (for Shopify store operator): GET /api/v1/sources/:id/review; POST /api/v1/questions/:id/answer; POST /api/v1/definitions/:id/dispute; Definitions with confirmed status; Simple view until needed; Single-business layout
- I5 Social report, client view (for Social media manager (seen by their client)): Instagram; TikTok; LinkedIn; GET /api/v1/shared-reports/:token; Report branding; Post previews

**J · Warehouse teams**

- J1 Connect and scan a warehouse (for Analytics engineering lead): Snowflake; Each person's own warehouse sign-in; GET /api/v1/sources/:id/scan/estimate; POST /api/v1/sources/:id/scan; Warehouse scan (catalog, column summaries, query history); Row and cost check before a query runs
- J2 Drill to the rows (for Senior data analyst): Snowflake; POST /api/v1/definitions/:id/rows; GET /api/v1/definitions/:id/value; POST /api/v1/definitions/:id/copies; Confirmed definitions with versions; Queries run as the viewer, never a shared sign-in
- J3 What moved since last time (for Head of FP&A): Review snapshots (numbers saved at each review); GET /api/v1/reports/:id/compare; Driver ranking for a change; Checked answers; POST /api/v1/definitions/:id/rows; Snowflake
- J4 A queue over its limit (for Director of operations): Threshold check on a schedule; Alert limits, owners and history; GET /api/v1/alerts; POST /api/v1/alerts/:id/assign; Chat alerts (Slack or Teams); Snowflake
- J5 Trace a number to its source (for Analytics engineering lead): GET /api/v1/definitions/:id/trace; Lineage (widget to definition to model to source table); Metrics project (dbt); Snowflake; GET /api/v1/definitions/:id/history; POST /api/v1/metrics/:id/query
- J6 See as another person (for Data platform and security lead): POST /api/v1/reports/:id/access-check; Each person's own warehouse sign-in; Queries run as the viewer, never a shared sign-in; Access check record; Snowflake; Company sign-in and directory (Okta or Entra)
- J7 Query log and spend (for Data platform and security lead): Warehouse query log with cost; Warehouse cost collection; GET /api/v1/queries; GET /api/v1/usage; Spend limits per person; Row and cost check before a query runs
- J8 Use of shared numbers (for Director of data): Adoption rollup; GET /api/v1/adoption; Question outcomes (asked, answered, accepted, sent to the data team); Warehouse query log with cost; Checked answers; Company sign-in and directory (Okta or Entra)
- J9 Company sign-in (for Data platform and security lead): Company sign-in and directory (Okta or Entra); PUT /api/v1/workspaces/:id/sso; PUT /api/v1/workspaces/:id/group-roles; Directory sync (people and groups); Group to role mapping; Workspace members and roles
- J10 What the AI can see (for Data platform and security lead): Column masking before anything is sent to the AI; PUT /api/v1/workspaces/:id/masked-columns; Row cap on results sent to the AI; Record of what was sent to the AI; Company-wide model key

**K · Closing each person's last gap**

- K1 Your week, no grid (for Shopify store operator): Shopify; Meta Ads; Weekly digest; GET /api/v1/workspaces/:id/week; Definitions with confirmed status; Scheduled sync
- K2 Social accounts connected (for Social media manager): Instagram; TikTok; LinkedIn; GET /api/v1/sources/:id/posts; Post previews; Scheduled sync
- K3 Accounting and billing connected (for Finance analyst): Accounting ledger (QuickBooks, Xero or NetSuite); Billing (Stripe); Scheduled sync; Synced tables; Period close status; Closed periods do not change
- K4 Bring in definitions you already have (for Analytics engineering lead): Metrics project (dbt); Version control (GitHub or GitLab); Snowflake; POST /api/v1/sources/:id/import; Compare imported metrics with the warehouse and with dashboard formulas; Definitions with status, versions and owner
- K5 Pilot scorecard (for Director of data): Pilot baseline and weekly measurements; Measure requests and time to a checked answer each week; GET /api/v1/workspaces/:id/pilot; Request queue counts from the data team's ticket tool; AI usage per person
- K6 One change, every report (for Analytics lead or BI manager): Snowflake; POST /api/v1/definitions/:id/correct; POST /api/v1/changes/:id/publish; Which reports and dashboards use each definition; Hold scheduled sends while a change or conflict is open; Chat alerts (Slack or Teams)
- K7 Your query beside the AI's (for Senior data analyst): Snowflake; Read-only SQL run by agents with the SQL shown; POST /api/v1/sources/:id/queries/compare; Queries written by a person, saved with the answer; Find the rows that explain a gap between two numbers
- K8 Tie to Finance's number (for Head of FP&A): Accounting ledger (QuickBooks, Xero or NetSuite); Trusted number entered by a person and checked against the definition; POST /api/v1/definitions/:id/reconcile; Find the rows that explain a gap between two numbers; Reconciliation history per period
- K9 Sales system connected (for Head of revenue operations): Sales system (Salesforce or HubSpot); Scheduled sync; Forecast snapshot; Forecast snapshots; GET /api/v1/forecast/changes; Chat alerts (Slack or Teams)
- K10 Live checks and alerts (for Director of operations): Threshold check every minute; Alert rules and history; Chat alerts (Slack or Teams); POST /api/v1/alerts/:id/assign; POST /api/v1/alerts/:id/snooze; One alert per breach
- K11 Security and trust (for Data platform or security lead): Independent security audit; Activity log across the workspace; GET /api/v1/workspaces/:id/activity/export; Company sign-in and directory (Okta or Entra); Data stays in a chosen region; Company's own model key

**L · Agency reports on autopilot**

- L1 The monthly run, untouched (for agency reporting lead): Monthly report run; Store and ads data sync; GET /api/v1/runs/:month; Monthly run record; Anomaly check before send; Report send log
- L2 Held back, with the reason (for agency reporting lead): Anomaly check before send; Hold back on a big change or missing days; Store and ads data sync; Shopify; POST /api/v1/reports/:id/release; Monthly run record
- L3 Commentary drafted in your voice (for agency reporting lead): POST /api/v1/reports/:id/commentary; Commentary drafts and edits; Client-facing words use confirmed numbers only; Counting rules per client; Report (per client and month)
- L4 A new client in minutes (for agency reporting lead): POST /api/v1/clients; Shopify; Google Ads; Meta Ads; POST /api/v1/clients/:id/rules/propose; Report template
- L5 Under the agency's own name (for agency owner or reporting lead): PUT /api/v1/branding; Branding (logo, colour, name); Custom web address; Email sender (agency's own domain); Web address and sender check; Client page is read-only with no product controls
- L6 The client asks, the report answers (for client contact): POST /api/v1/public/reports/:token/questions; Client-facing words use confirmed numbers only; Client question log; Each client's data stays separate; GET /api/v1/public/reports/:token
- L7 Time saved, shown (for agency owner or reporting lead): GET /api/v1/summary/time-saved; Monthly run record; Client question log; Hours-before figure per agency

**M · Warehouse teams, to a 10**

- M1 Nothing leaves your warehouse (for Data platform and security lead): Snowflake; Product state stored in the customer's warehouse; Results are shown, not kept; Daily check for rows held outside the warehouse; GET /api/v1/workspaces/:id/data-location; Company-wide model key; Queries run as the viewer, never a shared sign-in
- M2 Definitions written back to your code (for Analytics engineering lead): Metrics project (dbt); Version control (GitHub or GitLab); POST /api/v1/definitions/:id/write-back; Write-back status sync; Confirmed definitions with versions; GET /api/v1/sources/:id/export
- M3 Conflicting numbers caught first (for Director of data): Check for the same name defined by different formulas; Which reports and dashboards use each definition; Find the rows that explain a gap between two numbers; POST /api/v1/conflicts/:id/resolve; Hold scheduled sends while a change or conflict is open; Chat alerts (Slack or Teams)
- M4 Works with the dashboards you have (for Analytics lead or BI manager): Tableau; Power BI; Check connected dashboards against confirmed definitions; GET /api/v1/workspaces/:id/connected-tools; Which reports and dashboards use each definition; GET /api/v1/sources/:id/export
- M5 Before your review, unasked (for Head of FP&A): Prepare a brief before each review; Review schedule: which meeting, when, who attends, which numbers; Accounting ledger (QuickBooks, Xero or NetSuite); Trusted number entered by a person and checked against the definition; GET /api/v1/briefs/:id; Chat alerts (Slack or Teams)
- M6 Pilot results, measured (for Director of data): Pilot baseline and weekly measurements; Measure requests and time to a checked answer each week; GET /api/v1/workspaces/:id/pilot; Request queue counts from the data team's ticket tool; GET /api/v1/workspaces/:id/pilot/export
- M7 The paperwork (for Data platform or security lead): Independent security audit; Company sign-in and directory (Okta or Entra); Activity log across the workspace; GET /api/v1/workspaces/:id/activity/export; Uptime commitment 99.9%; Security and contract documents for download

<!-- generated:end -->
