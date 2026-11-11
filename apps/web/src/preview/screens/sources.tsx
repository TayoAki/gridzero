import type { ReactNode } from "react";

import { Actions, Banner, Card, Chat, Checks, Chip, ClientPage, Options, Para, Phone, Primary, Rows, Screen, Secondary, Split, Stats, Steps, Timeline } from "../ui";

function H1(): ReactNode {
  return (
    <Screen
      title="Connect a store"
      lead="Where is Larkspur's data? Sign in once and it arrives on its own from then on."
      status={{ left: "File upload only", right: "Connect to stop exporting", tone: "busy" }}
    >
      <Steps items={["Pick a service", "Sign in", "Choose what to bring in", "First sync"]} at={0} />
      <Split>
        <Card title="Pick a service for Larkspur">
          <Options
            items={[
              { label: "Shopify", note: "Store: orders, refunds, products, customers" },
              { label: "Meta Ads", note: "Ads: spend, clicks and purchases by campaign" },
              { label: "Google Ads", note: "Ads: spend, clicks and conversions by campaign" },
            ]}
            picked={0}
          />
          <Para>You will be sent to Shopify to sign in with the store's own account, or you can send Larkspur a link so they sign in themselves.</Para>
          <Actions>
            <Primary>Sign in to Shopify</Primary>
            <Secondary>Send the client a sign-in link</Secondary>
            <Secondary>Upload a file</Secondary>
          </Actions>
        </Card>
        <Card title="What we read">
          <Checks
            items={[
              { ok: true, text: "Orders and refunds", note: "From the store's first order onwards" },
              { ok: true, text: "Products and customers", note: "Names and totals, for grouping" },
              { ok: true, text: "Ad spend", note: "Once Meta Ads or Google Ads is connected" },
              { ok: false, text: "Card numbers and passwords", note: "Never read" },
            ]}
          />
          <Para><strong>Read only.</strong> Nothing in the store or the ad accounts is changed.</Para>
        </Card>
      </Split>
      <Card title="Larkspur's data today">
        <Rows
          columns={["Data", "How it arrives", "Last updated", "Rows#"]}
          rows={[
            ["Orders", "File, uploaded by hand", "1 Nov", "47,798"],
            ["Meta Ads", "Not connected", "—", "—"],
            ["Google Ads", "Not connected", "—", "—"],
          ]}
          caption="Example figures"
        />
        <Para>Once Shopify is connected, the uploaded orders file is kept and you choose which of the two reports should read from.</Para>
      </Card>
    </Screen>
  );
}

function H2(): ReactNode {
  return (
    <Screen
      title="Synced and fresh"
      lead="Larkspur's Shopify orders arrive every morning. Next month's report needs no upload."
      status={{ left: "48,210 rows · Synced 06:00", right: "All confirmed", tone: "good" }}
    >
      <Stats
        items={[
          { value: "48,210", label: "Orders in the table" },
          { value: "412", label: "New since yesterday", tone: "good" },
          { value: "06:00", label: "Last sync, today", tone: "good" },
          { value: "Tomorrow 06:00", label: "Next sync" },
        ]}
      />
      <Split>
        <Card title="Shopify orders">
          <Rows
            columns={["Order", "Date", "Customer", "Items#", "Total#", "Status"]}
            rows={[
              ["#48210", "11 Nov", "R. Okafor", 2, "84.00", "Paid"],
              ["#48209", "11 Nov", "J. Lindqvist", 1, "36.50", "Paid"],
              ["#48208", "10 Nov", "M. Haddad", 4, "152.00", "Paid"],
              ["#48207", "10 Nov", "S. Brandt", 1, "24.00", "Refunded"],
              ["#48206", "10 Nov", "A. Moreau", 3, "97.50", "Paid"],
              ["#48205", "10 Nov", "T. Nakamura", 2, "61.00", "Paid"],
              ["#48204", "10 Nov", "P. Castell", 1, "36.50", "Paid"],
              ["#48203", "10 Nov", "E. Whitlock", 5, "188.00", "Paid"],
            ]}
            caption="Example figures. Newest 8 of 48,210."
          />
          <Actions>
            <Secondary>Sync now</Secondary>
            <Secondary>Change the timetable</Secondary>
          </Actions>
        </Card>
        <Card title="Analyst">
          <Chat
            turns={[
              { who: "agent", text: "412 new orders since yesterday. 9 older orders changed, all of them refunds." },
              { who: "you", text: "Does that move October?" },
              { who: "agent", text: "Yes, slightly. 3 of the refunds are on October orders, so October revenue is 214.50 lower than in the report you sent." },
            ]}
          />
          <Actions>
            <Primary>Update the October report</Primary>
          </Actions>
        </Card>
      </Split>
      <Card title="Larkspur's connections">
        <Rows
          columns={["Data", "Last sync", "Added#", "Changed#", "Result"]}
          rows={[
            ["Shopify orders", "Today 06:00", 412, 9, "Complete"],
            ["Meta Ads", "Today 06:02", 31, 0, "Complete"],
            ["Google Ads", "Today 06:03", 18, 0, "Complete"],
          ]}
        />
        <Para>How we count: revenue, refund rate and ad return are all <Chip tone="good">Confirmed</Chip></Para>
      </Card>
    </Screen>
  );
}

