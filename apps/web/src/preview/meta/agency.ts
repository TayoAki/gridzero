// What the agency screens (many clients, sending reports, the hands-off monthly run) need from the backend.
// The same need keeps the same name on every screen so it is counted once.

import type { Need, ScreenMeta } from "../types.ts";

const who = "agency reporting lead";

type Exists = Need["exists"];

/** One need, defined once: [kind, name, whether it exists today]. Each screen adds its own note. */
const catalogue = {
  // Outside connections
  shopify: ["connection", "Shopify", "no"],
  googleAds: ["connection", "Google Ads", "no"],
  metaAds: ["connection", "Meta Ads", "no"],
  emailSender: ["connection", "Email sender (agency's own domain)", "no"],
  webAddress: ["connection", "Custom web address", "no"],

  // Stored data
  clients: ["data", "Client table", "partly"],
  contacts: ["data", "Client contacts", "no"],
  reports: ["data", "Report (per client and month)", "partly"],
  template: ["data", "Report template", "no"],
  rules: ["data", "Counting rules per client", "partly"],
  sendLog: ["data", "Report send log", "no"],
  runRecord: ["data", "Monthly run record", "no"],
  branding: ["data", "Branding (logo, colour, name)", "no"],
  commentary: ["data", "Commentary drafts and edits", "no"],
  questions: ["data", "Client question log", "no"],
  baseline: ["data", "Hours-before figure per agency", "no"],

  // Endpoints
  listClients: ["endpoint", "GET /api/v1/clients", "no"],
  createClient: ["endpoint", "POST /api/v1/clients", "no"],
  copyReport: ["endpoint", "POST /api/v1/reports/:id/copy", "partly"],
  precheck: ["endpoint", "GET /api/v1/reports/:id/precheck", "partly"],
  send: ["endpoint", "POST /api/v1/reports/:id/send", "no"],
  publicReport: ["endpoint", "GET /api/v1/public/reports/:token", "no"],
  schedule: ["endpoint", "PUT /api/v1/reports/:id/schedule", "partly"],
  getRun: ["endpoint", "GET /api/v1/runs/:month", "no"],
  release: ["endpoint", "POST /api/v1/reports/:id/release", "no"],
  draftCommentary: ["endpoint", "POST /api/v1/reports/:id/commentary", "no"],
  proposeRules: ["endpoint", "POST /api/v1/clients/:id/rules/propose", "no"],
  putBranding: ["endpoint", "PUT /api/v1/branding", "no"],
  ask: ["endpoint", "POST /api/v1/public/reports/:token/questions", "no"],
  timeSaved: ["endpoint", "GET /api/v1/summary/time-saved", "no"],

  // Background jobs
  monthlyRun: ["job", "Monthly report run", "partly"],
  anomaly: ["job", "Anomaly check before send", "no"],
  sync: ["job", "Store and ads data sync", "no"],
  pdf: ["job", "PDF maker", "no"],
  domainCheck: ["job", "Web address and sender check", "no"],

  // Rules
  confirmedOnly: ["policy", "Send only when every number is confirmed", "no"],
  holdBack: ["policy", "Hold back on a big change or missing days", "no"],
  separate: ["policy", "Each client's data stays separate", "partly"],
  readOnly: ["policy", "Client page is read-only with no product controls", "no"],
  confirmedAnswers: ["policy", "Client-facing words use confirmed numbers only", "partly"],
} as const satisfies Record<string, readonly [Need["kind"], string, Exists]>;

function need(key: keyof typeof catalogue, note: string): Need {
  const [kind, name, exists] = catalogue[key];
  return { kind, name, note, exists };
}

