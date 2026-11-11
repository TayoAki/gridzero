import type { Need, ScreenMeta } from "../types.ts";

// Needs shared by more than one screen are built here so the name stays identical everywhere.

const snowflake = (note: string): Need => ({ kind: "connection", name: "Snowflake", note, exists: "partly" });
const ledger = (note: string): Need => ({ kind: "connection", name: "Accounting ledger (QuickBooks, Xero or NetSuite)", note, exists: "no" });
const directory = (note: string): Need => ({ kind: "connection", name: "Company sign-in and directory (Okta or Entra)", note, exists: "no" });
const chat = (note: string): Need => ({ kind: "connection", name: "Chat alerts (Slack or Teams)", note, exists: "no" });
const tableau = (note: string): Need => ({ kind: "connection", name: "Tableau", note, exists: "no" });
const powerBi = (note: string): Need => ({ kind: "connection", name: "Power BI", note, exists: "no" });

const reportUse = (note: string): Need => ({ kind: "data", name: "Which reports and dashboards use each definition", note, exists: "partly" });
const holdSends = (note: string): Need => ({ kind: "job", name: "Hold scheduled sends while a change or conflict is open", note, exists: "no" });
const explainGap = (note: string): Need => ({ kind: "job", name: "Find the rows that explain a gap between two numbers", note, exists: "no" });
const trustedNumber = (note: string): Need => ({ kind: "data", name: "Trusted number entered by a person and checked against the definition", note, exists: "partly" });
const pilotData = (note: string): Need => ({ kind: "data", name: "Pilot baseline and weekly measurements", note, exists: "no" });
const pilotJob = (note: string): Need => ({ kind: "job", name: "Measure requests and time to a checked answer each week", note, exists: "no" });
const pilotEndpoint = (note: string): Need => ({ kind: "endpoint", name: "GET /api/v1/workspaces/:id/pilot", note, exists: "no" });
const requestQueue = (note: string): Need => ({ kind: "data", name: "Request queue counts from the data team's ticket tool", note, exists: "no" });
const audit = (note: string): Need => ({ kind: "policy", name: "Independent security audit", note, exists: "no" });
const activityLog = (note: string): Need => ({ kind: "data", name: "Activity log across the workspace", note, exists: "partly" });
const activityExport = (note: string): Need => ({ kind: "endpoint", name: "GET /api/v1/workspaces/:id/activity/export", note, exists: "no" });

