// Planned screens for an agency that reports to many clients: switching client, reusing and sending
// reports, and the monthly run that needs no hands. Sample content only; nothing here is connected.

import type { ReactNode } from "react";

import type { Status } from "../../shell/context";
import { Actions, Banner, Card, Chat, Checks, Chip, ClientPage, Options, Para, Primary, Rows, Screen, Secondary, Split, Stats, Steps, Timeline } from "../ui";

const headline = [
  { value: "510,535", label: "Revenue" },
  { value: "8.9%", label: "Refund rate" },
  { value: "5,410", label: "Orders" },
];

const channelColumns = ["Channel", "Spend#", "Revenue#", "Orders#", "Return on spend#"];
const channelRows: (string | number)[][] = [
  ["Google Ads", "41,200", "214,400", "2,265", "5.2"],
  ["Meta Ads", "38,900", "163,400", "1,720", "4.2"],
  ["Email", "2,100", "86,800", "930", "41.3"],
  ["TikTok Ads", "12,400", "24,500", "262", "2.0"],
  ["Direct and other", "0", "21,435", "233", "-"],
];

const monthColumns = ["Measure", "September#", "October#", "Change#"];
const monthRows: (string | number)[][] = [
  ["Revenue", "472,718", "510,535", "+8%"],
  ["Orders", "5,062", "5,410", "+7%"],
  ["Average order", "93.39", "94.37", "+1%"],
  ["Refund rate", "7.4%", "8.9%", "+1.5 pts"],
];

const status: Record<string, Status> = {
  G1: { left: "8 clients", right: "2 reports due this week", tone: "warn" },
  G2: { left: "From Larkspur · October", right: "1 thing to check first", tone: "warn" },
  G3: { left: "Updated 4 min ago", right: "All confirmed", tone: "good", action: { label: "Send" } },
  G4: { left: "Data to 31 Oct", right: "Confirmed by Brightside", tone: "good" },
  G5: { left: "Monthly · 3rd", right: "Next send 3 Dec", tone: "good" },
  L1: { left: "Ran 3 Nov 09:00", right: "6 sent · 2 held for you", tone: "warn" },
  L2: { left: "Data to 28 Oct", right: "Held · not sent to client", tone: "bad" },
  L3: { left: "Draft · edited by you 0 times", right: "All figures confirmed", tone: "good" },
  L4: { left: "Step 3 of 3", right: "1 question left", tone: "busy" },
  L5: { left: "Data to 31 Oct", right: "Confirmed by Brightside", tone: "good" },
  L6: { left: "Data to 31 Oct", right: "Answers use confirmed numbers only", tone: "good" },
  L7: { left: "Since you started: 61 reports", right: "Example data" },
};

function G1(): ReactNode {
  return (
    <Screen title="Switch client" lead="Every workbook, report and counting rule belongs to one client. Pick a client and everything on screen changes to theirs." status={status.G1}>
      <Stats items={[
        { value: "8", label: "Clients" },
        { value: "2", label: "Reports due this week", tone: "warn" },
        { value: "5", label: "Sent for October", tone: "good" },
        { value: "1", label: "Being set up" },
      ]} />
      <Banner tone="warn">2 reports due this week: Northwind Tea is due today and Atlas Cycles is due Friday.</Banner>
      <Card title="Your clients">
        <Rows
          caption="Example figures. You are looking at Larkspur."
          columns={["Client", "October report", "Numbers", "Data up to", "Looked after by"]}
          rows={[
            ["Larkspur (open now)", "Sent 3 Nov", "All confirmed", "31 Oct", "Dana"],
            ["Northwind Tea", "Due today", "1 unconfirmed", "31 Oct", "Dana"],
            ["Atlas Cycles", "Due Fri", "All confirmed", "31 Oct", "Priya"],
            ["Juniper Home", "Being set up", "1 question left", "31 Oct", "Dana"],
            ["Harbour Candle Co.", "Sent 3 Nov", "All confirmed", "31 Oct", "Priya"],
            ["Pine & Pebble", "Sent 3 Nov", "All confirmed", "31 Oct", "Marco"],
            ["Tidewater Swim", "Sent 4 Nov", "All confirmed", "31 Oct", "Marco"],
            ["Oakhurst Pets", "Sent 3 Nov", "All confirmed", "31 Oct", "Priya"],
          ]}
        />
        <Actions>
          <Primary>Open Northwind Tea</Primary>
          <Secondary>New client</Secondary>
          <Secondary>Show all clients together</Secondary>
        </Actions>
      </Card>
      <Split>
        <Card title="What changes when you switch">
          <Checks items={[
            { ok: true, text: "Workbooks and data", note: "Only that client's files and connected accounts" },
            { ok: true, text: "Reports", note: "Their monthly reports, drafts and what was sent" },
            { ok: true, text: "How we count", note: "Their own rules, such as what counts as revenue" },
            { ok: true, text: "The analyst", note: "Answers questions about that client only" },
          ]} />
        </Card>
        <Card title="Suggested next">
          <Options items={[
            { label: "Start Northwind's report", note: "Due today · reuse Larkspur's layout" },
            { label: "Check Atlas Cycles before Friday", note: "All numbers confirmed" },
            { label: "Finish setting up Juniper Home", note: "1 question left" },
          ]} />
        </Card>
      </Split>
    </Screen>
  );
}

