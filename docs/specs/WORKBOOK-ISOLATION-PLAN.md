# Plan: give each workbook its own machine

Status: plan for review, 2026-11-11. Nothing here is built.

## Why

Today every open workbook is a thread inside one workbook-host program (`crates/wbhost`), on one
machine, with its files on that machine's disk. So:

- one heavy workbook can slow down or crash everyone's;
- all open workbooks together must fit in one machine's memory;
- a big workbook cannot be given a bigger machine;
- customers share one program's memory, which is a weaker boundary than separate machines.

## What already helps

- The browser never assumes where a workbook lives. `POST /workbooks/:id/open` returns the address to
  connect to, with a short-lived token. Changing that address per workbook needs no browser change.
- The host already loads a workbook on first use, saves it, and unloads it when idle.
- Each workbook is already a self-contained unit inside the host (its own thread and mailbox).

## What is in the way

| Gap | Where |
|---|---|
| Workbook files live on the host's own disk. A second machine cannot open them. | `crates/storage` (its own comment says cloud storage "replaces this backend"; it was never done) |
| The control service assumes one host address. | `env.wbhostUrl`, used in 5 places: `app.ts`, `sharing.ts`, `connected.ts`, `agents/host.ts`, `agents/workbook-tools.ts` |
| Nothing records which machine a workbook is on, or starts and stops machines. | Not built |
| Staging runs on Railway, which deploys fixed services. It is not made for starting a machine per workbook on demand. | Hosting |

## My recommendation: dedicated machines above a size, shared host below it

A machine per workbook for every workbook is the simplest rule, but most workbooks are small. Giving
each a machine means a wait of seconds on every open and a cost per open workbook. So:

- **Small workbooks stay on shared hosts** (as today, but several hosts instead of one).
- **A workbook gets its own machine** when it is above a size (say 1 GB of table data), on a paid
  plan that includes it, or flagged by us.
- Both paths use the same routing, so "every workbook gets its own" is a setting, not a rebuild, if
  you prefer that.

## Steps

### 1. Move workbook files to cloud storage
- Snapshots, the edit log and table files go to S3-compatible storage, laid out as the build spec
  already describes (§4.3). The local disk becomes a cache.
- The edit log is still written to local disk before an edit is acknowledged, and shipped to storage
  every few seconds. If a machine dies, the last few seconds of edits can be lost. Today that
  window is zero only because there is one disk; this is the trade to accept or to narrow.
- Done when: a workbook edited on one host opens correctly on a second host, and the existing
  "no acknowledged edit lost on a crash" test still passes on a single host.

### 2. Record where each workbook is, and route to it
- New table: workbook id, machine address, state (starting, running, stopping), size, last seen.
  One row per workbook, so two people opening at once always land on the same machine.
- One function, `hostFor(workbookId)`, replaces the fixed address in the 5 places above.
- Done when: two shared hosts run side by side and every existing test passes without knowing
  which host it hit. This also delivers the "4-host" target the README lists as missing.

### 3. Start and stop machines
- A small interface with `start(workbook, size)`, `stop(machine)` and `list()`, with two
  implementations: a local one that starts a process (development and tests) and one for the cloud
  provider.
- The host program gets a single-workbook mode: it serves one workbook, refuses any other, and
  exits after saving once it has been idle.
- Opening a workbook that needs its own machine: start it, wait until it reports ready, return its
  address. The page shows "Opening…" meanwhile.
- A sweeper stops machines that stopped reporting, and frees their rows.
- Done when: a test opens a dedicated workbook, edits it, lets it go idle, sees the machine stop,
  reopens it on a new machine and finds every edit.

### 4. Choose the machine's size, and move a workbook that outgrows it
- Size comes from the stored size of the workbook's tables, with headroom, capped by the plan.
- When an import or a refresh would not fit: save, start a bigger machine, switch the address,
  and have open browsers reconnect (the page already reconnects when its connection drops).
- Done when: importing a file too big for the current machine moves the workbook and finishes,
  with other users reconnected and no edits lost.

### 5. Things that wake a workbook without a person
- Scheduled refreshes, agents and dashboard widgets all call the host. Each would now start a
  machine. Rules: run them on the shared pool when the workbook is small; for dedicated workbooks,
  batch a workbook's due jobs into one start, and cap starts per hour.
- Done when: a nightly schedule for 50 workbooks starts each machine once, not once per job.

### 6. Limits and cost
- Per plan: largest machine, how many dedicated workbooks may be open at once, idle time before stop.
- Track machine-seconds per workspace so the cost is visible before prices are set.

### 7. Afterwards, separately: tables bigger than memory
- A dedicated machine still loads whole tables into memory. Reaching hundreds of millions of rows
  needs tables read from disk in parts. That is its own project and only makes sense after step 4.

## Order and size

Steps 1 and 2 are the foundation and are worth doing even if nothing else follows: they remove the
single machine as a limit and a single point of failure. Step 3 is where a cloud provider is chosen.
Rough effort, as a guess: steps 1 and 2 about two to three weeks, step 3 two weeks, steps 4 to 6
two to three weeks.

## Decisions I need from you

1. **Every workbook, or only large and paid ones?** I recommend only large and paid ones.
2. **Where machines run.** Railway cannot start machines per workbook. The build spec chose AWS.
   A service that starts small virtual machines on demand in a second or two and bills by the
   second (Fly.io Machines is one) would be less to operate. I have not checked current prices or
   limits for any of them; that is the first task of step 3.
3. **How many seconds of edits may be lost if a machine dies.** Shorter means more writes to
   storage. I suggest 5 seconds, as the build spec did.
4. **Does this come before or after the SaaS and definitions work** for the Shopify and agency
   customers? Their data is small, so they do not need it for scale. They do benefit from steps 1
   and 2 (no single point of failure, customers not sharing one disk).
