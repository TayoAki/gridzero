# Tutorial films: what other tools do, the scripts, and the screens

## What the study found

| Source | How their tutorial runs | What we took |
|---|---|---|
| Row Zero's "Tutorial for Spreadsheet Users" and docs | Import a file, check the preview and options, land in a data table, pivot and chart, then Share | Start at the import, show the preview with "Data table" chosen, end on something shared or reported |
| Guides to Julius | Upload, ask a broad question, then narrow; it suggests follow-ups; charts on request | Ask in plain words first; let the product raise the follow-up that matters |
| An Omni code-along and a Sigma walkthrough | Warehouse, then a shared model, then AI querying through that model, then a dashboard and usage | For the database persona: connect, model, confirm, then ask through the confirmed model |
| Onboarding-video guides (mostly from video vendors) | 60 to 90 seconds, the outcome in the first 10 seconds, the first click by about 25 seconds, one goal per video | Open on the finished result, numbered steps, one goal each, under 90 seconds |

The video-length guidance comes from vendors with something to sell, so treat it as a rule of thumb.

## Where ours differs, and so what each script is built around

Every tool above goes from data to an answer. None of the tutorials stops to ask what the number should count. GridZero's
own step is the middle one: it notices what would change the number, asks with the figure each choice gives, and only
then calls the number confirmed. Both scripts put that step in the middle.

## Tutorial 1: Dana, agency reporting lead (84 s)

Goal: from an orders export to a number you can stand behind.

| Step | On-screen words | Real screen filmed |
|---|---|---|
| Open | From an orders export to a number you can stand behind. | The report with 510,535 on it |
| 1 | Add your data | Home, "Upload a file"; the import preview with "Data table"; the table in the grid |
| 2 | Ask a question | The agent panel: "What was revenue by source?", its answer and the "Unconfirmed" label |
| 3 | Decide what counts | How we count, Questions: "Which status values count", leave out 590 orders gives 510,535 |
| 4 | Confirm it | How we count: Total gross sales, Confirm, check number 510,535 |
| 5 | Ask again | The agent: 510,535, confirmed by Dana Reyes; "Mark as correct" |
| 6 | Put it on a report | The widget proposal, "Add to dashboard", the report |

## Tutorial 2: Priya, analytics engineer (77 s)

Goal: from a database to numbers the company has confirmed.

| Step | On-screen words | Real screen filmed |
|---|---|---|
| Open | From a database to numbers your company has confirmed. | The agent's confirmed answer |
| 1 | Connect your database | How we count: new workspace; "Add a Postgres source" |
| 2 | Sign in as yourself. Every query runs with your own access. | The source's own sign-in form |
| 3 | Scan | The estimate (3 tables, about 12,294 rows), Scan, "10 definitions, 6 questions" |
| 4 | Settle what the data cannot | "Two ways to work out order count" (12,000 or 4); "Stores marked test" (1.18M or 1.31M) |
| 5 | Confirm | revenue, Confirm, check number 1,184,760 |
| 6 | Ask | The agent: revenue 1,184,760, confirmed by Priya Shah |

## Truth notes

- Every screen is the real product, captured while it ran on this machine from the code now merged to master.
- The numbers are real: they come from the product's own queries over the sample file (6,000 orders) and a sample
  database (12,000 orders).
- The agent's wording is staged. No model key was available, so a stand-in model returned sentences written in
  advance. The tool calls it made, and the numbers they returned, are real.
- The database address shown (db.northfield.example) is made up; the capture used a local database.
- Postgres is the only database that can be scanned today. The close of tutorial 2 says so.
- Silent. No music or narration, so nothing to license.