function G2(): ReactNode {
  return (
    <Screen title="Reuse a report" lead="Copy a report onto another client or the next month. The layout and counting rules come along; the numbers are worked out fresh from that client's own data." status={status.G2}>
      <Banner tone="warn">1 thing to check first: Northwind Tea has no refunds column, so the refund rate cannot be worked out yet.</Banner>
      <Split>
        <Card title="Reuse Larkspur's report">
          <Para>Copying <strong>Larkspur · October report</strong>. Choose where it goes.</Para>
          <Options picked={0} items={[
            { label: "For Northwind Tea · October", note: "Another client, same month" },
            { label: "For Larkspur · November", note: "Same client, next month" },
            { label: "For several clients at once", note: "Pick from your 8 clients" },
          ]} />
          <Para>6 widgets and 7 counting rules come along. Nothing from Larkspur's data is copied.</Para>
          <Actions>
            <Primary>Create report</Primary>
            <Secondary>Cancel</Secondary>
          </Actions>
        </Card>
        <Card title="What to check" tone="warn">
          <Checks items={[
            { ok: true, text: "Store data is connected", note: "Northwind Tea · orders up to 31 Oct" },
            { ok: true, text: "Ad accounts are connected", note: "Google Ads and Meta Ads" },
            { ok: "warn", text: "Northwind has no refunds column", note: "Point us to where refunds are kept, or leave the refund widget out" },
            { ok: "warn", text: "1 rule needs an answer", note: "Does Northwind count subscription renewals as new orders?" },
          ]} />
        </Card>
      </Split>
      <Card title="What comes along">
        <Rows
          columns={["Widget", "Counting rule it uses", "For Northwind Tea"]}
          rows={[
            ["Revenue", "Revenue · paid orders only", "Ready"],
            ["Orders", "Orders · excludes cancelled", "Needs an answer"],
            ["Refund rate", "Refund rate · refunds over paid orders", "No refunds column"],
            ["Revenue by channel", "Channel · last click", "Ready"],
            ["Ad spend and return", "Return on spend · revenue over spend", "Ready"],
            ["Top products", "Product revenue · before discounts", "Ready"],
          ]}
        />
        <Para>The seventh rule, average order value, is used by the revenue widget.</Para>
      </Card>
    </Screen>
  );
}