function H3(): ReactNode {
  return (
    <Screen
      title="Sync needs attention"
      lead="One of Larkspur's connections stopped. Here is what is still safe to use and how to fix it."
      status={{ left: "Meta Ads · last synced 8 Nov", right: "1 connection needs you", tone: "bad", action: { label: "Sign in again" } }}
    >
      <Banner tone="bad">
        <strong>Meta sign-in expired on 9 Nov.</strong> No ad spend has arrived since. Shopify orders and Google Ads are not affected.
      </Banner>
      <Split>
        <Card title="What is still safe to use">
          <Checks
            items={[
              { ok: true, text: "Reports show spend up to 8 Nov", note: "Everything up to that day is complete" },
              { ok: true, text: "Shopify orders", note: "Synced today 06:00" },
              { ok: true, text: "Google Ads", note: "Synced today 06:03" },
              { ok: "warn", text: "Ad return for November", note: "Meta spend for 9 to 11 Nov is missing, so it reads too high" },
              { ok: false, text: "Meta Ads spend after 8 Nov", note: "Not available until you sign in again" },
            ]}
          />
          <Para>Signing in again takes about a minute. The missing days are filled straight afterwards and nothing already synced is lost.</Para>
          <Actions>
            <Primary>Sign in again</Primary>
            <Secondary>Send the client a sign-in link</Secondary>
          </Actions>
        </Card>
        <Card title="Affected" tone="warn">
          <Rows
            columns={["Where", "What", "State"]}
            rows={[
              ["October report", "Ad spend by channel", "Complete, October ended before the break"],
              ["October report", "Ad return this month", "Stops at 8 Nov"],
              ["Weekly numbers", "Monday send", "Held until fixed"],
            ]}
          />
          <Para>October report · 2 widgets. Nothing is sent to Larkspur with missing days unless you choose to.</Para>
          <Actions>
            <Secondary>Send anyway, marked to 8 Nov</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="What happened">
        <Timeline
          items={[
            { when: "8 Nov 06:02", text: "Meta Ads synced. 29 rows added.", tone: "good" },
            { when: "9 Nov 06:02", text: "Meta refused the sign-in. It expires every 60 days.", tone: "bad" },
            { when: "9 Nov 06:05", text: "Email sent to you: Meta Ads for Larkspur needs a new sign-in.", tone: "warn" },
            { when: "10 Nov 06:02", text: "Tried again. Still refused.", tone: "bad" },
            { when: "11 Nov 06:02", text: "Tried again. Still refused. Monday send of Weekly numbers held.", tone: "bad" },
          ]}
        />
      </Card>
    </Screen>
  );
}

