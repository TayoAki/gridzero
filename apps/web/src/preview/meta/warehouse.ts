import type { Need, ScreenMeta } from "../types.ts";

// Needs shared by several screens are written once here so the name is identical everywhere.

const snowflake = (note: string): Need => ({ kind: "connection", name: "Snowflake", note, exists: "partly" });
const dbtProject = (note: string): Need => ({ kind: "connection", name: "Metrics project (dbt)", note, exists: "no" });
const directory = (note: string): Need => ({ kind: "connection", name: "Company sign-in and directory (Okta or Entra)", note, exists: "no" });
const ownSignIn = (note: string): Need => ({ kind: "data", name: "Each person's own warehouse sign-in", note, exists: "partly" });
const confirmed = (note: string): Need => ({ kind: "data", name: "Confirmed definitions with versions", note, exists: "yes" });
const checkedAnswers = (note: string): Need => ({ kind: "data", name: "Checked answers", note, exists: "yes" });
const queryLog = (note: string): Need => ({ kind: "data", name: "Warehouse query log with cost", note, exists: "no" });
const drillRows = (note: string): Need => ({ kind: "endpoint", name: "POST /api/v1/definitions/:id/rows", note, exists: "no" });
const costCheck = (note: string): Need => ({ kind: "policy", name: "Row and cost check before a query runs", note, exists: "partly" });
const runAsViewer = (note: string): Need => ({ kind: "policy", name: "Queries run as the viewer, never a shared sign-in", note, exists: "partly" });
const masking = (note: string): Need => ({ kind: "policy", name: "Column masking before anything is sent to the AI", note, exists: "no" });
const companyKey = (note: string): Need => ({ kind: "data", name: "Company-wide model key", note, exists: "partly" });