function G3(): ReactNode {
  return (
    <Screen title="Send the report" lead="Larkspur · October report is finished. Choose how the client gets it." status={status.G3}>
      <Stats items={headline} />
      <Split>
        <Card title="Send to Larkspur">
          <Options picked={2} items={[
            { label: "Link", note: "A private page the client can open any time" },
            { label: "PDF", note: "8 pages, with Larkspur's logo on each" },
            { label: "Email", note: "A short note with the link and the PDF attached" },
          ]} />
          <Rows
            columns={["Goes to", "Role", "Gets"]}
            rows={[
              ["Maya Chen · maya@larkspur.example", "Client contact", "Email with link and PDF"],
              ["Tom Reyes · tom@larkspur.example", "Copied in", "Email with link"],
            ]}
          />
          <Para><strong>Subject:</strong> Larkspur · October performance</Para>
          <Para><strong>Note:</strong> Hi Maya, October's report is ready. Revenue rose 8% to 510,535. Happy to talk it through on Thursday. Dana</Para>
          <Actions>
            <Primary>Send</Primary>
            <Secondary>See what the client sees</Secondary>
            <Secondary>Download PDF</Secondary>
          </Actions>
        </Card>
        <Card title="Before you send" tone="good">
          <Checks items={[
            { ok: true, text: "All numbers confirmed", note: "7 of 7 counting rules confirmed by Brightside" },
            { ok: true, text: "Data from 31 Oct", note: "The whole month is in" },
            { ok: true, text: "Nothing looks out of line", note: "Largest change on September is +8%" },
            { ok: true, text: "Logo: Larkspur", note: "Shown at the top of the page and the PDF" },
            { ok: true, text: "Sent from Brightside", note: "reports@brightside.co" },
          ]} />
        </Card>
      </Split>
      <Card title="Sent before">
        <Timeline items={[
          { when: "3 Oct", text: "September report emailed to Maya Chen. Opened the same day.", tone: "good" },
          { when: "3 Sep", text: "August report emailed to Maya Chen. Opened 4 Sep.", tone: "good" },
        ]} />
      </Card>
    </Screen>
  );
}