function I1(): ReactNode {
  return (
    <Screen
      title="One business, no switcher"
      lead="You have one store, so there is nothing to switch between. The screen opens on your data."
      status={{ left: "48,210 rows · Synced 06:00", right: "All confirmed", tone: "good" }}
    >
      <Split>
        <Card title="Your data">
          <Rows
            columns={["Data", "Updated", "Rows#"]}
            rows={[
              ["Shopify orders", "Today 06:00", "48,210"],
              ["Meta Ads", "Today 06:02", "1,306"],
            ]}
          />
          <Actions>
            <Secondary>Connect more data</Secondary>
          </Actions>
        </Card>
        <Card title="Your reports">
          <Rows columns={["Report", "Sent", "To"]} rows={[["Weekly numbers", "Mondays 08:00", "You"]]} />
          <Actions>
            <Secondary>New report</Secondary>
          </Actions>
        </Card>
      </Split>
      <Split>
        <Card title="Shopify orders">
          <Rows
            columns={["Order", "Date", "Product", "Total#", "Status"]}
            rows={[
              ["#48210", "11 Nov", "Trail Flask", "84.00", "Paid"],
              ["#48209", "11 Nov", "Camp Mug", "36.50", "Paid"],
              ["#48208", "10 Nov", "Canvas Tote, Trail Flask", "152.00", "Paid"],
              ["#48207", "10 Nov", "Camp Mug", "24.00", "Refunded"],
              ["#48206", "10 Nov", "Wool Blanket", "97.50", "Paid"],
              ["#48205", "10 Nov", "Enamel Plate set", "61.00", "Paid"],
              ["#48204", "10 Nov", "Camp Mug", "36.50", "Paid"],
              ["#48203", "10 Nov", "Wool Blanket, Canvas Tote", "188.00", "Paid"],
            ]}
            caption="Example figures. Newest 8 of 48,210."
          />
        </Card>
        <Card title="Analyst">
          <Para>Ask in plain words. Answers use your confirmed ways of counting.</Para>
          <Options
            items={[
              { label: "How did last week go?" },
              { label: "Which products were refunded most?" },
              { label: "Is the ad spend paying for itself?" },
            ]}
          />
        </Card>
      </Split>
      <Banner tone="info">
        Agencies see a client switcher at the top of this screen. It appears for you only if you add a second business.
      </Banner>
    </Screen>
  );
}

function I2(): ReactNode {
  return (
    <Screen
      narrow
      title="What describes you"
      lead="One question, so the first screen you see fits the work you do."
      status={{ left: "Step 1 of 2" }}
    >
      <Steps items={["About you", "Bring in your data"]} at={0} />
      <Card title="What describes you?">
        <Options
          items={[
            { label: "I report for clients", note: "Starts with a client list and a monthly report to send" },
            { label: "I run a store", note: "Starts with Shopify and a weekly summary" },
            { label: "I manage social accounts", note: "Starts with Instagram, TikTok and LinkedIn and a social report" },
            { label: "I work in finance or operations", note: "Starts with accounting, billing and actuals against budget" },
            { label: "I look after a company's data", note: "Starts with a database sign-in and How we count" },
          ]}
          picked={1}
        />
        <Para>You can change this later. It only decides what is offered first; nothing is switched off.</Para>
        <Actions>
          <Primary>Continue</Primary>
          <Secondary>Skip</Secondary>
        </Actions>
      </Card>
      <Card title="What you will start with">
        <Checks
          items={[
            { ok: true, text: "Home tiles: sales, refunds and ad return for this week" },
            { ok: true, text: "A report ready to fill: Weekly numbers" },
            { ok: true, text: "Connections offered first: Shopify, Meta Ads, Google Ads" },
          ]}
        />
      </Card>
    </Screen>
  );
}

