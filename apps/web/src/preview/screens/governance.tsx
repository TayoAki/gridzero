import type { ReactNode } from "react";

import { Actions, Banner, Card, Checks, Chip, Options, Para, Primary, Rows, Screen, Secondary, Split, Stats, Steps, Timeline } from "../ui";

function K4(): ReactNode {
  return (
    <Screen
      title="Bring in definitions you already have"
      lead="We read the metrics in your metrics project and ran each one against Snowflake · ANALYTICS. Each arrives marked as yours, as a draft, ready to confirm."
      status={{ left: "From your metrics project", right: "4 differences to settle", tone: "warn" }}
    >
      <Steps items={["Connect the project", "Read the metrics", "Settle differences", "Bring in"]} at={2} />
      <Stats
        items={[
          { value: "42", label: "metrics found in your project" },
          { value: "38", label: "match the warehouse", tone: "good" },
          { value: "4", label: "differ", tone: "warn" },
        ]}
      />
      <Banner tone="warn">
        <strong>net_revenue</strong> differs from the dashboard's formula. Yours counts paid orders; the dashboard counts paid and pending. The difference is 212,400.
      </Banner>
      <Split>
        <Card title="The 4 that differ">
          <Rows
            columns={["Metric", "Your project", "Found elsewhere", "Difference#"]}
            rows={[
              ["net_revenue", "Paid orders", "Dashboard: paid and pending", "212,400"],
              ["active_customers", "Ordered in last 90 days", "Warehouse view: last 30 days", "1,912"],
              ["refund_rate", "Refunds ÷ paid orders", "Dashboard: refunds ÷ all orders", "0.4 pts"],
              ["avg_order_value", "Excludes tax", "Warehouse view: includes tax", "6.20"],
            ]}
          />
          <Para>Nothing is brought in for these four until you choose. The other 38 are not affected by the choice.</Para>
        </Card>
        <Card title="net_revenue">
          <Para><Chip>Yours</Chip> Paid orders</Para>
          <pre className="metric-sql">{`SELECT SUM(amount - refunded_amount)
FROM analytics.fct_orders
WHERE status = 'paid'`}</pre>
          <Para><Chip tone="warn">Dashboard</Chip> Paid and pending</Para>
          <pre className="metric-sql">{`SELECT SUM(amount - refunded_amount)
FROM analytics.fct_orders
WHERE status IN ('paid', 'pending')`}</pre>
          <Options
            picked={0}
            items={[
              { label: "Keep yours: paid orders only", note: "4,210,332" },
              { label: "Use the dashboard's: paid and pending", note: "4,422,732" },
              { label: "Keep both under different names", note: "Two numbers stay in use" },
            ]}
          />
        </Card>
      </Split>
      <Card title="What was read">
        <Rows
          columns={["From", "Detail", "Read"]}
          rows={[
            ["Repository", "analytics/metrics-project · branch main", "Today 09:12"],
            ["Metrics", "42 in 9 files", "Formula, filters, owner, description"],
            ["Models", "118, of which 31 are used by a metric", "Names and columns only"],
            ["Warehouse", "Snowflake · ANALYTICS", "Each formula run once, read-only"],
          ]}
        />
        <Para>We do not write to your project. If a definition is later corrected here, you get the change as a file to put back into the project yourself.</Para>
      </Card>
      <Actions>
        <Primary>Bring in 38</Primary>
        <Secondary>Review the 4</Secondary>
        <Secondary>Read the project again</Secondary>
      </Actions>
    </Screen>
  );
}