function G4(): ReactNode {
  return (
    <Screen title="What the client sees" lead="A clean page the client can only read. It carries their logo, none of our controls, and a line saying who confirmed the numbers." status={status.G4}>
      <ClientPage brand="Larkspur" address="Larkspur · October report" title="October performance" footer="Prepared by Dana, Brightside Agency. Numbers confirmed 3 Nov. Data to 31 Oct.">
        <Stats items={headline} />
        <Para>Revenue rose 8% on September, led by Google Ads. The refund rate rose to 8.9%; 41 refunds came from one Camp Mug batch.</Para>
        <Rows caption="October against September" columns={monthColumns} rows={monthRows} />
        <Rows caption="Where revenue came from" columns={channelColumns} rows={channelRows} />
        <Rows
          caption="Top products"
          columns={["Product", "Units#", "Revenue#", "Refunds#"]}
          rows={[
            ["Trail Flask 750", "1,840", "64,400", "38"],
            ["Camp Mug", "2,310", "41,580", "96"],
            ["Ridge Tote", "905", "38,010", "22"],
            ["Field Blanket", "410", "32,390", "19"],
          ]}
        />
      </ClientPage>
      <Card title="What is left out of the client's page">
        <Checks items={[
          { ok: true, text: "No editing, no menus, no sign-in to our product" },
          { ok: true, text: "No unconfirmed numbers", note: "A number that is not confirmed is never shown to a client" },
          { ok: true, text: "No other client's data", note: "The link opens Larkspur's October report and nothing else" },
        ]} />
        <Actions>
          <Secondary>Back to the report</Secondary>
          <Secondary>Copy link</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

function G5(): ReactNode {
  return (
    <Screen title="Send it every month" lead="Set it once. The report rebuilds from fresh data and sends itself, but only when every number is confirmed." status={status.G5}>
      <Banner tone="warn">Held back if any number is unconfirmed. You are told straight away, and nothing goes to the client until you say so.</Banner>
      <Split>
        <Card title="Send on the 3rd of each month">
          <Options picked={0} items={[
            { label: "The 3rd of each month, 9:00", note: "Covers the month before" },
            { label: "The first working day, 9:00", note: "Data may still be arriving" },
            { label: "Another day", note: "Pick a day and time" },
          ]} />
          <Para><strong>To:</strong> client contact at Larkspur (Maya Chen), with Tom Reyes copied in.</Para>
          <Para><strong>As:</strong> email with the link and the PDF attached.</Para>
          <Para><strong>If the 3rd is a weekend:</strong> send on the Monday after.</Para>
          <Actions>
            <Primary>Save schedule</Primary>
            <Secondary>Pause</Secondary>
          </Actions>
        </Card>
        <Card title="Next send" tone="good">
          <Stats items={[
            { value: "3 Dec, 9:00", label: "Next send" },
            { value: "3 Nov", label: "Last sent", tone: "good" },
          ]} />
          <Para>The November report will cover 1 to 30 November.</Para>
        </Card>
      </Split>
      <Split>
        <Card title="It sends only when">
          <Checks items={[
            { ok: true, text: "Every number in the report is confirmed" },
            { ok: true, text: "Data covers the whole month" },
            { ok: true, text: "No number has moved by more than 40% without a reason" },
          ]} />
        </Card>
        <Card title="If it is held back">
          <Checks items={[
            { ok: true, text: "Tell Dana by email and in the app" },
            { ok: true, text: "Say what is wrong and offer the fix" },
            { ok: false, text: "Never send a part-finished report to the client" },
          ]} />
        </Card>
      </Split>
      <Card title="Past sends">
        <Timeline items={[
          { when: "3 Nov", text: "October report sent at 9:00.", tone: "good" },
          { when: "3 Oct", text: "September report sent at 9:00.", tone: "good" },
          { when: "4 Sep", text: "August report held for one day: refund rule was unconfirmed. Sent after Dana confirmed it.", tone: "warn" },
        ]} />
      </Card>
    </Screen>
  );
}

function L1(): ReactNode {
  return (
    <Screen title="The monthly run, untouched" lead="Data came in, every client's report rebuilt and sent on schedule. This is the one summary you need to read." status={status.L1}>
      <Stats items={[
        { value: "8", label: "Reports" },
        { value: "6", label: "Sent", tone: "good" },
        { value: "2", label: "Held for you", tone: "warn" },
        { value: "0 h", label: "Hands-on this month" },
      ]} />
      <Banner tone="warn">Northwind Tea · held. Revenue is down 61% on September because three days of store data are missing.</Banner>
      <Banner tone="warn">Juniper Home · held. One counting rule is unconfirmed: are gift cards revenue?</Banner>
      <Card title="November run · October reports">
        <Rows
          caption="Example figures"
          columns={["Client", "What happened", "When", "Data up to", "Numbers"]}
          rows={[
            ["Larkspur", "Sent", "3 Nov 09:00", "31 Oct", "All confirmed"],
            ["Atlas Cycles", "Sent", "3 Nov 09:00", "31 Oct", "All confirmed"],
            ["Harbour Candle Co.", "Sent", "3 Nov 09:00", "31 Oct", "All confirmed"],
            ["Pine & Pebble", "Sent", "3 Nov 09:00", "31 Oct", "All confirmed"],
            ["Tidewater Swim", "Sent", "3 Nov 09:01", "31 Oct", "All confirmed"],
            ["Oakhurst Pets", "Sent", "3 Nov 09:01", "31 Oct", "All confirmed"],
            ["Northwind Tea", "Held", "3 Nov 09:00", "28 Oct", "Looks wrong"],
            ["Juniper Home", "Held", "3 Nov 09:00", "31 Oct", "1 unconfirmed"],
          ]}
        />
        <Actions>
          <Primary>Look at Northwind Tea</Primary>
          <Secondary>Look at Juniper Home</Secondary>
          <Secondary>Download run summary</Secondary>
        </Actions>
      </Card>
      <Split>
        <Card title="How the run went">
          <Timeline items={[
            { when: "3 Nov 06:00", text: "Store and ad data brought in for 8 clients. Northwind Tea's store stopped at 28 Oct.", tone: "warn" },
            { when: "3 Nov 08:30", text: "8 reports rebuilt with October's numbers." },
            { when: "3 Nov 08:45", text: "Each report checked. 2 held back." , tone: "warn" },
            { when: "3 Nov 09:00", text: "6 reports sent to clients.", tone: "good" },
            { when: "3 Nov 09:02", text: "Summary sent to Dana." },
          ]} />
        </Card>
        <Card title="This month">
          <Checks items={[
            { ok: true, text: "0 hours hands-on", note: "Nobody had to build or send a report" },
            { ok: "warn", text: "2 need a look", note: "Each has a reason and a suggested fix" },
            { ok: true, text: "5 of 6 sent reports opened", note: "Pine & Pebble has not opened theirs yet" },
          ]} />
        </Card>
      </Split>
    </Screen>
  );
}

function L2(): ReactNode {
  return (
    <Screen title="Held back, with the reason" lead="Northwind Tea · October report was due on 3 Nov. It looked wrong, so it did not go to the client." status={status.L2}>
      <Banner tone="bad">Held: revenue is down 61% on September.</Banner>
      <Split>
        <Card title="What we found" tone="bad">
          <Para><strong>Cause:</strong> the store sync stopped on 28 Oct. Three days are missing (29, 30 and 31 Oct).</Para>
          <Para>Those three days included Northwind's autumn sale, which is why the drop looks so large. Ad spend is complete, so return on spend looks worse than it was.</Para>
          <Actions>
            <Primary>Sync again, then send</Primary>
            <Secondary>Send as it is</Secondary>
            <Secondary>Tell the client it is late</Secondary>
          </Actions>
          <Para>Sending as it is adds a line to the report saying data ends on 28 Oct.</Para>
        </Card>
        <Card title="Why it was held">
          <Checks items={[
            { ok: false, text: "Change larger than 40%", note: "Revenue is 61% below September" },
            { ok: false, text: "Data ends before month end", note: "Store data stops at 28 Oct" },
            { ok: true, text: "All numbers confirmed", note: "The counting rules are fine" },
            { ok: true, text: "Ad data is complete", note: "Google Ads and Meta Ads to 31 Oct" },
          ]} />
        </Card>
      </Split>
      <Card title="The numbers as they stand">
        <Rows
          caption="Example figures. October is missing three days."
          columns={["Measure", "September#", "October so far#", "Change#"]}
          rows={[
            ["Revenue", "182,400", "71,136", "-61%"],
            ["Orders", "3,910", "1,540", "-61%"],
            ["Ad spend", "24,300", "25,100", "+3%"],
            ["Days of store data", "30", "28", "3 missing"],
          ]}
        />
      </Card>
      <Card title="What happened">
        <Timeline items={[
          { when: "28 Oct 23:10", text: "Northwind's store asked us to sign in again. Sync stopped.", tone: "bad" },
          { when: "3 Nov 08:45", text: "Report checked before sending. Two checks failed.", tone: "warn" },
          { when: "3 Nov 09:00", text: "Report held. Nothing was sent to Northwind Tea." },
          { when: "3 Nov 09:02", text: "Dana told by email and in the app." },
        ]} />
      </Card>
    </Screen>
  );
}

function L3(): ReactNode {
  return (
    <Screen title="Commentary drafted in your voice" lead="The written summary for Larkspur · October, drafted for you. It uses confirmed numbers only and learns from the edits you make." status={status.L3}>
      <Split>
        <Card title="What happened in October">
          <Para>Revenue rose 8% to 510,535, led by Google Ads, which brought in 214,400 at a return of 5.2.</Para>
          <Para>Refunds rose to 8.9%; 41 came from one Camp Mug batch in week 2. Without that batch the rate would be close to September's.</Para>
          <Para>Next month: move 10% of spend from TikTok to Google Ads, where each pound spent returned more than twice as much.</Para>
          <Actions>
            <Primary>Add to report</Primary>
            <Secondary>Edit</Secondary>
            <Secondary>Draft again</Secondary>
          </Actions>
        </Card>
        <Card title="About this draft" tone="good">
          <Checks items={[
            { ok: true, text: "Every figure is confirmed", note: "6 figures, each from a confirmed counting rule" },
            { ok: true, text: "Tone learned from your last 6 reports", note: "Short sentences, one recommendation at the end" },
            { ok: true, text: "Nothing is guessed", note: "If a cause is not in the data, the draft does not name one" },
          ]} />
          <Para>Change the draft:</Para>
          <Options items={[
            { label: "Shorter", note: "Three sentences" },
            { label: "More on ads", note: "Adds Meta Ads and TikTok" },
            { label: "Plainer", note: "For a client who is new to the numbers" },
          ]} />
        </Card>
      </Split>
      <Card title="Where each figure comes from">
        <Rows
          columns={["In the draft", "Figure#", "Counting rule", "Status"]}
          rows={[
            ["Revenue", "510,535", "Revenue · paid orders only", "Confirmed"],
            ["Rise on September", "+8%", "Revenue · paid orders only", "Confirmed"],
            ["Google Ads revenue", "214,400", "Channel · last click", "Confirmed"],
            ["Refund rate", "8.9%", "Refund rate · refunds over paid orders", "Confirmed"],
            ["Camp Mug batch refunds", "41", "Refunds by product and week", "Confirmed"],
            ["TikTok return on spend", "2.0", "Return on spend · revenue over spend", "Confirmed"],
          ]}
        />
      </Card>
      <Card title="What it has learned from you">
        <Para>
          <Chip tone="good">Leads with revenue</Chip> <Chip tone="good">Names the product behind a change</Chip> <Chip tone="good">Ends with one next step</Chip> <Chip>Avoids "significant"</Chip>
        </Para>
        <Para>Edited by you 0 times on this draft. Each edit you make is kept and shapes the next one.</Para>
      </Card>
    </Screen>
  );
}

function L4(): ReactNode {
  return (
    <Screen title="A new client in minutes" lead="New client · Juniper Home. Their accounts are connected and a report is picked. The counting rules from similar clients are proposed, and only the differences are asked." status={status.L4}>
      <Steps items={["Connect", "Report", "Rules"]} at={2} />
      <Split>
        <Card title="6 of 7 rules match Larkspur">
          <Checks items={[
            { ok: true, text: "Revenue · paid orders only" },
            { ok: true, text: "Refund rate", note: "Refunds over paid orders" },
            { ok: true, text: "Orders", note: "Excludes cancelled" },
            { ok: true, text: "Average order value" },
            { ok: true, text: "Channel", note: "Last click" },
            { ok: true, text: "Return on spend", note: "Revenue over spend" },
            { ok: "warn", text: "Gift cards", note: "Larkspur does not sell them, so there is no rule to copy" },
          ]} />
        </Card>
        <Card title="One question" tone="warn">
          <Banner tone="warn">Juniper sells gift cards. Count them as revenue?</Banner>
          <Options items={[
            { label: "No", note: "October revenue 88,410" },
            { label: "Yes", note: "October revenue 96,020" },
          ]} />
          <Para>Most shops count a gift card when it is spent, not when it is bought. That is the "No" answer.</Para>
          <Actions>
            <Primary>Confirm and finish</Primary>
            <Secondary>Ask Juniper Home</Secondary>
          </Actions>
        </Card>
      </Split>
      <Split>
        <Card title="Already done">
          <Rows
            columns={["Step", "What", "State"]}
            rows={[
              ["1 Connect", "Shopify store", "Connected · orders from Jan 2024"],
              ["1 Connect", "Google Ads", "Connected"],
              ["1 Connect", "Meta Ads", "Connected"],
              ["2 Report", "Monthly performance, copied from Larkspur", "6 widgets"],
            ]}
          />
        </Card>
        <Card title="Then">
          <Timeline items={[
            { when: "Today", text: "October report built for you to look over. It is not sent." },
            { when: "3 Dec", text: "First report sends to Juniper Home.", tone: "good" },
          ]} />
        </Card>
      </Split>
    </Screen>
  );
}

function L5(): ReactNode {
  return (
    <Screen title="Under the agency's own name" lead="Your logo, your web address and your email sender. The client never sees Grid Zero." status={status.L5}>
      <ClientPage brand="Brightside" address="reports.brightside.co · Larkspur" title="Brightside · October performance" footer="Prepared by Brightside Agency. Sent from reports@brightside.co. Data to 31 Oct.">
        <Stats items={headline} />
        <Rows caption="Where revenue came from" columns={channelColumns} rows={channelRows.slice(0, 3)} />
      </ClientPage>
      <Split>
        <Card title="Your name on everything">
          <Rows
            columns={["Setting", "Value", "State"]}
            rows={[
              ["Agency name", "Brightside Agency", "Saved"],
              ["Logo", "brightside-logo.svg", "Saved"],
              ["Colour", "Brightside orange", "Saved"],
              ["Web address", "reports.brightside.co", "Working"],
              ["Emails come from", "reports@brightside.co", "Working"],
              ["Each client's own logo", "On for 6 of 8 clients", "Saved"],
            ]}
          />
          <Actions>
            <Primary>Save</Primary>
            <Secondary>Send myself a test email</Secondary>
          </Actions>
        </Card>
        <Card title="Checked for you" tone="good">
          <Checks items={[
            { ok: true, text: "Web address points to your reports", note: "Checked today" },
            { ok: true, text: "Emails from your address will not land in junk", note: "Your domain has approved us to send" },
            { ok: true, text: "Our name is not on the page, the PDF or the email" },
            { ok: "warn", text: "2 clients have no logo yet", note: "Juniper Home and Tidewater Swim show your logo only" },
          ]} />
        </Card>
      </Split>
    </Screen>
  );
}

function L6(): ReactNode {
  return (
    <Screen title="The client asks, the report answers" lead="A follow-up question typed on the report page is answered from confirmed numbers only, so it does not land in your inbox." status={status.L6}>
      <ClientPage brand="Brightside" address="reports.brightside.co · Larkspur" title="Brightside · October performance" footer="Answered from confirmed figures. Brightside can see this question. Data to 31 Oct.">
        <Stats items={headline} />
        <Rows
          caption="Refunds by week"
          columns={["Week", "Orders#", "Refunds#", "Refund rate#"]}
          rows={[
            ["1 to 7 Oct", "1,190", "92", "7.7%"],
            ["8 to 14 Oct", "1,260", "141", "11.2%"],
            ["15 to 21 Oct", "1,240", "97", "7.8%"],
          ]}
        />
        <Card title="Ask about this report">
          <Chat turns={[
            { who: "you", text: "Why did refunds go up?" },
            { who: "agent", text: "41 refunds came from one Camp Mug batch in week 2. Without that batch, the refund rate for October would be about 8.1%." },
          ]} />
          <Actions>
            <Secondary>Which products were refunded most?</Secondary>
            <Secondary>Ask Brightside instead</Secondary>
          </Actions>
        </Card>
      </ClientPage>
      <Split>
        <Card title="What the page will and will not answer">
          <Checks items={[
            { ok: true, text: "Questions the confirmed numbers can answer", note: "Each answer shows the figures it used" },
            { ok: true, text: "Only this client's report", note: "Larkspur cannot ask about anyone else" },
            { ok: false, text: "Guesses, forecasts or advice", note: "Passed to you instead, and the client is told" },
            { ok: false, text: "Anything using an unconfirmed number" },
          ]} />
        </Card>
        <Card title="What you see">
          <Rows
            columns={["Asked by", "Question", "What happened"]}
            rows={[
              ["Maya Chen", "Why did refunds go up?", "Answered on the page"],
              ["Maya Chen", "Which channel grew most?", "Answered on the page"],
              ["Tom Reyes", "Should we raise the TikTok budget?", "Passed to Dana"],
            ]}
          />
        </Card>
      </Split>
    </Screen>
  );
}

function L7(): ReactNode {
  return (
    <Screen title="Time saved, shown" lead="What the monthly run did for Brightside, on your home page. Figures shown are examples." status={status.L7}>
      <Banner tone="info">Example figures. "Before" is the time you told us reporting took when you started.</Banner>
      <Card title="November · example figures">
        <Stats items={[
          { value: "8", label: "Reports sent", tone: "good" },
          { value: "0 h", label: "Hands-on", tone: "good" },
          { value: "14 h", label: "Before" },
        ]} />
        <Para>2 reports were held and fixed before sending.</Para>
      </Card>
      <Split>
        <Card title="Clients asked">
          <Checks items={[
            { ok: true, text: "11 questions answered on the page", note: "From confirmed numbers, without reaching your inbox" },
            { ok: "warn", text: "1 passed to you", note: "Larkspur asked about the TikTok budget" },
          ]} />
          <Actions><Secondary>See the questions</Secondary></Actions>
        </Card>
        <Card title="Caught before the client saw it">
          <Checks items={[
            { ok: true, text: "Northwind Tea", note: "Three days of store data were missing. Synced again, sent 3 Nov 14:20." },
            { ok: true, text: "Juniper Home", note: "Gift card rule confirmed, sent 4 Nov." },
          ]} />
        </Card>
      </Split>
      <Card title="Month by month">
        <Rows
          caption="Example figures"
          columns={["Month", "Reports sent#", "Held and fixed#", "Hands-on hours#", "Hours before#"]}
          rows={[
            ["November", 8, 2, "0", "14"],
            ["October", 7, 1, "1", "12"],
            ["September", 7, 1, "2", "12"],
            ["August", 7, 3, "4", "12"],
          ]}
        />
        <Para>Since you started: 61 reports.</Para>
        <Actions>
          <Secondary>Download as PDF</Secondary>
          <Secondary>Change the "before" figure</Secondary>
        </Actions>
      </Card>
    </Screen>
  );
}

export const screens: Record<string, () => ReactNode> = { G1, G2, G3, G4, G5, L1, L2, L3, L4, L5, L6, L7 };
