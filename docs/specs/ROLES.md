# Roles: what was built for whom, and what was not

Thirty-eight roles around a data platform were walked through the app. Three could finish their core task, twenty-three got part of the way and twelve found nothing. Ten building blocks were planned to close the gaps. This is where each stands.

Every "built" item below has an end-to-end test under `tests/e2e/step1.test.mjs` to `step6.test.mjs` and was driven once in a browser. None has been used by a real person in that role. The agent in those tests is a scripted stand-in.

## The ten blocks

| Block | Built | Not built |
|---|---|---|
| A. Used by | The panel for a workbook, table, field, source, definition, card or report; announcing a change to downstream owners | A drawn map of the whole estate. Use by name-matching in queries, so a renamed alias or a name in a comment can mislead. Nothing for cards on metric models or sheet ranges at field level |
| B. Activity and admin | The log, usage per report, query time and AI spending, the admin lists, "view as", the auditor role | Seats and licences (there are none), warehouse billing, groups, an admin who can change other people's access |
| C. Owners, targets, actions | Named owners, a target on a figure card, actions, decisions, escalation | A target line on charts, targets that change by period |
| D. Requests and issues | Requests with acceptance checks and sign-off, issues followed to verified | A public intake form, priorities, links from a request to affected people worked out for you |
| E. Snapshots and releases | Report snapshots by hand and weekly, then-and-now figures, releases gated on tests, a release webhook | Snapshots of a table's rows (pipeline history by record), named scenarios in a workbook, a close status on a period |
| F. Field controls | Sensitive marking with suggestions, hidden columns, a smallest-group rule, logged approvals | Masking (showing part of a value), rules by group of people, column rules on anything but a single SELECT over workbook tables |
| G. Monitoring and checks | Checks, late and failed data, notices on reports, webhooks | Checks on a database source that is not in a workbook, a quality scorecard over time |
| H. Builder depth | Looked-up table, several totals, custom column, two tables side by side, funnel, retention, tables to fill in, signed links | Experiment readouts with uncertainty, multi-touch attribution, writing entries back to a warehouse, an embed kit with theming |
| I. Model hooks | Personal tokens, the catalog, registered models with version notices | Notebooks, experiment tracking, model monitoring beyond a check you write |
| J. Links to other tools | Company sign-in over OpenID Connect (against a stand-in), a release webhook | Reading Power BI or Sigma, dbt or Git sync, warehouse billing, a CRM connector, user provisioning |

## The roles

"Finishes" means the role's journey can be walked end to end in the app. "Mostly" means it can, short of something in the "not built" column.

| Role | Now | What it leans on | Still missing |
|---|---|---|---|
| Data and analytics executive | Mostly | Run home, usage, cost, coverage | Warehouse cost; reliability over time |
| Business executive or sponsor | Mostly | Targets, decisions, actions, snapshots, emailed report | Targets by period; drivers worked out for them |
| Data product manager | Mostly | Requests with acceptance and sign-off, Used by | A public intake form; priorities |
| IT sourcing or vendor manager | Partly | Admin people list, usage | Licences and renewal dates do not exist here |
| Source-system administrator | Finishes | Used by on a field, announce a change | Works for workbook tables and sources; needs access to them |
| Data architect | Partly | Used by per thing | A drawn map |
| Data platform engineer | Mostly | Admin connections, view as, company sign-in | Compute and workspaces of the warehouse itself |
| Data engineer | Finishes | Late and failed data alerts naming reports, recovery notice | |
| DataOps / reliability engineer | Finishes | Inbox issue, notice on reports, note while fixing, recovery | |
| Analytics business analyst | Finishes | Request record with acceptance checks and sign-off | |
| Analytics engineer | Finishes | Change preview, releases gated on tests, catalog | dbt or Git sync |
| Power BI developer | Mostly | Used by a definition, releases | Reading Power BI itself |
| Sigma workbook builder | Mostly | Tables to fill in with approval | Writeback to the warehouse |
| BI platform administrator | Mostly | Admin, view as, access-change log | Other tools; changing access for others |
| Data analyst | Finishes | As before, plus Used by and the deeper builder | Search does not cover definitions |
| Analytics enablement lead | Mostly | Usage, idle people | Onboarding by role; common questions |
| BI quality assurance analyst | Finishes | Releases with checked answers and data checks, issues | Tests against another BI tool |
| Data governance lead | Mostly | Coverage, owners, issues by age | Sensitive-field coverage in the same view |
| Domain data owner | Finishes | Inbox, Used by, issues | |
| Data steward | Finishes | One edit with preview, issues to verified | |
| Data quality analyst | Finishes | Checks tied to a workbook and a definition, issues | Scorecard over time |
| Data security / identity engineer | Mostly | View as, hidden columns, smallest group, log | Masking; provisioning |
| Data privacy delivery lead | Finishes | Sensitive fields, where used, logged approvals | |
| Internal audit analytics specialist | Finishes | Auditor role, snapshots, log | |
| Data platform FinOps specialist | Partly | Query time and AI spending by owner | Warehouse billing, budgets |
| FP&A analyst or manager | Mostly | Actual against plan, snapshots, drill to rows | Named scenarios |
| Revenue operations analyst | Mostly | Confirmed definition, weekly snapshot, actions | CRM connector; history by record |
| Marketing analytics lead | Mostly | Looked-up table, checks for gaps | Multi-touch attribution |
| Product analyst | Mostly | Funnel, retention | Experiment readouts |
| Supply chain analyst | Finishes | A check as the exception list, actions | |
| People analytics analyst | Finishes | Sensitive fields, hidden columns, smallest group, row limits | |
| Customer success operations | Finishes | Table to fill in beside accounts, actions | |
| Functional manager / KPI owner | Finishes | Targets, alerts, actions, Decide home | |
| Frontline team lead | Mostly | Row-limited report, table to fill in, phone layout | A purpose-built daily queue |
| Controller / accounting lead | Mostly | Trusted number, snapshot, release | A close status on a period |
| Data scientist | Partly | Tokens, catalog with versions, read-only query | Notebooks, experiment tracking |
| Machine learning engineer | Partly | Registered model, version notices, a check | Model monitoring |
| Embedded analytics engineer | Mostly | Signed links with rows and hidden columns, isolation tests | Theming, an embed kit |

Fifteen finish, eighteen mostly, five partly. That is a judgement made from scripted runs, not from watching people.