function I3(): ReactNode {
  return (
    <Screen
      title="How we count, simple view"
      lead="Every number in your reports is counted one agreed way. This is the whole list."
      status={{ left: "2 of 3 confirmed", right: "1 question", tone: "warn", action: { label: "Answer the question" } }}
    >
      <Banner tone="warn">
        <strong>Do test orders count?</strong> 14 orders this month were placed with a 100% staff discount code. 1 question is waiting for you.
      </Banner>
      <Split>
        <Card title="How we count">
          <Rows
            columns={["Number", "In plain words", "This month#", "Status"]}
            rows={[
              ["Revenue", "Paid orders only, after refunds, before tax and delivery", "510,535", "Confirmed"],
              ["Refund rate", "Refunded orders divided by paid orders", "6.1%", "Confirmed"],
              ["Orders", "Every order placed, waiting on the test order question", "4,218", "1 question"],
            ]}
            caption="Example figures"
          />
          <Para>Answer the question about orders</Para>
          <Options
            items={[
              { label: "Leave test orders out", note: "Orders this month: 4,204" },
              { label: "Count them like any other order", note: "Orders this month: 4,218" },
            ]}
          />
        </Card>
        <Card title="Revenue">
          <Para><strong>510,535 this month.</strong> <Chip tone="good">Confirmed</Chip></Para>
          <Para>Paid orders only. Refunds are taken off in the month the refund happened. Tax and delivery are left out.</Para>
          <Checks
            items={[
              { ok: true, text: "Confirmed by you on 2 Nov" },
              { ok: true, text: "Matches Shopify's own sales total for October" },
              { ok: true, text: "Used in Weekly numbers" },
            ]}
          />
          <Actions>
            <Secondary>This is wrong</Secondary>
          </Actions>
        </Card>
      </Split>
      <Banner tone="info">
        Changes waiting for review, checked answers and database sign-in appear here once there is something in them. Until then this list is all there is.
      </Banner>
    </Screen>
  );
}

function I5(): ReactNode {
  return (
    <Screen
      title="Social report, client view"
      lead="What Northwind Tea sees when they open the link: their own name, bigger type, the top posts shown."
      status={{ left: "Data to 31 Oct", right: "Confirmed", tone: "good" }}
    >
      <ClientPage
        brand="Northwind Tea"
        address="reports.samokoro.studio/northwind/october-social"
        title="October on social"
        footer="Prepared by Sam. Figures confirmed 2 Nov. Data to 31 Oct. Example figures."
      >
        <Stats
          items={[
            { value: "+1,240", label: "Followers", tone: "good" },
            { value: "4.8%", label: "Engagement" },
            { value: "38", label: "Posts" },
          ]}
        />
        <Card title="Top post: Autumn blend launch">
          <Para>
            A 24-second reel posted on 7 Oct. It reached 12.4k people, more than any post since spring, and brought in 310 of the month's new followers.
          </Para>
        </Card>
        <Card title="Top posts">
          <Rows
            columns={["Post", "Where", "Date", "Reach#", "Engagement#"]}
            rows={[
              ["Autumn blend launch", "Instagram reel", "7 Oct", "12.4k", "7.9%"],
              ["Brew guide: oolong in 3 steps", "Instagram reel", "15 Oct", "9.8k", "6.4%"],
              ["Giveaway: the tasting box", "Instagram post", "22 Oct", "7.1k", "9.2%"],
            ]}
          />
        </Card>
        <Card title="By account">
          <Rows
            columns={["Account", "Followers#", "New#", "Posts#", "Engagement#"]}
            rows={[
              ["Instagram", "18,460", "+890", 21, "5.6%"],
              ["TikTok", "6,930", "+290", 11, "4.1%"],
              ["LinkedIn", "2,110", "+60", 6, "2.9%"],
            ]}
          />
          <Para>Engagement is likes, comments, saves and shares divided by the people reached.</Para>
        </Card>
      </ClientPage>
    </Screen>
  );
}