function K5(): ReactNode {
  return (
    <Screen
      title="Pilot scorecard"
      lead="Finance pilot · week 4. One team, before and after, counted from the first day."
      status={{ left: "Started 14 Oct", right: "Example data" }}
    >
      <Banner tone="info">Example figures. Your own pilot is counted from the day it starts.</Banner>
      <Stats
        items={[
          { value: "31 → 12", label: "requests a week to the data team", tone: "good" },
          { value: "3 h → 9 min", label: "to a trusted answer", tone: "good" },
          { value: "14", label: "people asking" },
        ]}
      />
      <Split>
        <Card title="Week by week">
          <Rows
            caption="Example figures"
            columns={["Week", "Requests to your team#", "Asked here instead#", "Time to a trusted answer#", "People asking#"]}
            rows={[
              ["Before (4-week average)", 31, 0, "3 h", 0],
              ["Week 1 · from 14 Oct", 26, 19, "41 min", 6],
              ["Week 2 · from 21 Oct", 19, 34, "17 min", 9],
              ["Week 3 · from 28 Oct", 15, 47, "11 min", 12],
              ["Week 4 · from 4 Nov", 12, 58, "9 min", 14],
            ]}
          />
          <Para>A trusted answer is one that came from a confirmed definition or a checked answer. Time runs from the question being asked to that answer being shown.</Para>
        </Card>
        <Card title="Still coming to your team">
          <Rows
            columns={["Kind of request", "This week#"]}
            rows={[
              ["Forecast changes", 5],
              ["New data sources", 4],
              ["One-off extracts for audit", 2],
              ["Other", 1],
            ]}
          />
          <Para>These need a person. They are the work the pilot is meant to leave room for.</Para>
        </Card>
      </Split>
      <Card title="How this is counted">
        <Checks
          items={[
            { ok: true, text: "Requests to your team", note: "From your request queue, tagged Finance" },
            { ok: true, text: "Questions asked here and time to an answer", note: "From Grid Zero's own log" },
            { ok: "warn", text: "The 'before' figure for time to an answer", note: "Entered by you on 14 Oct from a sample of 20 tickets" },
          ]}
        />
      </Card>
      <Actions>
        <Primary>Share the scorecard</Primary>
        <Secondary>Download the weekly figures</Secondary>
        <Secondary>Change what counts as a request</Secondary>
      </Actions>
    </Screen>
  );
}

function K6(): ReactNode {
  return (
    <Screen
      title="One change, every report"
      lead="Change · Net revenue. Leave out pending orders. The reports below share this one definition, so the change is made once."
      status={{ left: "1 change waiting", right: "17 reports affected", tone: "warn", action: { label: "Publish to all 17" } }}
    >
      <Stats
        items={[
          { value: "4.42M", label: "now" },
          { value: "4.21M", label: "after" },
          { value: "17", label: "reports", tone: "warn" },
        ]}
      />
      <Split>
        <Card title="Leave out pending orders">
          <Para>Net revenue v2 counts orders that are paid or pending. Version 3 counts paid orders only. 904 pending orders worth 212,400 leave the October total.</Para>
          <pre className="metric-sql">{`-- Net revenue v3
SELECT SUM(amount - refunded_amount)
FROM analytics.fct_orders
WHERE status = 'paid'          -- was: status IN ('paid', 'pending')`}</pre>
          <Rows
            columns={["Report", "Owner", "Now#", "After#", "Next send"]}
            rows={[
              ["EMEA review", "L. Fischer", "1.48M", "1.41M", "Mon 08:00"],
              ["APAC review", "K. Tan", "0.97M", "0.93M", "Mon 02:00"],
              ["Board pack", "R. Okafor", "4.42M", "4.21M", "Thu 07:00"],
              ["Weekly sales summary", "L. Fischer", "1.06M", "1.01M", "Fri 16:00"],
              ["Channel performance", "D. Marsh", "4.42M", "4.21M", "Not scheduled"],
              ["12 more reports", "6 owners", "", "", "5 scheduled"],
            ]}
          />
          <Actions>
            <Primary>Publish to all 17</Primary>
            <Secondary>Show all 17</Secondary>
            <Secondary>Discard the change</Secondary>
          </Actions>
        </Card>
        <Card title="Who is told">
          <Checks
            items={[
              { ok: true, text: "9 report owners", note: "A message with the old and new number for each of their reports" },
              { ok: "warn", text: "Scheduled sends hold until published", note: "8 sends are held. The first is APAC review, Monday 02:00" },
              { ok: true, text: "Viewers see a note on the number for 30 days", note: "\"Changed 12 Nov: pending orders left out\"" },
            ]}
          />
          <Para>If you discard the change, the held sends go out on time with the current number.</Para>
        </Card>
      </Split>
      <Card title="History of this definition">
        <Timeline
          items={[
            { when: "12 Nov", text: "Version 3 proposed by you: leave out pending orders. Waiting to be published.", tone: "warn" },
            { when: "2 Sep", text: "Version 2 confirmed by R. Okafor: refunds taken off.", tone: "good" },
            { when: "18 Jun", text: "Version 1 confirmed by R. Okafor." },
          ]}
        />
      </Card>
    </Screen>
  );
}

