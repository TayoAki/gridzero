import type { ReactNode } from "react";

import { Actions, Banner, Card, Chat, Checks, Chip, Options, Para, Primary, Rows, Screen, Secondary, Split, Stats, Steps, Timeline } from "../ui";

function J1(): ReactNode {
  return (
    <Screen
      title="Connect and scan a warehouse"
      lead="Scan ANALYTICS on Snowflake. You see the cost and the time before anything runs, and no row data is copied."
      status={{ left: "Signed in as you · read only", right: "Estimate shown before running", tone: "good" }}
    >
      <Steps items={["Sign in as yourself", "Choose what to scan", "Check the estimate", "Scan", "Review how we count"]} at={2} />
      <Stats items={[{ value: "214", label: "tables" }, { value: "~$0.40", label: "warehouse cost" }, { value: "4 min", label: "to scan" }]} />
      <Split>
        <Card title="Scan ANALYTICS">
          <Para>Reads table names, column summaries and 90 days of query history. The scan runs on warehouse <code>REPORTING_XS</code> under your own Snowflake user, <code>MAYA.OKAFOR</code>, with role <code>ANALYST_RO</code>.</Para>
          <Rows
            columns={["Schema", "Tables#", "Rows (estimate)#", "Included"]}
            rows={[
              ["ANALYTICS.MARTS", 38, "212,400,000", "Yes"],
              ["ANALYTICS.STAGING", 71, "1,840,000,000", "Yes, summaries from a sample"],
              ["ANALYTICS.FINANCE", 22, "9,300,000", "Yes"],
              ["ANALYTICS.RAW", 83, "6,120,000,000", "Names and columns only"],
            ]}
            caption="214 tables your role can read. 9 more exist that your role cannot see; they are left out."
          />
          <Actions>
            <Primary>Scan</Primary>
            <Secondary>Choose schemas</Secondary>
            <Secondary>Use a different warehouse</Secondary>
          </Actions>
        </Card>
        <Card title="What we read">
          <Checks
            items={[
              { ok: true, text: "Table and column names, types and comments", note: "From INFORMATION_SCHEMA." },
              { ok: true, text: "Column summaries", note: "Counts, distinct values, earliest and latest dates, the most common values of status columns." },
              { ok: true, text: "90 days of query history", note: "Query text only, to learn which sums and filters people already use." },
              { ok: false, text: "No rows are copied or stored." },
              { ok: false, text: "Nothing is written to the warehouse." },
            ]}
          />
          <Para>Your own access decides what is visible. A colleague with a narrower role sees a narrower scan.</Para>
        </Card>
      </Split>
      <Card title="How the estimate is made">
        <Rows
          columns={["Step", "What runs", "Time#", "Cost#"]}
          rows={[
            ["Catalog", "Metadata queries, no warehouse time", "20 s", "$0.00"],
            ["Column summaries", "One query per table, sampled above 1,000,000 rows", "3 min", "$0.34"],
            ["Query history", "ACCOUNT_USAGE.QUERY_HISTORY, last 90 days", "40 s", "$0.06"],
          ]}
        />
        <Para>If the scan would cost more than $2.00 it stops and asks you first.</Para>
      </Card>
    </Screen>
  );
}