function K1(): ReactNode {
  return (
    <Screen
      title="Your week, no grid"
      lead="Three numbers, what changed and why. Made to be read on a phone on Monday morning."
      status={{ left: "Synced 06:00", right: "Confirmed", tone: "good" }}
    >
      <Phone>
        <Para><strong>Sales up 8% on last week</strong></Para>
        <Para>Week of 2 to 8 Nov. Example figures.</Para>
        <Stats
          items={[
            { value: "41.2k", label: "Sales", tone: "good" },
            { value: "6.1%", label: "Refunds", tone: "warn" },
            { value: "3.4", label: "Ad return" },
          ]}
        />
        <Banner tone="warn">
          <strong>Refunds rose on Camp Mug.</strong> 19 refunded this week against 6 the week before.
        </Banner>
        <Card title="What changed">
          <Checks
            items={[
              { ok: true, text: "Sales 41.2k", note: "38.1k last week. Wool Blanket did most of it." },
              { ok: "warn", text: "Refunds 6.1%", note: "4.4% last week. Nearly all of the rise is Camp Mug." },
              { ok: true, text: "Ad return 3.4", note: "3.3 last week. 3.40 in sales for each 1 spent on ads." },
            ]}
          />
        </Card>
        <Actions>
          <Primary>Ask why</Primary>
          <Secondary>See last week</Secondary>
        </Actions>
      </Phone>
    </Screen>
  );
}

function K2(): ReactNode {
  return (
    <Screen
      title="Social accounts connected"
      lead="Northwind Tea's Instagram for October. Top posts are shown as posts, with the full list underneath."
      status={{ left: "38 posts · Synced 06:00", right: "Engagement rate confirmed", tone: "good" }}
    >
      <Card title="Northwind Tea's accounts">
        <Rows
          columns={["Account", "Name", "Last sync", "Posts in October#"]}
          rows={[
            ["Instagram", "@northwindtea", "Today 06:00", 21],
            ["TikTok", "@northwindtea", "Today 06:01", 11],
            ["LinkedIn", "Northwind Tea Co.", "Today 06:01", 6],
          ]}
          caption="Example figures"
        />
        <Actions>
          <Secondary>Connect another account</Secondary>
        </Actions>
      </Card>
      <Card title="Top posts · Instagram · October">
        <Split>
          <Card title="Autumn blend">
            <Para><strong>12.4k reach</strong> · Reel · 7 Oct</Para>
            <Para>"The autumn blend is here. Smoked black tea, orange peel, a little clove."</Para>
            <Para>980 likes · 64 comments · 212 saves</Para>
          </Card>
          <Card title="Brew guide">
            <Para><strong>9.8k reach</strong> · Reel · 15 Oct</Para>
            <Para>"Oolong in three steps. Water off the boil, ninety seconds, pour."</Para>
            <Para>627 likes · 31 comments · 340 saves</Para>
          </Card>
          <Card title="Giveaway">
            <Para><strong>7.1k reach</strong> · Post · 22 Oct</Para>
            <Para>"Win the tasting box. Tell us the first tea you remember drinking."</Para>
            <Para>653 likes · 412 comments · 38 saves</Para>
          </Card>
        </Split>
      </Card>
      <Split>
        <Card title="All posts">
          <Rows
            columns={["Post", "Format", "Date", "Reach#", "Engagement#"]}
            rows={[
              ["Autumn blend launch", "Reel", "7 Oct", "12.4k", "7.9%"],
              ["Brew guide: oolong in 3 steps", "Reel", "15 Oct", "9.8k", "6.4%"],
              ["Giveaway: the tasting box", "Post", "22 Oct", "7.1k", "9.2%"],
              ["Behind the counter", "Story", "3 Oct", "2.2k", "2.1%"],
              ["New tins have landed", "Post", "28 Oct", "1.9k", "3.8%"],
            ]}
            caption="Top 5 of 21 on Instagram"
          />
        </Card>
        <Card title="Analyst">
          <Chat
            turns={[
              { who: "you", text: "What worked in October?" },
              { who: "agent", text: "Reels drove 71% of reach from 8 of the 21 posts. The giveaway had the highest engagement, mostly comments." },
            ]}
          />
          <Actions>
            <Primary>Add to the October report</Primary>
          </Actions>
        </Card>
      </Split>
    </Screen>
  );
}

