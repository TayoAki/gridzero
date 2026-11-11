import type { Need, ScreenMeta } from "../types.ts";

// Needs shared by several screens are written once so the name stays the same everywhere.

const conn = (name: string, note: string, exists: Need["exists"] = "no"): Need => ({ kind: "connection", name, note, exists });

const startConnect = (note: string): Need => ({ kind: "endpoint", name: "POST /api/v1/workspaces/:id/sync-connections", note, exists: "no" });
const listConnections = (note: string): Need => ({ kind: "endpoint", name: "GET /api/v1/workspaces/:id/sync-connections", note, exists: "no" });
const scheduledSync = (note: string): Need => ({ kind: "job", name: "Scheduled sync", note, exists: "no" });
const syncHealth = (note: string): Need => ({ kind: "job", name: "Sync health check", note, exists: "no" });
const syncedTables = (note: string): Need => ({ kind: "data", name: "Synced tables", note, exists: "partly" });
const syncHistory = (note: string): Need => ({ kind: "data", name: "Sync history", note, exists: "no" });
const readOnly = (note: string): Need => ({ kind: "policy", name: "Read-only access to connected accounts", note, exists: "no" });
const profile = (note: string): Need => ({ kind: "data", name: "Workspace profile", note, exists: "no" });
const singleBusiness = (note: string): Need => ({ kind: "policy", name: "Single-business layout", note, exists: "no" });