function J2(): ReactNode {
  return (
    <Screen
      title="Drill to the rows"
      lead="Click any number in a report to see the rows behind it. Here: net revenue in the revenue review."
      status={{ left: "18,402 rows · confirmed definition", right: "Your edits make an unconfirmed copy" }}
    >
      <Stats items={[{ value: "4,210,332", label: "net revenue", tone: "good" }, { value: "18,402", label: "rows behind it" }, { value: "v3", label: "version of how we count it" }]} />
      <Split>
        <Card title="Net revenue 4,210,332 = 18,402 rows">
          <Rows
            columns={["order_id", "order_date", "region", "customer", "status", "amount#"]}
            rows={[
              ["SO-88213", "2026-10-31", "EMEA", "Brightwater Ltd", "paid", "12,480.00"],
              ["SO-88209", "2026-10-31", "NA", "Corvin Supply", "paid", "3,115.50"],
              ["SO-88204", "2026-10-31", "NA", "Harlow & Finch", "paid", "940.00"],
              ["SO-88198", "2026-10-30", "APAC", "Tanaka Trading", "paid", "7,260.25"],
              ["SO-88191", "2026-10-30", "EMEA", "Nordlys AS", "paid", "1,804.00"],
              ["SO-88187", "2026-10-30", "NA", "Peak Outfitters", "paid", "22,950.00"],
              ["SO-88180", "2026-10-29", "EMEA", "Brightwater Ltd", "paid", "5,610.75"],
              ["SO-88176", "2026-10-29", "NA", "Corvin Supply", "paid", "412.00"],
            ]}
            caption="Showing 8 of 18,402 rows from ANALYTICS.MARTS.FCT_ORDERS, newest first. The rows add up to 4,210,332."
          />
          <Actions>
            <Primary>Open these rows as a sheet</Primary>
            <Secondary>Group by region</Secondary>
            <Secondary>Filter</Secondary>
            <Secondary>Show the 1,127 rows left out</Secondary>
          </Actions>
        </Card>
        <Card title="Net revenue · v3">
          <p><Chip tone="good">Confirmed</Chip> by Priya, 12 Nov</p>
          <pre className="metric-sql">{`SELECT SUM(amount)
FROM ANALYTICS.MARTS.FCT_ORDERS
WHERE status = 'paid'
  AND order_date >= '2026-10-01'
  AND order_date <  '2026-11-01'`}</pre>
          <Para>Runs in Snowflake under your own user, so you see only rows your role allows.</Para>
          <Options
            items={[
              { label: "Change the calculation", note: "Makes a copy that is yours. It stays unconfirmed until someone reviews it." },
              { label: "Share so a colleague can rerun it", note: "They rerun it with their own access and may see fewer rows." },
            ]}
          />
        </Card>
      </Split>
      <Card title="If you change the calculation">
        <Rows
          columns={["Version", "Rule", "Rows#", "Net revenue#", "Status"]}
          rows={[
            ["v3", "status = paid", "18,402", "4,210,332", "Confirmed"],
            ["Your copy", "status = paid, refunds taken off", "18,402", "4,131,870", "Unconfirmed, only you see it"],
          ]}
        />
        <Para>The report keeps using v3. Your copy shows an "unconfirmed" label wherever you use it until a reviewer confirms it.</Para>
        <Actions>
          <Secondary>Send the copy for review</Secondary>
          <Secondary>Discard the copy</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function J3(): ReactNode {
  return (
    <Screen
      title="What moved since last time"
      lead="Margin review, compared with the review on 14 Oct. The drivers are ranked, and the total ties to Finance's own figure."
      status={{ left: "Compared with 14 Oct review", right: "Ties to the ledger", tone: "good" }}
    >
      <Banner tone="warn">Margin down 1.8 pts since 14 Oct: 38.6% then, 36.8% now.</Banner>
      <Stats items={[{ value: "−1.1", label: "freight", tone: "bad" }, { value: "−0.5", label: "product mix", tone: "warn" }, { value: "−0.2", label: "currency" }]} />
      <Split>
        <Card title="Drivers, largest first">
          <Rows
            columns={["Driver", "14 Oct#", "Now#", "Effect on margin (pts)#", "What changed"]}
            rows={[
              ["Freight", "212,900", "259,200", "−1.1", "Carrier surcharge from 20 Oct on 3 lanes"],
              ["Product mix", "—", "—", "−0.5", "Accessories up from 18% to 23% of sales"],
              ["Currency", "—", "—", "−0.2", "EUR down 1.4% against USD"],
              ["Everything else", "—", "—", "0.0", "Price, discounts and returns unchanged"],
              ["Total", "38.6%", "36.8%", "−1.8", ""],
            ]}
            caption="The three drivers add up to the whole change. Nothing is left unexplained."
          />
          <Actions>
            <Primary>Show the freight rows</Primary>
            <Secondary>Compare with a different review</Secondary>
            <Secondary>Add to the review notes</Secondary>
          </Actions>
        </Card>
        <Card title="Ties to Finance" tone="good">
          <Banner tone="good">Ledger total 4,210,332 matches.</Banner>
          <Rows
            columns={["Figure", "Here#", "Ledger#", "Difference#"]}
            rows={[
              ["Net revenue", "4,210,332", "4,210,332", "0"],
              ["Cost of goods", "2,401,750", "2,401,750", "0"],
              ["Freight", "259,200", "259,200", "0"],
            ]}
          />
          <Para>The ledger figures are Checked answers entered by Finance on 3 Nov. If one stops matching, this card turns red and says by how much.</Para>
        </Card>
      </Split>
      <Card title="What was compared">
        <Checks
          items={[
            { ok: true, text: "Same way of counting in both reviews", note: "Gross margin v2 and Net revenue v3 were in force on 14 Oct and are in force now." },
            { ok: true, text: "Same period length", note: "September against October, both full months." },
            { ok: "warn", text: "312 October orders arrived after the 14 Oct review", note: "They are in the September figure now. Their effect on margin is under 0.05 pts." },
          ]}
        />
      </Card>
    </Screen>
  );
}

function J4(): ReactNode {
  return (
    <Screen
      title="A queue over its limit"
      lead="Operations board. Which queue, since when, what started it, and who can act."
      status={{ left: "Checked every 15 min", right: "1 queue over its limit", tone: "bad" }}
    >
      <Banner tone="bad">Returns: 412 waiting. Limit is 250.</Banner>
      <Split>
        <Card title="Returns queue">
          <Stats items={[{ value: "412", label: "waiting now", tone: "bad" }, { value: "250", label: "limit" }, { value: "2 days", label: "over the limit" }]} />
          <Para>Started Tue 09:40, when the carrier file arrived late. Returns that should have been matched that morning were matched after 11:00 and have been backing up since.</Para>
          <Para><strong>Owner:</strong> Returns team. <strong>Not yet assigned to a person.</strong></Para>
          <Actions>
            <Primary>Assign to Priya</Primary>
            <Secondary>Assign to someone else</Secondary>
            <Secondary>Show the 412 returns</Secondary>
            <Secondary>Snooze until tomorrow</Secondary>
          </Actions>
        </Card>
        <Card title="Since Tuesday">
          <Timeline
            items={[
              { when: "Tue 09:40", text: "Carrier file late. It normally lands by 06:00.", tone: "warn" },
              { when: "Tue 11:15", text: "Returns queue over its limit: 262 waiting.", tone: "bad" },
              { when: "Tue 11:15", text: "Alert sent to the returns channel. Nobody picked it up." },
              { when: "Wed 16:00", text: "358 waiting.", tone: "bad" },
              { when: "Now", text: "412 waiting.", tone: "bad" },
            ]}
          />
        </Card>
      </Split>
      <Card title="All queues">
        <Rows
          columns={["Queue", "Waiting#", "Limit#", "Oldest item", "Owner", "State"]}
          rows={[
            ["Returns", 412, 250, "2 days", "Returns team", "Over since Tue 11:15"],
            ["Pick and pack", 96, 300, "3 hours", "Warehouse floor", "Within limit"],
            ["Supplier disputes", 41, 60, "6 days", "Purchasing", "Within limit"],
            ["Address corrections", 18, 100, "5 hours", "Customer care", "Within limit"],
          ]}
          caption="Counted from ANALYTICS.MARTS.OPS_QUEUE_ITEMS. Last checked 8 minutes ago."
        />
        <Actions>
          <Secondary>Change a limit</Secondary>
          <Secondary>Change who is told</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function J5(): ReactNode {
  return (
    <Screen
      title="Trace a number to its source"
      lead="Net revenue in the revenue review: the path from the widget, to the approved way of counting, to the warehouse tables, with who confirmed each step."
      status={{ left: "Definition v3", right: "Traced to source", tone: "good" }}
    >
      <Split>
        <Card title="Where this number comes from">
          <Options
            picked={1}
            items={[
              { label: "Widget · Revenue review", note: "Net revenue tile, 4,210,332. Last refreshed today 07:12." },
              { label: "Definition · Net revenue v3 · confirmed", note: "SUM(amount) where status = paid. Confirmed by Priya, 12 Nov." },
              { label: "Model · fct_orders", note: "ANALYTICS.MARTS.FCT_ORDERS. Built by the metrics project, last run today 05:30, all 14 tests passed." },
              { label: "Model · stg_shopify__orders", note: "ANALYTICS.STAGING.STG_SHOPIFY__ORDERS. Renames columns and removes test orders." },
              { label: "Source · raw.shopify_orders", note: "ANALYTICS.RAW.SHOPIFY_ORDERS. Loaded hourly, newest row today 06:58." },
            ]}
          />
          <Para>Pick a step to see its detail on the right.</Para>
        </Card>
        <Card title="Net revenue v3">
          <p><Chip tone="good">Confirmed</Chip> by Priya, 12 Nov.</p>
          <pre className="metric-sql">{`SELECT SUM(amount)
FROM ANALYTICS.MARTS.FCT_ORDERS
WHERE status = 'paid'`}</pre>
          <Rows
            columns={["Version", "Rule", "Confirmed by", "When"]}
            rows={[
              ["v3", "Paid orders only", "Priya", "12 Nov"],
              ["v2", "Paid and pending", "Marcus", "3 Jun"],
              ["v1", "All orders", "Drafted from query history", "—"],
            ]}
          />
          <Actions>
            <Secondary>Show the query</Secondary>
            <Secondary>Open in the metrics project</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="Columns used">
        <Rows
          columns={["In the definition", "In fct_orders", "Comes from", "Changed on the way"]}
          rows={[
            ["amount", "amount", "raw.shopify_orders.total_price", "Converted to USD at the order date's rate"],
            ["status", "status", "raw.shopify_orders.financial_status", "Lower-cased; 'partially_paid' becomes 'pending'"],
            ["order_date", "order_date", "raw.shopify_orders.created_at", "Cut to a date in UTC"],
          ]}
        />
      </Card>
      <Card title="Also uses this definition">
        <Para>17 reports and 4 Checked answers read Net revenue v3. A change to any step above shows here before it is published.</Para>
        <Actions>
          <Secondary>List the 17 reports</Secondary>
          <Secondary>Copy a link to this trace</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function J6(): ReactNode {
  return (
    <Screen
      title="See as another person"
      lead="Revenue review, access check. The same report, run with each person's own access, side by side."
      status={{ left: "Runs as each viewer", right: "No shared sign-in is used", tone: "good" }}
    >
      <Stats items={[{ value: "4.21M", label: "as Dana, Finance" }, { value: "1.02M", label: "as Luis, EMEA" }, { value: "hidden", label: "no access", tone: "warn" }]} />
      <Banner tone="info">Each viewer sees only what their own access allows.</Banner>
      <Split>
        <Card title="Net revenue by region">
          <Rows
            columns={["Region", "As Dana#", "As Luis#", "No warehouse access"]}
            rows={[
              ["NA", "2,304,120", "—", "hidden"],
              ["EMEA", "1,020,480", "1,020,480", "hidden"],
              ["APAC", "885,732", "—", "hidden"],
              ["Total", "4,210,332", "1,020,480", "hidden"],
            ]}
            caption="Luis's total is labelled 'EMEA only' in his report, so it is not mistaken for the company figure."
          />
          <Actions>
            <Primary>Check another person</Primary>
            <Secondary>Check a group</Secondary>
            <Secondary>Save this check to the audit record</Secondary>
          </Actions>
        </Card>
        <Card title="Shared report">
          <Rows
            columns={["Viewer", "Snowflake role", "Sees"]}
            rows={[
              ["Dana, Finance", "FINANCE_RO", "All regions"],
              ["Luis, EMEA", "SALES_EMEA_RO", "EMEA rows only"],
              ["No warehouse access", "none", "Nothing"],
            ]}
          />
          <Para>Someone with no warehouse access can open the report, but every number shows "hidden" with a line saying who to ask for access. No saved copy of the numbers is shown in its place.</Para>
        </Card>
      </Split>
      <Card title="How this check works">
        <Checks
          items={[
            { ok: true, text: "The query runs once per person, under that person's own Snowflake user", note: "Row access policies in the warehouse decide what comes back. Grid Zero adds no rules of its own." },
            { ok: true, text: "You need the admin role to run a check, and each check is recorded", note: "The record keeps who checked, as whom, and when. It does not keep the numbers." },
            { ok: "warn", text: "A person who has not signed in to Snowflake yet cannot be checked", note: "2 of 46 people on this report have not. They see nothing until they do." },
            { ok: false, text: "No shared service account is used, for the check or for the report." },
          ]}
        />
      </Card>
    </Screen>
  );
}

function J7(): ReactNode {
  return (
    <Screen
      title="Query log and spend"
      lead="Queries, November. Every query, who ran it, and what it cost in the warehouse and in AI."
      status={{ left: "November", right: "Within limits", tone: "good" }}
    >
      <Stats items={[{ value: "1,204", label: "queries" }, { value: "$38.20", label: "warehouse" }, { value: "$12.10", label: "AI" }]} />
      <Split>
        <Card title="Latest queries">
          <Rows
            columns={["When", "Who", "What", "Rows read#", "Time#", "Warehouse#", "AI#"]}
            rows={[
              ["11 Nov 10:42", "Dana Whitfield", "Net revenue by region, October", "18,402", "1.2 s", "$0.01", "$0.02"],
              ["11 Nov 10:31", "Luis Ortega", "EMEA orders over 10,000", "5,116", "0.9 s", "$0.01", "$0.03"],
              ["11 Nov 09:58", "Maya Okafor", "Drill to rows: Net revenue", "18,402", "1.6 s", "$0.02", "$0.00"],
              ["11 Nov 09:15", "Scheduled", "Returns queue check", "412", "0.4 s", "$0.00", "$0.00"],
              ["11 Nov 08:47", "Tom Reyes", "Freight cost by lane, 12 months", "2,940,118", "14.8 s", "$0.41", "$0.04"],
              ["10 Nov 17:20", "Tom Reyes", "All order lines since 2019", "1,310,000,000", "stopped", "$0.00", "$0.01"],
            ]}
            caption="Showing 6 of 1,204. The last row was stopped before it ran: it would have scanned over 1B rows."
          />
          <Actions>
            <Secondary>Filter by person</Secondary>
            <Secondary>Show the SQL</Secondary>
            <Secondary>Export the log</Secondary>
          </Actions>
        </Card>
        <Card title="Limits">
          <Rows
            columns={["Limit", "Set to", "Reached this month"]}
            rows={[
              ["Warehouse spend", "$5 a person a day", "Never"],
              ["Large scans", "Ask before scanning over 1B rows", "1 time"],
              ["AI spend", "$40 a person a month", "Never"],
            ]}
          />
          <Para>When a person reaches a limit, their next query waits and they are told why. An admin can let it through.</Para>
          <Actions>
            <Primary>Change limits</Primary>
          </Actions>
        </Card>
      </Split>
      <Card title="Spend by person">
        <Rows
          columns={["Person", "Queries#", "Warehouse#", "AI#", "Highest day#"]}
          rows={[
            ["Tom Reyes", 318, "$14.60", "$3.90", "$2.85"],
            ["Maya Okafor", 276, "$9.10", "$2.70", "$1.40"],
            ["Dana Whitfield", 204, "$5.30", "$2.40", "$0.90"],
            ["Luis Ortega", 131, "$2.80", "$1.60", "$0.55"],
            ["Scheduled checks", 168, "$1.90", "$0.00", "$0.12"],
            ["9 others", 107, "$4.50", "$1.50", "$0.70"],
          ]}
          caption="Warehouse cost is read from Snowflake's own usage record, so it matches your Snowflake bill for these queries."
        />
      </Card>
    </Screen>
  );
}

function J8(): ReactNode {
  return (
    <Screen
      title="Use of shared numbers"
      lead="Adoption, last 30 days. Whether business teams are answering their own questions."
      status={{ left: "Last 30 days", right: "Example data" }}
    >
      <Banner tone="info">Example figures. They show what this page would report, not measured results.</Banner>
      <Stats items={[{ value: "62%", label: "answered without a request", tone: "good" }, { value: "9 min", label: "to a trusted answer" }, { value: "−41%", label: "repeat requests", tone: "good" }]} />
      <Split>
        <Card title="By team">
          <Rows
            columns={["Team", "Answered without a request#", "Questions asked#", "People active#", "Sent to the data team#"]}
            rows={[
              ["Finance", "71%", 214, "12 of 14", 62],
              ["Sales", "58%", 388, "31 of 52", 163],
              ["Operations", "49%", 171, "9 of 20", 87],
            ]}
            caption="Example figures."
          />
          <Actions>
            <Secondary>Change the period</Secondary>
            <Secondary>Export</Secondary>
          </Actions>
        </Card>
        <Card title="How each figure is counted">
          <Checks
            items={[
              { ok: true, text: "Answered without a request", note: "A question that ended in an answer built only on confirmed ways of counting, with nobody on the data team involved." },
              { ok: true, text: "Time to a trusted answer", note: "From the question being asked to an answer the person accepted. Median." },
              { ok: true, text: "Repeat requests", note: "Requests to the data team that match one already answered, against the 30 days before." },
            ]}
          />
        </Card>
      </Split>
      <Card title="Asked most often, still going to the data team">
        <Rows
          columns={["Question", "Times asked#", "Why it was not self-served", "What would fix it"]}
          rows={[
            ["Pipeline coverage by rep", 34, "No confirmed way to count 'coverage'", "Confirm one of 2 drafts"],
            ["On-time shipping rate by carrier", 27, "The carrier table is not scanned", "Add ANALYTICS.MARTS.DIM_CARRIER"],
            ["Churned customers last quarter", 19, "Two teams count churn differently", "Settle the open question"],
          ]}
          caption="Example figures."
        />
        <Actions>
          <Primary>Open How we count</Primary>
          <Secondary>See all open questions</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function J9(): ReactNode {
  return (
    <Screen
      title="Company sign-in"
      lead="Sign in with the company account. Groups map to roles, so nobody is added by hand."
      status={{ left: "Single sign-on", right: "Required by your company", tone: "good" }}
    >
      <Split>
        <Card title="Sign in with your company account">
          <Para>northfield.example uses single sign-on. There is no separate Grid Zero password.</Para>
          <Actions>
            <Primary>Continue with Okta</Primary>
          </Actions>
          <Para>Managed by your administrator. If you cannot sign in, ask them to add you to a group that has access.</Para>
        </Card>
        <Card title="For admins">
          <Rows
            columns={["Group in Okta", "Role here", "People#"]}
            rows={[
              ["Finance", "Editor", 14],
              ["Sales", "Viewer", 52],
              ["Operations", "Viewer", 20],
              ["Data platform", "Admin", 6],
            ]}
          />
          <Para>Someone in two groups gets the higher role. Someone in no mapped group cannot sign in.</Para>
          <Actions>
            <Secondary>Add a mapping</Secondary>
            <Secondary>Test with my account</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="Set-up">
        <Checks
          items={[
            { ok: true, text: "Connected to Okta", note: "Sign-in tested by Jonas today 09:12." },
            { ok: true, text: "People and groups are kept up to date", note: "92 people, 4 groups. Last update 6 minutes ago." },
            { ok: true, text: "Leavers lose access", note: "When someone is removed in Okta they are signed out here within 10 minutes and their schedules pause." },
            { ok: "warn", text: "Password sign-in is still on for 3 people", note: "Turn on 'require single sign-on' to close it. One admin keeps a recovery code in case Okta is down." },
          ]}
        />
        <Actions>
          <Primary>Require single sign-on for everyone</Primary>
          <Secondary>See the 3 people</Secondary>
        </Actions>
      </Card>
      <Card title="Sign-in is separate from data access">
        <Para>Signing in with Okta decides what a person can do in Grid Zero. What data they can see is still decided by their own Snowflake user, the first time they connect it.</Para>
      </Card>
    </Screen>
  );
}

function J10(): ReactNode {
  return (
    <Screen
      title="What the AI can see"
      lead="AI access. A plain statement of what is sent to the model, and the columns you have masked."
      status={{ left: "Applies to everyone", right: "3 columns masked", tone: "good" }}
    >
      <Split>
        <Card title="What the AI is sent">
          <Checks
            items={[
              { ok: true, text: "Column names and summaries", note: "Names, types, counts and the most common values of status columns." },
              { ok: true, text: "Query results, up to 500 rows", note: "Only for the question being answered, and only rows the asker's own access returned." },
              { ok: true, text: "The question, and How we count", note: "The names, rules and formulas of confirmed and draft definitions." },
              { ok: false, text: "Sign-in details", note: "Warehouse users, passwords, keys and tokens are never sent." },
              { ok: false, text: "Whole tables", note: "Anything past 500 rows stays in the warehouse. The AI is told how many rows there were." },
              { ok: false, text: "Masked columns", note: "Values are replaced before sending. The AI can still count and group by them." },
            ]}
          />
          <Banner tone="info">Masked: email, phone, tax_id</Banner>
        </Card>
        <Card title="Controls">
          <Options
            items={[
              { label: "Mask a column", note: "Its values are replaced with a placeholder in everything sent to the AI. People with access still see them on screen." },
              { label: "Use our own model key", note: "Requests go to your company's own account with the model provider, under your agreement with them." },
            ]}
          />
          <Rows columns={["Setting", "Now"]} rows={[["Rows sent per result", "Up to 500"], ["Model key", "Your company's own"], ["Kept by the model provider", "Per your agreement with them"]]} />
        </Card>
      </Split>
      <Card title="Masked columns">
        <Rows
          columns={["Column", "Found in", "What the AI sees", "Masked by", "Since"]}
          rows={[
            ["email", "DIM_CUSTOMER, STG_SHOPIFY__ORDERS and 4 more", "masked-1, masked-2 …", "Jonas", "2 Nov"],
            ["phone", "DIM_CUSTOMER, DIM_SUPPLIER", "masked-1, masked-2 …", "Jonas", "2 Nov"],
            ["tax_id", "DIM_SUPPLIER", "masked-1, masked-2 …", "Aiko", "5 Nov"],
          ]}
          caption="A column is masked by name across every table, so a new table with an email column is covered the day it appears."
        />
        <Actions>
          <Primary>Mask a column</Primary>
          <Secondary>Suggest columns that look personal</Secondary>
          <Secondary>Show what was sent for one question</Secondary>
        </Actions>
      </Card>
      <Card title="Suggested, not yet masked">
        <Rows
          columns={["Column", "Why it was suggested", "Tables#"]}
          rows={[
            ["shipping_address", "Looks like street addresses", 3],
            ["date_of_birth", "Name and values look like birth dates", 1],
          ]}
        />
      </Card>
    </Screen>
  );
}

function M1(): ReactNode {
  return (
    <Screen
      title="Nothing leaves your warehouse"
      lead="Where data goes. Queries run in the warehouse as each person, results are shown and not kept, and the AI uses your company's own model key."
      status={{ left: "Runs in your warehouse", right: "Nothing stored outside", tone: "good" }}
    >
      <Banner tone="good">0 rows held outside your warehouse.</Banner>
      <Split>
        <Card title="Your data stays in Snowflake">
          <Checks
            items={[
              { ok: true, text: "Every query runs there, as the person asking", note: "Under their own Snowflake user and role. There is no shared service account." },
              { ok: true, text: "Results are displayed and not stored", note: "They pass through to the person's browser and are dropped when the page closes. Saved reports keep the query, not the rows." },
              { ok: true, text: "AI uses your own model key", note: "Requests go from your Snowflake account to your account with the model provider. Masked columns are replaced first." },
              { ok: true, text: "How we count is stored in your warehouse", note: "In the schema ANALYTICS.GRIDZERO, which you can read, back up and drop." },
            ]}
          />
        </Card>
        <Card title="Checked">
          <Para><strong>Today 06:00.</strong> The check runs every day and after every update.</Para>
          <Timeline
            items={[
              { when: "Today 06:00", text: "0 rows held outside. 0 outbound connections other than the model provider.", tone: "good" },
              { when: "Yesterday 06:00", text: "0 rows held outside.", tone: "good" },
              { when: "9 Nov 14:20", text: "Checked after update 1.8.2. 0 rows held outside.", tone: "good" },
            ]}
          />
          <Actions>
            <Secondary>Show the evidence</Secondary>
            <Secondary>Download for your auditor</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="What is kept, and where">
        <Rows
          columns={["What", "Where it is kept", "Leaves Snowflake"]}
          rows={[
            ["Table rows and query results", "Your tables only. Not kept anywhere else.", "No"],
            ["How we count, versions and who confirmed them", "ANALYTICS.GRIDZERO", "No"],
            ["Query log", "ANALYTICS.GRIDZERO.QUERY_LOG", "No"],
            ["Questions and up to 500 result rows per answer", "Not kept. Sent to the model under your own key.", "Yes, to your model provider only"],
            ["Sign-in names and roles", "Your company sign-in and Snowflake", "No"],
            ["Licence check: account name and number of people", "Grid Zero", "Yes, once a day, no data"],
          ]}
        />
        <Para>If you also keep the model inside Snowflake, the fourth row becomes "No" and nothing but the licence check leaves.</Para>
      </Card>
    </Screen>
  );
}

function M2(): ReactNode {
  return (
    <Screen
      title="Definitions written back to your code"
      lead="Net revenue v3, write back. A confirmed way of counting becomes a change request in the project your data team already maintains, so there is one source of truth."
      status={{ left: "Definition v3", right: "Not yet in your project", tone: "warn" }}
    >
      <Steps items={["Confirmed here", "Change request opened", "Reviewed by your team", "Merged", "Project and Grid Zero match"]} at={1} />
      <Split>
        <Card title="Change request in analytics-models">
          <p><Chip tone="good">Confirmed</Chip> by Priya, 12 Nov</p>
          <pre className="metric-sql">{`models/marts/metrics.yml

  - name: net_revenue
    label: Net revenue
    type: simple
    type_params:
      measure: order_amount
-   filter: "{{ Dimension('order__status') }} in ('paid', 'pending')"
+   filter: "{{ Dimension('order__status') }} = 'paid'"
+   meta:
+     gridzero_version: 3
+     confirmed_by: priya
+     confirmed_on: 2026-11-12`}</pre>
          <Rows
            columns={["", "Rule", "Net revenue, October#"]}
            rows={[
              ["+ net_revenue", "Paid orders only", "4,210,332"],
              ["− net_revenue", "Paid and pending", "4,388,905"],
            ]}
          />
          <Actions>
            <Primary>Open change request</Primary>
            <Secondary>Edit the message</Secondary>
            <Secondary>Choose a different branch</Secondary>
          </Actions>
        </Card>
        <Card title="After it merges">
          <Para>Your project and Grid Zero match.</Para>
          <Para>17 reports update. They already use v3 here; after the merge, anything else that reads the project (other dashboards, notebooks) gets the same number.</Para>
          <Checks
            items={[
              { ok: true, text: "Branch gridzero/net-revenue-v3 from main", note: "Grid Zero never pushes to main. Your review and your tests decide." },
              { ok: true, text: "Project builds with the change", note: "Checked before the request is opened." },
              { ok: "warn", text: "Until it merges, the two disagree", note: "The project still says paid and pending. This page shows a warning until the merge." },
            ]}
          />
        </Card>
      </Split>
      <Card title="Waiting to be written back">
        <Rows
          columns={["Definition", "Confirmed", "In your project", "State"]}
          rows={[
            ["Net revenue v3", "Priya, 12 Nov", "v2: paid and pending", "Ready to open a change request"],
            ["Gross margin v2", "Dana, 3 Nov", "v2", "Matches"],
            ["Active customers v4", "Marcus, 28 Oct", "v3", "Change request open, 1 approval needed"],
            ["Return rate v1", "Priya, 21 Oct", "Not in the project", "Ready to open a change request"],
          ]}
        />
        <Chat
          turns={[
            { who: "you", text: "What happens if someone edits net_revenue in the project directly?" },
            { who: "agent", text: "The next scan sees the difference and opens a question for the definition's owner: keep the project's version, or keep v3. Nothing changes in reports until someone answers." },
          ]}
        />
      </Card>
    </Screen>
  );
}

export const screens: Record<string, () => ReactNode> = { J1, J2, J3, J4, J5, J6, J7, J8, J9, J10, M1, M2 };