function K3(): ReactNode {
  return (
    <Screen
      title="Accounting and billing connected"
      lead="The ledger and the billing system arrive as tables every night, so actuals need no export."
      status={{ left: "2,104,330 rows · Synced 02:00", right: "Period closed 5 Nov", tone: "good" }}
    >
      <Stats
        items={[
          { value: "2,104,330", label: "Ledger entries" },
          { value: "2,104", label: "New in October", tone: "good" },
          { value: "5 Nov", label: "October closed", tone: "good" },
          { value: "02:00", label: "Last sync, today" },
        ]}
      />
      <Card title="Data">
        <Rows
          columns={["Data", "Comes from", "Last sync", "Rows#", "State"]}
          rows={[
            ["Ledger", "Accounting ledger", "Today 02:00", "2,104,330", "Closed to 31 Oct"],
            ["Billing", "Billing system", "Today 02:04", "186,420", "Up to date"],
            ["Budget FY26", "File, uploaded 14 Jan", "—", "1,152", "Does not change"],
          ]}
          caption="Example figures"
        />
      </Card>
      <Split>
        <Card title="Ledger">
          <Rows
            columns={["Date", "Account", "Description", "Department", "Debit#", "Credit#"]}
            rows={[
              ["31 Oct", "4000 Subscription revenue", "October invoices", "Sales", "", "412,880.00"],
              ["31 Oct", "1200 Receivables", "October invoices", "Sales", "412,880.00", ""],
              ["31 Oct", "6100 Salaries", "October payroll", "Engineering", "148,300.00", ""],
              ["31 Oct", "6100 Salaries", "October payroll", "Sales", "96,750.00", ""],
              ["30 Oct", "6400 Hosting", "Cloud invoice", "Engineering", "38,412.16", ""],
              ["30 Oct", "6520 Software", "Annual licence renewal", "Operations", "12,600.00", ""],
              ["29 Oct", "6300 Marketing", "Autumn campaign", "Marketing", "21,940.00", ""],
              ["29 Oct", "4900 Refunds", "Billing refunds, week 43", "Sales", "3,180.00", ""],
              ["28 Oct", "6700 Travel", "Customer visits", "Sales", "4,215.40", ""],
            ]}
            caption="Newest 9 entries in October"
          />
        </Card>
        <Card title="Analyst">
          <Chat
            turns={[
              { who: "agent", text: "October is closed. 2,104 new entries. Billing and the ledger agree on October revenue to within 0.1%." },
            ]}
          />
          <Options items={[{ label: "Actuals against budget" }, { label: "What changed after close last month?" }]} />
        </Card>
      </Split>
      <Card title="Variance · October actuals against Budget FY26">
        <Rows
          columns={["Line", "Actual#", "Budget#", "Difference#", "%#"]}
          rows={[
            ["Revenue", "412,880", "400,000", "+12,880", "+3.2%"],
            ["Salaries", "245,050", "240,000", "+5,050", "+2.1%"],
            ["Hosting", "38,412", "32,000", "+6,412", "+20.0%"],
            ["Marketing", "21,940", "25,000", "−3,060", "−12.2%"],
          ]}
        />
        <Banner tone="info">Closed months are not changed by a later sync. If the ledger alters one, it is flagged here first.</Banner>
      </Card>
    </Screen>
  );
}