export const meta: ScreenMeta[] = [
  {
    code: "H1",
    title: "Connect a store",
    summary: "Pick Shopify, Meta Ads or Google Ads for a client, sign in once, and see exactly what will be read before anything is fetched.",
    for: "Agency reporting lead",
    needs: [
      conn("Shopify", "Sign in to the client's store and read orders, refunds, products and customers."),
      conn("Meta Ads", "Sign in to the client's ad account and read spend, clicks and purchases by campaign and day."),
      conn("Google Ads", "Sign in to the client's ad account and read spend, clicks and conversions by campaign and day."),
      startConnect("Start a sign-in for one client and one service, then store the granted access against that client's workspace."),
      listConnections("Show which services are already connected for this client, so a connected one is not offered again."),
      readOnly("Ask each service for read permission only, and show the list of what is read on the screen before sign-in."),
    ],
  },
  {
    code: "H2",
    title: "Synced and fresh",
    summary: "Orders arrive on their own every morning; the table and the bottom bar say how old the data is and what came in since yesterday.",
    for: "Agency reporting lead",
    needs: [
      conn("Shopify", "Fetch new and changed orders since the last sync, including late refunds on older orders."),
      scheduledSync("Fetch each connection on its timetable (daily at 06:00 here) and add only what is new or changed."),
      syncedTables("Land fetched orders as a Data Table like an uploaded file, but one that grows on its own and remembers when it was last filled."),
      syncHistory("Each run with its time, rows added, rows changed and result, for the list of recent syncs."),
      { kind: "endpoint", name: "POST /api/v1/sync-connections/:id/sync", note: "Run one connection now when the person presses Sync now.", exists: "no" },
      listConnections("Last sync time, next sync time and row count for each connection in the sidebar and bottom bar."),
    ],
  },
  {
    code: "H3",
    title: "Sync needs attention",
    summary: "Says which connection broke and when, what is still safe to use, which reports are affected, and the one step that fixes it.",
    for: "Agency reporting lead",
    needs: [
      conn("Meta Ads", "Report an expired or withdrawn sign-in clearly, and accept a fresh sign-in without losing the tables already synced."),
      syncHealth("After every failed or missed run, mark the connection as needing attention with a plain reason and the last good day."),
      { kind: "endpoint", name: "POST /api/v1/sync-connections/:id/reconnect", note: "Sign in again for an existing connection and fill the missing days straight afterwards.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/sync-connections/:id/affected", note: "List the reports, widgets and scheduled sends that read from this connection.", exists: "no" },
      syncHistory("The attempts since the last good sync, with the reason each one failed."),
      { kind: "policy", name: "Hold scheduled sends on stale data", note: "A report that reads from a broken connection is not sent to a client until someone decides.", exists: "no" },
    ],
  },
  {
    code: "I1",
    title: "One business, no switcher",
    summary: "With a single business the client switcher is hidden and the screen opens straight on the store's own data and reports.",
    for: "Shopify store operator",
    needs: [
      conn("Shopify", "The store's orders are the first thing shown."),
      conn("Meta Ads", "Ad spend sits next to orders in the same short list."),
      singleBusiness("When an account has one workspace and no clients, hide the switcher and client words everywhere; show them once a second one is added."),
      { kind: "endpoint", name: "GET /api/v1/workspaces", note: "Already returns the person's workspaces; the screen uses the count to decide whether to show the switcher.", exists: "yes" },
      syncedTables("Orders and ad spend as tables that fill themselves."),
      scheduledSync("Keeps the tables fresh each morning so the bottom bar can say Synced 06:00."),
    ],
  },
  {
    code: "I2",
    title: "What describes you",
    summary: "One question at sign-up that picks the starting tiles, the report templates and which connections are offered first.",
    for: "Anyone signing up",
    needs: [
      { kind: "endpoint", name: "PUT /api/v1/me/profile", note: "Save the answer (or the skip) and allow it to be changed later from settings.", exists: "no" },
      profile("The chosen description, stored per person and copied to the first workspace they create."),
      { kind: "data", name: "Starting setups", note: "For each of the five answers: the home tiles, the report templates and the order in which connections are offered.", exists: "no" },
      { kind: "policy", name: "Sign-up question is optional", note: "Skipping gives the general setup; the answer never hides a feature, it only changes what is offered first.", exists: "no" },
    ],
  },
  {
    code: "I3",
    title: "How we count, simple view",
    summary: "A small workspace sees one plain list of how each number is counted, with the open question on top and nothing else until it is needed.",
    for: "Shopify store operator",
    needs: [
      { kind: "endpoint", name: "GET /api/v1/sources/:id/review", note: "Already returns the ways of counting and open questions for a table; the simple view shows the same items in one list.", exists: "yes" },
      { kind: "endpoint", name: "POST /api/v1/questions/:id/answer", note: "Answer the open question (do test orders count) from this screen.", exists: "yes" },
      { kind: "endpoint", name: "POST /api/v1/definitions/:id/dispute", note: "Behind the This is wrong button.", exists: "yes" },
      { kind: "data", name: "Definitions with confirmed status", note: "Label, plain rule, current value and who confirmed it.", exists: "yes" },
      { kind: "policy", name: "Simple view until needed", note: "Hide changes, checked answers and database sign-in until the workspace has at least one of each.", exists: "no" },
      singleBusiness("No client names or switcher on this screen."),
    ],
  },
  {
    code: "I5",
    title: "Social report, client view",
    summary: "The page a client opens: three headline numbers, the top posts shown as posts, and who prepared and confirmed the figures.",
    for: "Social media manager (seen by their client)",
    needs: [
      conn("Instagram", "Followers, reach, engagement and the posts themselves for the month."),
      conn("TikTok", "Followers, views and engagement by post for the month."),
      conn("LinkedIn", "Followers, impressions and engagement by post for the month."),
      { kind: "endpoint", name: "GET /api/v1/shared-reports/:token", note: "Serve a finished report to someone without an account, with no product controls.", exists: "no" },
      { kind: "data", name: "Report branding", note: "The sender's name, the client's colours and logo, and the web address the page is shown under.", exists: "no" },
      { kind: "data", name: "Post previews", note: "Image, caption and date of each post, kept so the page still shows them if the post is later removed.", exists: "no" },
    ],
  },
  {
    code: "K1",
    title: "Your week, no grid",
    summary: "Three numbers for the week, what changed and why, readable on a phone without opening a table.",
    for: "Shopify store operator",
    needs: [
      conn("Shopify", "Sales and refunds for the week, by product."),
      conn("Meta Ads", "Ad spend for the week, to work out the return on it."),
      { kind: "job", name: "Weekly digest", note: "Each Monday after the sync, work out the three numbers, compare with the week before and write the one thing that changed.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/workspaces/:id/week", note: "Return the latest weekly summary for the phone page and the email.", exists: "no" },
      { kind: "data", name: "Definitions with confirmed status", note: "The summary uses only confirmed ways of counting and says so in the bottom bar.", exists: "yes" },
      scheduledSync("The summary is written only after that morning's sync has finished."),
    ],
  },
  {
    code: "K2",
    title: "Social accounts connected",
    summary: "Instagram, TikTok and LinkedIn for one client, with the month's top posts shown as posts and the full list underneath.",
    for: "Social media manager",
    needs: [
      conn("Instagram", "Posts, reels and stories with reach, likes, comments, saves and shares."),
      conn("TikTok", "Videos with views, likes, comments and shares."),
      conn("LinkedIn", "Company page posts with impressions, reactions, comments and clicks."),
      { kind: "endpoint", name: "GET /api/v1/sources/:id/posts", note: "Return posts for a period, sorted by reach, with their picture and caption.", exists: "no" },
      { kind: "data", name: "Post previews", note: "Image, caption, format and date for each post so it can be shown as a post.", exists: "no" },
      scheduledSync("Fetch new posts daily and keep updating the numbers on recent posts for 30 days, as they keep rising."),
    ],
  },
  {
    code: "K3",
    title: "Accounting and billing connected",
    summary: "The ledger and the billing system arrive as tables every night, so actuals against budget need no export.",
    for: "Finance analyst",
    needs: [
      conn("Accounting ledger (QuickBooks, Xero or NetSuite)", "Journal entries, the list of accounts and which periods are closed."),
      conn("Billing (Stripe)", "Invoices, payments, refunds and subscriptions."),
      scheduledSync("Nightly at 02:00; re-read any open period in full because entries in it can still change."),
      syncedTables("The ledger as one large table (over two million rows) next to the uploaded budget."),
      { kind: "data", name: "Period close status", note: "Which months are closed and when, read from the ledger, shown on the table and in the bottom bar.", exists: "no" },
      { kind: "policy", name: "Closed periods do not change", note: "If a closed month's figures differ on a later sync, flag it instead of quietly replacing them.", exists: "no" },
    ],
  },
  {
    code: "K9",
    title: "Sales system connected",
    summary: "What moved in the pipeline since the last forecast call, down to the deals and their owners.",
    for: "Head of revenue operations",
    needs: [
      conn("Sales system (Salesforce or HubSpot)", "Open deals with amount, stage, close date and owner, plus the history of changes to those fields."),
      scheduledSync("Every 10 minutes for the sales system, far more often than the daily store sync."),
      { kind: "job", name: "Forecast snapshot", note: "Keep a copy of the pipeline at the time of each forecast call (Mondays 09:00) to compare against.", exists: "no" },
      { kind: "data", name: "Forecast snapshots", note: "The saved copies, with coverage, target and each deal's amount and close date at that moment.", exists: "no" },
      { kind: "endpoint", name: "GET /api/v1/forecast/changes", note: "Compare now with a chosen snapshot: deals slipped, pulled in, lost or changed in size, grouped by owner.", exists: "no" },
      conn("Chat alerts (Slack or Teams)", "Ask the owner sends the deal owner a message about one deal. Apps connections with approval exist; this message type does not.", "partly"),
    ],
  },
  {
    code: "K10",
    title: "Live checks and alerts",
    summary: "A check that runs every minute and sends an alert to chat or a phone, naming the owner and the one action to take.",
    for: "Director of operations",
    needs: [
      { kind: "job", name: "Threshold check every minute", note: "Read the watched number each minute, compare with its limit, and open or close an alert when it crosses.", exists: "no" },
      { kind: "data", name: "Alert rules and history", note: "Each rule's number, limit, owner and where to send; each alert's start, peak, who was assigned and when it cleared.", exists: "no" },
      conn("Chat alerts (Slack or Teams)", "Post the alert to a channel with Assign and Snooze buttons. Apps connections with approval exist; alert posting does not.", "partly"),
      { kind: "endpoint", name: "POST /api/v1/alerts/:id/assign", note: "Give the alert to a named person and tell them.", exists: "no" },
      { kind: "endpoint", name: "POST /api/v1/alerts/:id/snooze", note: "Stop repeats for a set time without closing the alert.", exists: "no" },
      { kind: "policy", name: "One alert per breach", note: "Send once when the limit is crossed and once when it clears; repeat only if nobody has been assigned after a set time.", exists: "no" },
    ],
  },
];