export const meta: ScreenMeta[] = [
  {
    code: "G1",
    title: "Switch client",
    summary: "A list of the agency's clients with each one's report state, and a switcher that changes everything on screen to the chosen client.",
    for: who,
    needs: [
      need("clients", "One row per client with a name, who looks after it and which workspace holds its files. Workspaces exist; a client as a named thing on top of one does not."),
      need("listClients", "Return every client the person can see with the state of this month's report, how many numbers are unconfirmed and the date the data runs to."),
      need("createClient", "Start a new client from the list."),
      need("reports", "Know which dashboard is a client's report for a given month and whether it is a draft, due, held or sent. Dashboards exist; the month and the state do not."),
      need("separate", "Workbooks, reports, counting rules and the analyst only ever show the chosen client's things. Workspace membership covers part of this."),
    ],
  },
  {
    code: "G2",
    title: "Reuse a report",
    summary: "Copy a finished report onto another client or the next month, see what comes along and what has to be answered first.",
    for: who,
    needs: [
      need("copyReport", "Copy a report's layout and counting rules to another client or month and work the numbers out from that client's data. Copying a workbook exists; copying across clients with rules does not."),
      need("template", "Hold a report's widgets and the rules they use apart from any one client's data, so it can be laid over another client."),
      need("rules", "Copy the rules as unconfirmed for the new client and mark the ones that cannot be worked out, such as a missing refunds column. Rules with a confirmed state exist per workspace."),
      need("precheck", "Before copying, say which widgets are ready, which need an answer and which have no matching column."),
      need("separate", "Only the layout and rules move between clients, never rows of data."),
    ],
  },
  {
    code: "G3",
    title: "Send the report",
    summary: "Send a finished report to the client as a link, a PDF or an email, after a short list of checks.",
    for: who,
    needs: [
      need("send", "Send one report to chosen people as a link, a PDF or an email with a subject and a note."),
      need("precheck", "List the checks before sending: all numbers confirmed, data covers the month, nothing out of line, logo and sender in place. A check before sharing a workbook exists."),
      need("pdf", "Turn the report page into a PDF with the client's logo on each page."),
      need("emailSender", "Deliver the email from the agency's address. Today mail goes out only for invites, from our own address."),
      need("contacts", "Names, email addresses and roles of the people at each client who receive reports."),
      need("sendLog", "Keep who was sent what, when, and whether they opened it."),
    ],
  },
  {
    code: "G4",
    title: "What the client sees",
    summary: "The clean, read-only page a client opens from the link, with their logo and a line saying who confirmed the numbers.",
    for: "client contact (previewed by the agency reporting lead)",
    needs: [
      need("publicReport", "Serve one report by a private link with no sign-in, as it stood when it was sent."),
      need("readOnly", "No editing, menus or sign-in to the product, and nothing outside this one report."),
      need("confirmedAnswers", "Leave out any number that is not confirmed and show who confirmed the rest and when."),
      need("branding", "The client's logo at the top and the agency's name in the footer."),
      need("sendLog", "Record that the page was opened so the agency can see it."),
    ],
  },
  {
    code: "G5",
    title: "Send it every month",
    summary: "A monthly schedule that rebuilds and sends the report by itself, but only when every number is confirmed.",
    for: who,
    needs: [
      need("schedule", "Save the day, time, people and format for a report's monthly send, and pause it. Schedules exist for agent tasks and widget refresh, not for sending."),
      need("monthlyRun", "On the day, rebuild the report for the month before and send it. The timer exists; rebuilding and sending do not."),
      need("confirmedOnly", "Do not send if any number in the report is unconfirmed; tell the agency instead."),
      need("holdBack", "Also hold the send when data does not cover the whole month or a number has moved by more than 40%."),
      need("contacts", "Who at the client receives the scheduled send."),
      need("sendLog", "Show the last send, the next send and past sends, including any that were held."),
    ],
  },
  {
    code: "L1",
    title: "The monthly run, untouched",
    summary: "One summary of the month's run across all clients: which reports were sent, which were held and why.",
    for: who,
    needs: [
      need("monthlyRun", "Run every client's report on its schedule: bring data in, rebuild, check, send or hold."),
      need("sync", "Bring in each client's store and ad data before the reports rebuild, and notice when a source stops."),
      need("getRun", "Return one month's run across all clients: each report's outcome, time, data date and the steps the run took."),
      need("runRecord", "Keep each run's steps and each report's outcome so the summary can be shown later."),
      need("anomaly", "Check each rebuilt report before it sends and hold the ones that look wrong."),
      need("sendLog", "Count how many sent reports were opened."),
    ],
  },
  {
    code: "L2",
    title: "Held back, with the reason",
    summary: "A report that looked wrong was not sent; the screen says why, what caused it and offers the fix.",
    for: who,
    needs: [
      need("anomaly", "Compare the report with the month before, find the likely cause (here, three missing days) and put it in plain words."),
      need("holdBack", "The thresholds: a change larger than 40%, or data that ends before the month does."),
      need("sync", "Sync the client's store again on request and report when the missing days have arrived."),
      need("shopify", "The store connection whose sign-in ran out; needs to be reconnected and to say when it last brought data in."),
      need("release", "Let the agency send a held report after a fix, or as it is with a line saying where the data ends."),
      need("runRecord", "Keep what was held, why, who was told and what was done about it."),
    ],
  },
  {
    code: "L3",
    title: "Commentary drafted in your voice",
    summary: "A written summary of the month drafted from confirmed numbers, with where each figure comes from and ways to change the draft.",
    for: who,
    needs: [
      need("draftCommentary", "Draft or redraft the month's summary for a report, with options such as shorter or more on ads, and return each figure used with its rule."),
      need("commentary", "Keep each draft and every edit the person makes, so later drafts follow their way of writing."),
      need("confirmedAnswers", "The draft may only use figures from confirmed rules and must not name a cause the data does not show. Checked answers cover part of this."),
      need("rules", "Tell the draft which rule each figure comes from and whether it is confirmed."),
      need("reports", "Attach the finished commentary to the client's report for that month."),
    ],
  },
  {
    code: "L4",
    title: "A new client in minutes",
    summary: "Setting up a new client: connect accounts, pick a report, accept the counting rules proposed from a similar client and answer only the differences.",
    for: who,
    needs: [
      need("createClient", "Create the client and carry it through the three set-up steps."),
      need("shopify", "Connect the client's store and bring in past orders."),
      need("googleAds", "Connect the client's ad account for spend and results."),
      need("metaAds", "Connect the client's ad account for spend and results."),
      need("proposeRules", "Compare the new client's data with a similar client's rules, say which match, and for each difference give the choices with the number each leads to."),
      need("template", "Lay the chosen report over the new client's data."),
    ],
  },
  {
    code: "L5",
    title: "Under the agency's own name",
    summary: "The agency's logo, web address and email sender on everything the client receives, with the settings and checks behind them.",
    for: "agency owner or reporting lead",
    needs: [
      need("putBranding", "Save the agency's name, logo, colour, web address and sending address, and each client's own logo."),
      need("branding", "Hold the agency's and each client's logo and colours for the page, the PDF and the email."),
      need("webAddress", "Serve client pages from the agency's own address, such as reports.brightside.co, with a secure connection."),
      need("emailSender", "Send report emails from the agency's own address, approved by their domain so they do not land in junk."),
      need("domainCheck", "Check regularly that the web address still points to us and the sending address is still approved, and say so on the screen."),
      need("readOnly", "Our own name does not appear on the page, the PDF or the email."),
    ],
  },
  {
    code: "L6",
    title: "The client asks, the report answers",
    summary: "A client types a follow-up question on the report page and gets an answer from confirmed numbers; the agency can see what was asked.",
    for: "client contact",
    needs: [
      need("ask", "Take a question from the report page and answer it from that report's data, or say it has been passed to the agency."),
      need("confirmedAnswers", "Answer only from confirmed numbers, show the figures used, and refuse guesses, forecasts and advice. Checked answers and agent chat cover part of this."),
      need("questions", "Keep each question, who asked, the answer given and whether it was passed on, for the agency to read."),
      need("separate", "A client can only ask about their own report."),
      need("publicReport", "The page the question box sits on."),
    ],
  },
  {
    code: "L7",
    title: "Time saved, shown",
    summary: "A home-page summary of what the monthly run did: reports sent, hours of hands-on work against before, problems caught and client questions answered.",
    for: "agency owner or reporting lead",
    needs: [
      need("timeSaved", "Return, per month, reports sent, reports held and fixed, hands-on hours, client questions answered and passed on."),
      need("runRecord", "The source for reports sent, held and fixed, and for time spent on held reports."),
      need("questions", "The source for questions answered on the page and passed to the agency."),
      need("baseline", "The hours the agency said reporting took before, so there is something to compare against. Shown as an example until it is entered."),
    ],
  },
];