function K9(): ReactNode {
  return (
    <Screen
      title="Sales system connected"
      lead="What moved since the last forecast call, down to the deals."
      status={{ left: "Synced 10 min ago", right: "Compared with Monday's call", tone: "warn" }}
    >
      <Banner tone="warn">
        <strong>Coverage 3.1× → 2.6× since Monday.</strong> Open pipeline for this quarter is now 2.6 times what is left to close.
      </Banner>
      <Stats
        items={[
          { value: "7", label: "Deals slipped", tone: "warn" },
          { value: "−410k", label: "Pipeline", tone: "bad" },
          { value: "2", label: "Reps" },
        ]}
      />
      <Split>
        <Card title="Forecast review">
          <Rows
            columns={["Rep", "Monday#", "Now#", "Change#", "Slipped#"]}
            rows={[
              ["D. Marchetti", "1,180k", "920k", "−260k", 4],
              ["K. Osei", "960k", "810k", "−150k", 3],
              ["L. Varga", "740k", "740k", "0", 0],
              ["Team", "2,880k", "2,470k", "−410k", 7],
            ]}
            caption="Example figures. Pipeline closing this quarter."
          />
          <Actions>
            <Secondary>Compare with another call</Secondary>
            <Secondary>Save this as the new starting point</Secondary>
          </Actions>
        </Card>
        <Card title="Slipped deals">
          <Rows
            columns={["Deal", "Amount#", "Moved to", "Owner"]}
            rows={[
              ["Atlas renewal", "120k", "Q1", "D. Marchetti"],
              ["Northwind", "90k", "Q1", "K. Osei"],
              ["Helio expansion", "70k", "Q1", "D. Marchetti"],
              ["4 smaller deals", "130k", "Q1", "Both"],
            ]}
          />
          <Para>Atlas renewal: the close date was moved on Wednesday with the note "legal review, signature in January".</Para>
          <Actions>
            <Secondary>Ask the owner</Secondary>
          </Actions>
        </Card>
      </Split>
      <Card title="Since Monday's call">
        <Timeline
          items={[
            { when: "Mon 09:00", text: "Forecast call. Pipeline saved at 2,880k, coverage 3.1×." },
            { when: "Tue 15:20", text: "K. Osei moved Northwind (90k) and 2 smaller deals to Q1.", tone: "warn" },
            { when: "Wed 11:05", text: "D. Marchetti moved Atlas renewal (120k) to Q1.", tone: "warn" },
            { when: "Thu 16:40", text: "D. Marchetti moved Helio expansion (70k) and 2 smaller deals to Q1.", tone: "warn" },
          ]}
        />
      </Card>
    </Screen>
  );
}

function K10(): ReactNode {
  return (
    <Screen
      title="Live checks and alerts"
      lead="Checked every minute. The alert goes to chat or a phone with the owner and the one action."
      status={{ left: "Checked 1 min ago", right: "Over limit", tone: "bad", action: { label: "Assign to Priya" } }}
    >
      <Phone>
        <Banner tone="bad">
          <strong>Returns queue 412. Limit 250.</strong>
        </Banner>
        <Para>Since Tue 09:40 · carrier file late</Para>
        <Stats
          items={[
            { value: "412", label: "In the queue now", tone: "bad" },
            { value: "250", label: "Limit" },
            { value: "Nobody yet", label: "Owner", tone: "warn" },
          ]}
        />
        <Actions>
          <Primary>Assign to Priya</Primary>
          <Secondary>Snooze 1 h</Secondary>
        </Actions>
        <Card title="How it got here">
          <Timeline
            items={[
              { when: "Tue 06:00", text: "Carrier file due. Not received.", tone: "warn" },
              { when: "Tue 09:40", text: "Queue passed 250. Alert sent to the operations channel.", tone: "bad" },
              { when: "Tue 10:40", text: "Queue 366. Nobody assigned, alert repeated.", tone: "bad" },
              { when: "Tue 11:12", text: "Queue 412 and still rising.", tone: "bad" },
            ]}
          />
        </Card>
        <Card title="This check">
          <Checks
            items={[
              { ok: true, text: "Returns waiting to be processed", note: "Checked every minute" },
              { ok: true, text: "Alert when above 250", note: "Sent once, then again each hour until assigned" },
              { ok: true, text: "Sent to the operations channel and Priya's phone" },
            ]}
          />
          <Para>Example figures.</Para>
        </Card>
      </Phone>
    </Screen>
  );
}

export const screens: Record<string, () => ReactNode> = { H1, H2, H3, I1, I2, I3, I5, K1, K2, K3, K9, K10 };