function K7(): ReactNode {
  return (
    <Screen
      title="Your query beside the AI's"
      lead="Revenue review · October. Write your own SQL next to the AI's draft, run both, and see where the results differ."
      status={{ left: "Both ran as you", right: "Share with the query attached" }}
    >
      <Stats
        items={[
          { value: "4,210,332", label: "AI draft" },
          { value: "4,198,010", label: "mine" },
          { value: "12,322", label: "apart", tone: "warn" },
        ]}
      />
      <Banner tone="info">Two queries, one difference. Yours leaves out 41 late refunds: October orders partly refunded in November. The draft keeps what was left of each order after the refund; yours drops the whole order.</Banner>
      <Split>
        <Card title="AI draft">
          <pre className="metric-sql">{`SELECT SUM(o.amount - o.refunded_amount) AS net_revenue
FROM analytics.fct_orders o
WHERE o.status = 'paid'
  AND o.ordered_at >= '2026-10-01'
  AND o.ordered_at <  '2026-11-01'`}</pre>
          <Para><Chip tone="good">Follows Net revenue v3</Chip> 18,204 rows · 1.4 s</Para>
        </Card>
        <Card title="Mine">
          <pre className="metric-sql">{`SELECT SUM(o.amount - o.refunded_amount) AS net_revenue
FROM analytics.fct_orders o
WHERE o.status = 'paid'
  AND o.ordered_at >= '2026-10-01'
  AND o.ordered_at <  '2026-11-01'
  AND NOT EXISTS (
    SELECT 1 FROM analytics.fct_refunds r
    WHERE r.order_id = o.order_id
      AND r.refunded_at >= '2026-11-01')`}</pre>
          <Para><Chip>Not saved</Chip> 18,163 rows · 2.1 s</Para>
          <Actions>
            <Primary>Run both</Primary>
            <Secondary>Copy the AI draft into mine</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="Where they differ">
        <Rows
          columns={["Cause", "Rows#", "AI draft#", "Mine#", "Difference#"]}
          rows={[
            ["October orders partly refunded after 31 Oct", 41, "12,322", "0", "12,322"],
            ["Everything else", "18,163", "4,198,010", "4,198,010", "0"],
          ]}
        />
        <Para>Which is right depends on the question. The confirmed definition keeps an order and takes the refund off, whenever the refund is issued, which is what the draft does. Dropping the whole order understates October by 12,322.</Para>
        <Actions>
          <Secondary>Show the 41 rows</Secondary>
          <Secondary>Use mine for this answer</Secondary>
          <Secondary>Propose a change to how we count</Secondary>
          <Secondary>Share with the query attached</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function K8(): ReactNode {
  return (
    <Screen
      title="Tie to Finance's number"
      lead="Reconcile · October revenue. Enter the figure Finance trusts. We show whether our number matches and, if not, which rows explain the gap."
      status={{ left: "Ledger · period closed", right: "Ties to Finance", tone: "good", action: { label: "Confirm for October" } }}
    >
      <Stats
        items={[
          { value: "4,210,332", label: "Finance says" },
          { value: "4,210,332", label: "Net revenue v3, October" },
          { value: "0", label: "apart", tone: "good" },
        ]}
      />
      <Banner tone="good">Matches to the unit.</Banner>
      <Split>
        <Card title="October">
          <Rows
            columns={["", "Amount#", "From"]}
            rows={[
              ["Finance's figure", "4,210,332", "Ledger, revenue accounts 4000 to 4190, closed 6 Nov"],
              ["How we count", "4,210,332", "Snowflake · ANALYTICS, 18,204 paid orders"],
              ["Difference", "0", ""],
            ]}
          />
          <Para>Last month: 3 rows apart, all late credit notes. They were posted to the ledger on 2 Oct and reached the warehouse on 4 Oct, after which the numbers tied.</Para>
          <Actions>
            <Primary>Confirm for October</Primary>
            <Secondary>Enter a different figure</Secondary>
            <Secondary>Show the rows</Secondary>
          </Actions>
        </Card>
        <Card title="History">
          <Rows
            columns={["Period", "Result", "Confirmed by"]}
            rows={[
              ["October", "Matches", "Waiting for you"],
              ["September", "Matches", "You, 7 Oct"],
              ["August", "3 rows apart, then matched", "You, 9 Sep"],
              ["July", "Matches", "A. Lindqvist, 6 Aug"],
            ]}
          />
        </Card>
      </Split>
      <Card title="What confirming does">
        <Checks
          items={[
            { ok: true, text: "October net revenue is marked as tied to Finance wherever it is shown" },
            { ok: true, text: "Answers that use October revenue say so", note: "\"Ties to the ledger, confirmed 12 Nov\"" },
            { ok: "warn", text: "If the ledger's October total changes later, you are asked again", note: "The mark is removed until you confirm" },
          ]}
        />
      </Card>
    </Screen>
  );
}

function K11(): ReactNode {
  return (
    <Screen
      title="Security and trust"
      lead="For your review. Everything an approver asks for in one place, with the current state of each control."
      status={{ left: "Last reviewed 1 Nov", right: "All controls on", tone: "good" }}
    >
      <Split>
        <Card title="Controls">
          <Checks
            items={[
              { ok: true, text: "Independent security audit", note: "Report on request, under a confidentiality agreement" },
              { ok: true, text: "Activity log export", note: "Every sign-in, query, change to how we count and share. Kept 13 months" },
              { ok: true, text: "People added and removed by your directory", note: "Last sync today 06:00 · 214 people · 3 removed this week" },
              { ok: true, text: "Data stays in your region", note: "EU (Frankfurt). Query results and stored answers do not leave it" },
              { ok: true, text: "Queries are read-only and run as the person asking", note: "Nobody sees rows here that they cannot see in the warehouse" },
            ]}
          />
          <Actions>
            <Primary>Request the audit report</Primary>
            <Secondary>Export the activity log</Secondary>
            <Secondary>Download this page as a document</Secondary>
          </Actions>
        </Card>
        <Card title="AI">
          <Options
            picked={0}
            items={[
              { label: "Use our own model key", note: "AI calls are billed to and logged by your own account" },
              { label: "Use Grid Zero's key", note: "Nothing to set up; usage appears on your Grid Zero bill" },
            ]}
          />
          <Para>No customer data is used to train models.</Para>
          <Rows
            columns={["Sent to the model", ""]}
            rows={[
              ["Table and column names", "Yes"],
              ["The question and the SQL", "Yes"],
              ["Result rows", "Only the rows needed for the answer, at most 200"],
              ["Columns marked sensitive", "Never"],
            ]}
          />
        </Card>
      </Split>
      <Card title="Access">
        <Rows
          columns={["Role", "People#", "Can do"]}
          rows={[
            ["Admin", 3, "Connections, security settings, roles"],
            ["Definition owner", 11, "Confirm and correct how we count"],
            ["Member", 186, "Ask, read answers, build reports"],
            ["Viewer", 14, "Read reports shared with them"],
          ]}
        />
        <Para>Roles follow groups in your directory. Removing a person there signs them out here within 15 minutes.</Para>
      </Card>
      <Card title="Recent activity">
        <Timeline
          items={[
            { when: "Today 06:00", text: "Directory sync: 1 person added, 0 removed.", tone: "good" },
            { when: "10 Nov", text: "Activity log exported by you: 1 Oct to 31 Oct." },
            { when: "4 Nov", text: "Model key replaced by J. Arroyo." },
            { when: "1 Nov", text: "Controls reviewed by you. All on.", tone: "good" },
          ]}
        />
      </Card>
    </Screen>
  );
}

function M3(): ReactNode {
  return (
    <Screen
      title="Conflicting numbers caught first"
      lead="Conflict · revenue. Two reports show different revenue for October. Here are both formulas and the rows that explain the gap, before leadership sees either."
      status={{ left: "Found before Thursday's send", right: "1 conflict open", tone: "warn" }}
    >
      <Banner tone="warn">Board pack says 4.42M. EMEA review says 4.21M.</Banner>
      <Stats
        items={[
          { value: "4.42M", label: "Board pack" },
          { value: "4.21M", label: "EMEA review, all regions total" },
          { value: "212,400", label: "apart · 904 rows", tone: "warn" },
        ]}
      />
      <Split>
        <Card title="Why they differ">
          <Para>Board pack counts pending orders: 904 rows, 212,400. EMEA review follows the confirmed definition, Net revenue v3, which counts paid orders only.</Para>
          <Rows
            columns={["", "Board pack", "EMEA review"]}
            rows={[
              ["Formula", "Its own, written in the report", "Net revenue v3"],
              ["Order status counted", "Paid and pending", "Paid"],
              ["Refunds", "Taken off", "Taken off"],
              ["Confirmed", "No", "Yes, by R. Okafor on 2 Sep"],
            ]}
          />
          <pre className="metric-sql">{`-- The rows only Board pack counts
SELECT order_id, amount, ordered_at
FROM analytics.fct_orders
WHERE status = 'pending'
  AND ordered_at >= '2026-10-01' AND ordered_at < '2026-11-01'
-- 904 rows, 212,400`}</pre>
          <Actions>
            <Primary>Use the confirmed definition in both</Primary>
            <Secondary>Show the 904 rows</Secondary>
            <Secondary>They are meant to differ</Secondary>
          </Actions>
        </Card>
        <Card title="Who sees these">
          <Rows
            columns={["Report", "Viewers#", "Next send"]}
            rows={[
              ["Board pack", 6, "Thursday 07:00"],
              ["EMEA review", 14, "Monday 08:00"],
            ]}
          />
          <Checks
            items={[
              { ok: "warn", text: "Thursday's board pack is held", note: "It goes out as soon as the conflict is settled" },
              { ok: true, text: "Both report owners have been told" },
              { ok: true, text: "Nobody outside the data team has seen this" },
            ]}
          />
          <Para>If they are meant to differ, each report gets a line under the number saying what it counts.</Para>
        </Card>
      </Split>
    </Screen>
  );
}

function M4(): ReactNode {
  return (
    <Screen
      title="Works with the dashboards you have"
      lead="Connected tools. Your existing dashboards read the same confirmed definitions. Nothing is rebuilt."
      status={{ left: "Checked today 06:00", right: "2 dashboards out of step", tone: "warn" }}
    >
      <Stats
        items={[
          { value: "32", label: "dashboards read confirmed definitions", tone: "good" },
          { value: "23", label: "Tableau" },
          { value: "9", label: "Power BI" },
          { value: "2", label: "still use their own revenue formula", tone: "warn" },
        ]}
      />
      <Banner tone="warn">2 still use their own revenue formula. They show 4.42M where the others show 4.21M.</Banner>
      <Split>
        <Card title="Tools">
          <Checks
            items={[
              { ok: true, text: "Tableau · 23 dashboards · in step", note: "Reads the published data source \"Grid Zero · confirmed\"" },
              { ok: true, text: "Power BI · 9 dashboards · in step", note: "Reads the shared model \"Grid Zero · confirmed\"" },
            ]}
          />
          <Rows
            caption="Out of step"
            columns={["Dashboard", "Tool", "Owner", "Uses", "Difference#"]}
            rows={[
              ["Channel performance", "Tableau", "D. Marsh", "Calculated field: paid and pending", "212,400"],
              ["Partner revenue", "Power BI", "S. Iyer", "Measure: paid and pending", "38,950"],
            ]}
          />
          <Actions>
            <Primary>Ask the 2 owners to switch</Primary>
            <Secondary>Check again now</Secondary>
            <Secondary>Connect another tool</Secondary>
          </Actions>
        </Card>
        <Card title="Net revenue v3">
          <Para><Chip tone="good">Confirmed</Chip> Used in 17 dashboards</Para>
          <Rows
            columns={["Tool", "Dashboards#", "On v3#"]}
            rows={[
              ["Tableau", 12, 12],
              ["Power BI", 5, 5],
            ]}
          />
          <Para>When how we count changes, these dashboards show the new number at their next refresh. Nobody edits them.</Para>
          <Actions>
            <Secondary>See the 2 that differ</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="What the tools are given">
        <Rows
          columns={["Definition", "Version", "Dashboards#", "Last change"]}
          rows={[
            ["Net revenue", "v3", 17, "12 Nov"],
            ["Active customers", "v2", 11, "30 Sep"],
            ["Gross margin", "v4", 9, "21 Oct"],
            ["Refund rate", "v1", 6, "18 Jun"],
          ]}
        />
        <Para>Only confirmed definitions are published to the tools. Drafts stay here.</Para>
      </Card>
    </Screen>
  );
}

function M5(): ReactNode {
  return (
    <Screen
      title="Before your review, unasked"
      lead="Before Thursday's review. Margin review · Thu 10:00. What moved since the last one on 14 Oct, and why."
      status={{ left: "Prepared Wed 17:00", right: "Ties to the ledger", tone: "good" }}
    >
      <Banner tone="good">Totals tie to Finance.</Banner>
      <Split>
        <Card title="3 things moved since 14 Oct">
          <Rows
            columns={["What", "Moved#", "Why"]}
            rows={[
              ["Margin", "−1.8 pts", "Freight: cost per shipment up 14% on two lanes after a carrier change on 20 Oct"],
              ["EMEA revenue", "+6%", "Two large renewals, signed 28 Oct and 3 Nov, together 248,000"],
              ["Returns queue", "Over limit twice", "Above 400 open returns on 22 Oct and 5 Nov, cleared within two days each time"],
            ]}
          />
          <Para>Everything else on the review's list moved less than 1% and is left out.</Para>
        </Card>
        <Card title="Suggested">
          <Options
            items={[
              { label: "Open the freight rows", note: "1,306 shipments on the two lanes" },
              { label: "Add to the review pack", note: "Three paragraphs and one table, after page 2" },
            ]}
          />
          <Para>Sent to the four people in the review. Each sees only the rows they may see in the warehouse.</Para>
        </Card>
      </Split>
      <Card title="Margin: where the 1.8 points went">
        <Rows
          caption="Example figures"
          columns={["Cost line", "14 Oct#", "Now#", "Effect on margin#"]}
          rows={[
            ["Freight", "6.1%", "7.6%", "−1.5 pts"],
            ["Packaging", "1.9%", "2.1%", "−0.2 pts"],
            ["Payment fees", "2.4%", "2.5%", "−0.1 pts"],
            ["All other lines", "51.2%", "51.2%", "0.0 pts"],
          ]}
        />
      </Card>
      <Card title="How this was checked">
        <Checks
          items={[
            { ok: true, text: "Revenue for the period matches the ledger", note: "4,210,332 both ways" },
            { ok: true, text: "Cost of goods matches the ledger" },
            { ok: "warn", text: "November freight invoices are not all in yet", note: "The freight figure covers invoices received up to Tuesday" },
          ]}
        />
        <Actions>
          <Primary>Add to the review pack</Primary>
          <Secondary>Open the freight rows</Secondary>
          <Secondary>Change what I am told about</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function M6(): ReactNode {
  return (
    <Screen
      title="Pilot results, measured"
      lead="Finance pilot · 90 days. Before and after from one of your own teams over a quarter."
      status={{ left: "14 Aug to 12 Nov", right: "Example data" }}
    >
      <Banner tone="info">Example figures. Yours are measured from your own request queue and from Grid Zero's log.</Banner>
      <Stats
        items={[
          { value: "−61%", label: "repeat requests", tone: "good" },
          { value: "9 min", label: "to a trusted answer", tone: "good" },
          { value: "0", label: "conflicting numbers reported", tone: "good" },
        ]}
      />
      <Split>
        <Card title="Before and after">
          <Rows
            caption="Example figures"
            columns={["Measure", "Quarter before#", "Pilot quarter#", "Change#"]}
            rows={[
              ["Repeat requests a week", 31, 12, "−61%"],
              ["Time to a trusted answer", "3 h", "9 min", "−95%"],
              ["Conflicting numbers reported", 7, 0, "−7"],
            ]}
          />
          <Para>A repeat request is a question the data team had already answered in the past year. A conflicting number is a case where two reports showed different figures under one name and someone outside the data team noticed.</Para>
        </Card>
        <Card title="Measured from">
          <Checks
            items={[
              { ok: true, text: "Your request queue", note: "Tickets tagged Finance, 14 May to 12 Nov" },
              { ok: true, text: "Grid Zero's own log", note: "Questions asked, answers given and how each was checked" },
            ]}
          />
          <Para>The two sources are shown apart so you can check the first against your own records.</Para>
        </Card>
      </Split>
      <Card title="By month">
        <Rows
          caption="Example figures"
          columns={["Month", "Repeat requests a week#", "Time to a trusted answer#", "People asking#"]}
          rows={[
            ["14 Aug to 13 Sep", 22, "26 min", 8],
            ["14 Sep to 13 Oct", 15, "12 min", 12],
            ["14 Oct to 12 Nov", 12, "9 min", 14],
          ]}
        />
        <Actions>
          <Primary>Download the results</Primary>
          <Secondary>See how each figure is counted</Secondary>
          <Secondary>Start a pilot with another team</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function M7(): ReactNode {
  return (
    <Screen
      title="The paperwork"
      lead="Security · for procurement. What procurement and security sign against."
      status={{ left: "Reviewed 1 Nov", right: "All items in place", tone: "good" }}
    >
      <Split>
        <Card title="Ready to sign">
          <Checks
            items={[
              { ok: true, text: "Independent security audit, report attached", note: "Covers the 12 months to 30 Sep" },
              { ok: true, text: "Company sign-in and directory", note: "People sign in through your provider and are added and removed by your directory" },
              { ok: true, text: "Activity log, exportable", note: "By date range, as a file or sent on to your own log store" },
              { ok: true, text: "Uptime commitment 99.9%", note: "Measured monthly, with credits when it is missed" },
            ]}
          />
        </Card>
        <Card title="Contacts">
          <Para>Security questions answered within 2 working days.</Para>
          <Rows
            columns={["For", "Write to"]}
            rows={[
              ["Security questionnaires", "security@gridzero.example"],
              ["Contract and data processing terms", "legal@gridzero.example"],
              ["An incident", "The address in your contract, answered at any hour"],
            ]}
          />
          <Actions>
            <Secondary>Send us your questionnaire</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="Documents">
        <Rows
          columns={["Document", "Dated", "How to get it"]}
          rows={[
            ["Independent security audit report", "30 Sep", "Download after a confidentiality agreement"],
            ["Data processing agreement", "1 Nov", "Download"],
            ["List of other companies that handle your data", "1 Nov", "Download"],
            ["Completed standard security questionnaire", "1 Nov", "Download"],
            ["Uptime commitment and record of past uptime", "1 Nov", "Download"],
          ]}
        />
        <Actions>
          <Primary>Download all as one file</Primary>
          <Secondary>Request the audit report</Secondary>
          <Secondary>Share this page with procurement</Secondary>
        </Actions>
      </Card>
      <Card title="What changed since the last review">
        <Timeline
          items={[
            { when: "1 Nov", text: "All items reviewed. Nothing outstanding.", tone: "good" },
            { when: "12 Oct", text: "One company added to the list of those that handle your data. Customers were told 30 days ahead." },
            { when: "30 Sep", text: "Audit period closed. No exceptions noted.", tone: "good" },
          ]}
        />
      </Card>
    </Screen>
  );
}

export const screens: Record<string, () => ReactNode> = { K4, K5, K6, K7, K8, K11, M3, M4, M5, M6, M7 };