export const meta: ScreenMeta[] = [
  {
    code: "J1",
    title: "Connect and scan a warehouse",
    summary: "Before scanning the ANALYTICS database, the person sees how many tables will be read, what it will cost in the warehouse and how long it will take, and that no rows are copied.",
    for: "Analytics engineering lead",
    needs: [
      snowflake("Read the catalog, column summaries and 90 days of query history from ANALYTICS. Querying Snowflake from connected tables works today; scanning it for definitions does not."),
      ownSignIn("Save a Snowflake user and role per member so the scan sees only what that member may read. Built for Postgres sources; Snowflake sign-in (key pair or OAuth) is not."),
      { kind: "endpoint", name: "GET /api/v1/sources/:id/scan/estimate", note: "Return tables, warehouse cost in dollars and minutes per step for a Snowflake source. Today it returns a row estimate for Postgres only.", exists: "partly" },
      { kind: "endpoint", name: "POST /api/v1/sources/:id/scan", note: "Start the scan for a Snowflake source with the chosen schemas and warehouse. Exists for Postgres and workbook tables.", exists: "partly" },
      { kind: "job", name: "Warehouse scan (catalog, column summaries, query history)", note: "Run the scan in the background, sample large tables, read ACCOUNT_USAGE.QUERY_HISTORY, and stop if the cost passes the limit.", exists: "no" },
      costCheck("Turn the estimate into warehouse dollars and stop the scan above a set amount. Today the limit is 50 million estimated rows from the Postgres planner."),
    ],
  },
  {
    code: "J2",
    title: "Drill to the rows",
    summary: "Clicking a number shows the rows that add up to it, and the person can change the calculation in a copy that stays unconfirmed until someone reviews it.",
    for: "Senior data analyst",
    needs: [
      snowflake("Run the row query in the warehouse and page through the result."),
      drillRows("Return the rows behind a definition's value for a period and filter, paged, with the total they add up to and the count of rows left out."),
      { kind: "endpoint", name: "GET /api/v1/definitions/:id/value", note: "Give the number and the SQL shown beside the rows.", exists: "yes" },
      { kind: "endpoint", name: "POST /api/v1/definitions/:id/copies", note: "Make a personal, unconfirmed copy of a definition that can be edited and later sent for review. Today a correction changes the shared definition after a preview; there is no personal copy.", exists: "no" },
      confirmed("Show the version, who confirmed it and when, and compare the copy's number with it."),
      runAsViewer("The rows come back under the asker's own user, and a colleague who reruns a shared drill gets only their own rows."),
    ],
  },
  {
    code: "J3",
    title: "What moved since last time",
    summary: "A report is compared with the last review, the change is split into ranked drivers, and the totals are shown matching Finance's ledger figures.",
    for: "Head of FP&A",
    needs: [
      { kind: "data", name: "Review snapshots (numbers saved at each review)", note: "Keep each report's numbers, definition versions and period at the time of a review so a later one can be compared with it.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/reports/:id/compare", note: "Return then and now for each number, the ranked drivers and what could not be explained, against a chosen earlier review.", exists: "no" },
      { kind: "job", name: "Driver ranking for a change", note: "Split a change in a ratio such as margin into the parts due to each dimension or cost line, so the parts add up to the whole.", exists: "no" },
      checkedAnswers("Hold the ledger totals Finance typed in and show whether each still matches."),
      drillRows("Open the freight rows behind a driver."),
      snowflake("Rerun both periods in the warehouse."),
    ],
  },
  {
    code: "J4",
    title: "A queue over its limit",
    summary: "An operations board says which queue is over its limit, since when, what started it and who owns it, with one button to assign it.",
    for: "Director of operations",
    needs: [
      { kind: "job", name: "Threshold check on a schedule", note: "Count each queue every 15 minutes, compare with its limit, and record when it went over and came back.", exists: "no" },
      { kind: "data", name: "Alert limits, owners and history", note: "Store the limit, the owning team, who is assigned and the timeline of each alert, including related events such as a late file.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/alerts", note: "List queues with their count, limit, state and timeline.", exists: "no" },
      { kind: "endpoint", name: "POST /api/v1/alerts/:id/assign", note: "Assign an alert to a person and tell them.", exists: "no" },
      { kind: "connection", name: "Chat alerts (Slack or Teams)", note: "Send the alert to the team's channel and the assignment to the person.", exists: "no" },
      snowflake("Run the count against the queue table under a sign-in that is allowed to run on a schedule."),
    ],
  },
  {
    code: "J5",
    title: "Trace a number to its source",
    summary: "The path from a report widget to the confirmed definition to the warehouse models and source tables, with who confirmed each step.",
    for: "Analytics engineering lead",
    needs: [
      { kind: "endpoint", name: "GET /api/v1/definitions/:id/trace", note: "Return the chain widget, definition, model, source table, with column-level mapping and freshness for each step.", exists: "no" },
      { kind: "data", name: "Lineage (widget to definition to model to source table)", note: "Store which widgets read which definition and which tables and columns a definition reads. Widgets still read the older metric models, so the widget link is missing today.", exists: "no" },
      dbtProject("Read the project's manifest for model-to-model and model-to-source links, test results and last run time."),
      snowflake("Read table freshness and, where the project gives no lineage, the warehouse's own object dependencies."),
      { kind: "endpoint", name: "GET /api/v1/definitions/:id/history", note: "List versions with who confirmed each and when.", exists: "yes" },
      { kind: "endpoint", name: "POST /api/v1/metrics/:id/query", note: "Show the SQL for the number.", exists: "yes" },
    ],
  },
  {
    code: "J6",
    title: "See as another person",
    summary: "An admin runs the same report as two named people and as someone with no warehouse access, side by side, to confirm each sees only what their own access allows.",
    for: "Data platform and security lead",
    needs: [
      { kind: "endpoint", name: "POST /api/v1/reports/:id/access-check", note: "Run a report's queries once per chosen person and return each result, or 'hidden' where the person has no access or no saved sign-in.", exists: "no" },
      ownSignIn("Use each chosen person's saved Snowflake sign-in for their column of the check. An admin running a query under another person's sign-in is new and needs that person's or the company's consent settled."),
      runAsViewer("Shared reports must rerun under the viewer and show nothing when the viewer has no access. True for definitions today; shared workbooks can still show saved values."),
      { kind: "data", name: "Access check record", note: "Keep who checked, as whom and when, without keeping the numbers.", exists: "no" },
      snowflake("Row access policies in the warehouse decide what each person gets back."),
      directory("Pick people and groups to check by their company identity."),
    ],
  },
  {
    code: "J7",
    title: "Query log and spend",
    summary: "Every query with who ran it and what it cost in the warehouse and in AI, with limits an admin sets and an export.",
    for: "Data platform and security lead",
    needs: [
      queryLog("Record every query Grid Zero runs: who, what, rows read, time, the warehouse's query id, and whether it was stopped."),
      { kind: "job", name: "Warehouse cost collection", note: "Read Snowflake's usage views and attach a dollar cost to each logged query by its query id.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/queries", note: "List and filter the log, total it by person, and export it.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/usage", note: "AI spend per person for the month. Spend on naming and corrections is not yet included.", exists: "partly" },
      { kind: "policy", name: "Spend limits per person", note: "A daily warehouse limit per person next to the monthly AI cap. The monthly AI cap exists; the warehouse limit and an admin page to set both do not.", exists: "partly" },
      costCheck("Ask before a query that would scan over 1B rows. Today the check is 50 million estimated rows on Postgres."),
    ],
  },
  {
    code: "J8",
    title: "Use of shared numbers",
    summary: "Whether business teams are answering their own questions: share answered without a request, time to a trusted answer and repeat requests, by team.",
    for: "Director of data",
    needs: [
      { kind: "job", name: "Adoption rollup", note: "Each night, count questions per team, how many ended on confirmed definitions without the data team, the time taken, and repeats.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/adoption", note: "Return the three headline figures, the by-team table and the most-asked questions still going to the data team.", exists: "no" },
      { kind: "data", name: "Question outcomes (asked, answered, accepted, sent to the data team)", note: "Record for each question who asked, their team, whether the answer used only confirmed definitions, whether it was accepted, and whether it became a request. Agent runs and review questions are stored, but not these outcomes.", exists: "partly" },
      queryLog("Count activity per person and team."),
      checkedAnswers("Tell a trusted answer from an unconfirmed one."),
      directory("Know which team each person is in."),
    ],
  },
  {
    code: "J9",
    title: "Company sign-in",
    summary: "People sign in with the company account, and directory groups map to roles so nobody is added by hand.",
    for: "Data platform and security lead",
    needs: [
      directory("Single sign-on (SAML or OIDC) and group membership."),
      { kind: "endpoint", name: "PUT /api/v1/workspaces/:id/sso", note: "Save the sign-in connection, test it, and turn on 'require single sign-on'.", exists: "no" },
      { kind: "endpoint", name: "PUT /api/v1/workspaces/:id/group-roles", note: "Save which directory group gets which role.", exists: "no" },
      { kind: "job", name: "Directory sync (people and groups)", note: "Add, change and remove members as the directory changes (SCIM or polling), sign leavers out and pause their schedules.", exists: "no" },
      { kind: "policy", name: "Group to role mapping", note: "The higher role wins when someone is in two groups; nobody outside a mapped group can sign in.", exists: "no" },
      { kind: "data", name: "Workspace members and roles", note: "Members and roles exist, added by hand; they need a marker for 'managed by the directory'.", exists: "partly" },
    ],
  },
  {
    code: "J10",
    title: "What the AI can see",
    summary: "A plain statement of what is and is not sent to the model, the columns an admin has masked, and the option to use the company's own model key.",
    for: "Data platform and security lead",
    needs: [
      masking("Replace the values of masked columns, matched by name across all tables, in summaries and results before they are sent."),
      { kind: "endpoint", name: "PUT /api/v1/workspaces/:id/masked-columns", note: "Add and remove masked columns, list where each appears, and return suggestions for columns that look personal.", exists: "no" },
      { kind: "policy", name: "Row cap on results sent to the AI", note: "Never send more than 500 rows of a result; tell the model how many there were. A cap may exist in the agent tools but is not a setting an admin can see.", exists: "partly" },
      { kind: "data", name: "Record of what was sent to the AI", note: "Keep, per question, which columns and how many rows were sent, so an admin can show it for one question.", exists: "no" },
      companyKey("One key set by an admin for everyone. Today each member saves their own key."),
    ],
  },
  {
    code: "M1",
    title: "Nothing leaves your warehouse",
    summary: "Shows that queries run in the warehouse as each person, results are shown and not kept, the company's own model key is used, and a daily check found no rows held outside.",
    for: "Data platform and security lead",
    needs: [
      snowflake("Run the whole product inside the customer's Snowflake account (a native app with container services), not only query it from outside."),
      { kind: "data", name: "Product state stored in the customer's warehouse", note: "Keep definitions, versions, the query log and settings in a schema in the customer's own database in place of Grid Zero's database.", exists: "no" },
      { kind: "policy", name: "Results are shown, not kept", note: "Query results pass through to the browser and are never written to disk or cache outside the warehouse; saved reports keep the query, not the rows. Today connected tables and workbooks store result rows.", exists: "no" },
      { kind: "job", name: "Daily check for rows held outside the warehouse", note: "Each day and after each update, prove no result rows are stored and list outbound connections, and keep the result as evidence.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/workspaces/:id/data-location", note: "Return the latest check, its history and a downloadable evidence file.", exists: "no" },
      companyKey("Calls to the model go out from the customer's account under the customer's key."),
      runAsViewer("Every query runs under the asker's own user; no service account."),
    ],
  },
  {
    code: "M2",
    title: "Definitions written back to your code",
    summary: "A confirmed definition becomes a change request in the metrics project the data team already maintains, so the project and Grid Zero agree.",
    for: "Analytics engineering lead",
    needs: [
      dbtProject("Read the project's metric files, find the metric that matches a definition, and produce the edited file."),
      { kind: "connection", name: "Version control (GitHub or GitLab)", note: "Create a branch, commit the change and open a change request; read its review and merge state.", exists: "no" },
      { kind: "endpoint", name: "POST /api/v1/definitions/:id/write-back", note: "Build the file change for a confirmed definition, check the project still builds, and open the change request.", exists: "no" },
      { kind: "job", name: "Write-back status sync", note: "Watch each open change request until it merges or closes, and raise a question when the project's version differs from the confirmed one.", exists: "no" },
      confirmed("Supply the rule, version and who confirmed it for the change request."),
      { kind: "endpoint", name: "GET /api/v1/sources/:id/export", note: "The Ossie export of confirmed definitions is the starting point for converting a definition into the project's format.", exists: "yes" },
    ],
  },
];