export const meta: ScreenMeta[] = [
  {
    code: "K4",
    title: "Bring in definitions you already have",
    summary: "Reads the metrics from the team's own metrics project, compares each with the warehouse and with the dashboards, and brings in the ones that match with their owner kept.",
    for: "Analytics engineering lead",
    needs: [
      { kind: "connection", name: "Metrics project (dbt)", note: "Read the metric and model files, with each metric's formula, filters, owner and description.", exists: "no" },
      { kind: "connection", name: "Version control (GitHub or GitLab)", note: "Read the project from its repository at a chosen branch, and notice when the branch moves so the import can be offered again.", exists: "no" },
      snowflake("Run each imported formula read-only against the ANALYTICS schema to see whether it gives the number the warehouse gives."),
      { kind: "endpoint", name: "POST /api/v1/sources/:id/import", note: "Take a metrics project, return the metrics found, which match and which differ, and create definitions for the ones the person brings in. Today only the product's own YAML export can be read back.", exists: "partly" },
      { kind: "job", name: "Compare imported metrics with the warehouse and with dashboard formulas", note: "For each metric, compute the number both ways and record the difference in value and in rows.", exists: "no" },
      { kind: "data", name: "Definitions with status, versions and owner", note: "Imported metrics arrive as drafts owned by the person named in the project, ready to confirm.", exists: "yes" },
    ],
  },
  {
    code: "K5",
    title: "Pilot scorecard",
    summary: "Shows one team's requests, time to a checked answer and number of people asking, before the pilot and now, counted from the first day.",
    for: "Director of data",
    needs: [
      pilotData("Store the starting week's figures and one row per week after it: requests, time to a checked answer, people asking."),
      pilotJob("Each week, count questions asked, how long each took to reach a checked answer, and how many distinct people asked."),
      pilotEndpoint("Return the pilot's team, start date, baseline and weekly figures for the scorecard."),
      requestQueue("The 'before' side: how many requests reached the data team each week and how long they took. Entered by hand or read from the ticket tool."),
      { kind: "data", name: "AI usage per person", note: "Who asked and how often, to count people asking and show which requests no longer reach the team.", exists: "yes" },
    ],
  },
  {
    code: "K6",
    title: "One change, every report",
    summary: "Shows a change to one definition with the number before and after, every report it touches and who owns each, and publishes it to all of them at once.",
    for: "Analytics lead or BI manager",
    needs: [
      snowflake("Compute the number before and after the change for each affected report."),
      { kind: "endpoint", name: "POST /api/v1/definitions/:id/correct", note: "Propose the change and return old and new numbers and what it affects.", exists: "yes" },
      { kind: "endpoint", name: "POST /api/v1/changes/:id/publish", note: "Publish the change. Today this updates the definition and its metrics; it must also update every report that reads it, in one step.", exists: "partly" },
      reportUse("List the 17 reports, their owners, viewers and next scheduled send. Today the preview lists the metrics that change, not the reports."),
      holdSends("Stop the scheduled sends of affected reports until the change is published or discarded."),
      chat("Tell the nine report owners what is changing, by how much, and when."),
    ],
  },
  {
    code: "K7",
    title: "Your query beside the AI's",
    summary: "Lets an analyst write SQL next to the AI's draft, run both as themselves, and see the two totals and the rows that explain the difference.",
    for: "Senior data analyst",
    needs: [
      snowflake("Run both queries read-only under the analyst's own sign-in."),
      { kind: "data", name: "Read-only SQL run by agents with the SQL shown", note: "The AI's draft query and its result, shown in full.", exists: "yes" },
      { kind: "endpoint", name: "POST /api/v1/sources/:id/queries/compare", note: "Run a person's query and the AI's draft, return both totals and the rows present in one result and not the other.", exists: "no" },
      { kind: "data", name: "Queries written by a person, saved with the answer", note: "Keep the analyst's SQL, who ran it and when, so an answer can be shared with the query attached.", exists: "no" },
      explainGap("Group the rows that differ by cause (here, 41 late refunds) so the difference reads as a sentence."),
    ],
  },
  {
    code: "K8",
    title: "Tie to Finance's number",
    summary: "Compares the definition's total for a closed period with the figure Finance trusts, and when they differ shows the rows that explain the gap.",
    for: "Head of FP&A",
    needs: [
      ledger("Read the closed period's revenue total and whether the period is closed, so the figure need not be typed."),
      trustedNumber("The figure Finance trusts for the period. Today a person can type it once during review; it is not kept per period."),
      { kind: "endpoint", name: "POST /api/v1/definitions/:id/reconcile", note: "Compare the definition's total for a period with the trusted figure, return match or gap, and record who confirmed it.", exists: "no" },
      explainGap("When the totals differ, list the rows behind the gap (last time, three late credit notes)."),
      { kind: "data", name: "Reconciliation history per period", note: "One row per period: both totals, the gap, the cause, who confirmed.", exists: "no" },
    ],
  },
  {
    code: "K11",
    title: "Security and trust",
    summary: "Puts everything a security approver asks for on one page, each control with its current state, and offers a mode where the company's own model key is used.",
    for: "Data platform or security lead",
    needs: [
      audit("An audit by an outside firm, with a report that can be sent on request under a confidentiality agreement."),
      activityLog("Who signed in, ran a query, changed a definition or shared an answer. Today changes are kept per definition and per workbook, not in one log."),
      activityExport("Download the log for a date range, or send it on to the company's own log store."),
      directory("People are added, removed and given roles by the company's directory; sign-in goes through it."),
      { kind: "policy", name: "Data stays in a chosen region", note: "The company picks where its data is stored and processed, and the page shows the choice.", exists: "no" },
      { kind: "data", name: "Company's own model key", note: "One key set for the whole workspace by an admin, used for every AI call. Today each member can save a key of their own.", exists: "partly" },
    ],
  },
  {
    code: "M3",
    title: "Conflicting numbers caught first",
    summary: "When two reports show different numbers under the same name, it shows both formulas, the rows that explain the gap and who would see each, before either is sent.",
    for: "Director of data",
    needs: [
      { kind: "job", name: "Check for the same name defined by different formulas", note: "Run across reports as well as definitions, and before each scheduled send. Today the check runs across definitions in a source.", exists: "partly" },
      reportUse("Which formula each report uses, who views it and when it is next sent."),
      explainGap("List the 904 pending orders worth 212,400 that one report counts and the other does not."),
      { kind: "endpoint", name: "POST /api/v1/conflicts/:id/resolve", note: "Point both reports at the confirmed definition, or record why they are meant to differ.", exists: "no" },
      holdSends("Keep Thursday's board pack from going out while the conflict is open."),
      chat("Tell the director and both report owners as soon as the conflict is found."),
    ],
  },
  {
    code: "M4",
    title: "Works with the dashboards you have",
    summary: "Lists the dashboards in the company's existing tools that read confirmed definitions, and points out the ones still using a formula of their own.",
    for: "Analytics lead or BI manager",
    needs: [
      tableau("Read each dashboard's data sources and calculated fields, and publish confirmed definitions as a data source it can read."),
      powerBi("Read each report's model and measures, and publish confirmed definitions as a model it can read."),
      { kind: "job", name: "Check connected dashboards against confirmed definitions", note: "Each morning, compare every dashboard's formula with the confirmed one and mark it in step or out of step.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/workspaces/:id/connected-tools", note: "Return each tool, its dashboards, which definition and version each reads, and when it was last checked.", exists: "no" },
      reportUse("Extended to dashboards outside the product: Net revenue v3 is used in 17 of them."),
      { kind: "endpoint", name: "GET /api/v1/sources/:id/export", note: "The confirmed definitions as YAML, which is what the tools are given to read.", exists: "yes" },
    ],
  },
  {
    code: "M5",
    title: "Before your review, unasked",
    summary: "Ahead of a regular review, shows what moved since the last one and why, with totals tied to Finance's own figures.",
    for: "Head of FP&A",
    needs: [
      { kind: "job", name: "Prepare a brief before each review", note: "The evening before, compare each confirmed number with its value at the last review, pick the ones that moved most and find the rows behind each move.", exists: "no" },
      { kind: "data", name: "Review schedule: which meeting, when, who attends, which numbers", note: "So the brief is prepared for the right people at the right time. Entered by hand at first.", exists: "no" },
      ledger("Check the brief's totals against the ledger before it is shown."),
      trustedNumber("The 'ties to Finance' line: the brief's totals match the figure Finance trusts for the period."),
      { kind: "endpoint", name: "GET /api/v1/briefs/:id", note: "Return the brief: what moved, the cause, the rows behind it and the suggested next steps.", exists: "no" },
      chat("Tell each attendee the brief is ready."),
    ],
  },
  {
    code: "M6",
    title: "Pilot results, measured",
    summary: "Shows one team's results over a quarter, before and after, with where each figure was measured from.",
    for: "Director of data",
    needs: [
      pilotData("The same weekly rows as the scorecard, kept for the full 90 days."),
      pilotJob("Also counts repeat requests (the same question asked again) and reports of conflicting numbers."),
      pilotEndpoint("Return the 90-day totals and the weekly series."),
      requestQueue("The team's own count of requests, so the result does not rest on the product's log alone."),
      { kind: "endpoint", name: "GET /api/v1/workspaces/:id/pilot/export", note: "Download the results and the method as a document the director can pass on.", exists: "no" },
    ],
  },
  {
    code: "M7",
    title: "The paperwork",
    summary: "Lists what procurement and security sign against, each item with its document, and who answers questions.",
    for: "Data platform or security lead",
    needs: [
      audit("The report itself, attached for download once a confidentiality agreement is in place."),
      directory("Listed as in place: sign-in through the company's provider and people managed from its directory."),
      activityLog("Listed as in place and exportable."),
      activityExport("The export the page links to."),
      { kind: "policy", name: "Uptime commitment 99.9%", note: "A written commitment, a public record of past uptime, and what the customer is owed when it is missed.", exists: "no" },
      { kind: "data", name: "Security and contract documents for download", note: "Audit report, data processing agreement, list of subprocessors, completed security questionnaire.", exists: "no" },
    ],
  },
];
