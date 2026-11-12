# The walkthrough film: script

The whole app in one sitting, in the order a person would do it. One short card per step, every screen shown
whole before the camera moves. Silent, 130 seconds. Made after the analyst film was found confusing: it opened on
a result with no context and jumped between tools.

Truth notes: every screen is the real app, captured from the current build with 1,200 made-up orders. In step 4
the agent's sentences come from a scripted stand-in model; its query ran and the figures are the table's real
totals. The share link's local address is replaced with a made-up one. Nothing here is released yet, and the end
card says so.

| Step | Words on screen | Real screen |
|---|---|---|
| Open | One orders file. One sitting. / From signing in to a report your team can open. | card |
| 1 | Sign in | Log-in page, then the empty Home |
| 2 | Upload a file | Upload a file; the import preview; the sheet |
| 3 | Work in the spreadsheet / a formula, right beside the data | `=SUMIF(D:D,"paid",E:E)` gives 204240 |
| 4 | Ask a question / in plain words | "Which region brings in the most paid revenue?"; 204,240, East 57,880 first |
| 5 | Build a report | Add a card from a table; the report with three cards |
| 6 | Filter it / then check the rows behind a chart | Last 30 days: 33,404, down 701, "Filtered"; Open large; Rows behind it |
| 7 | Share it | Share, Invite, the invitation link |
| After | What the teammate sees | "Shared by Ana Okafor · view only", 204,240 |
| Close | Signed in. Uploaded. Asked. Checked. Shared. / One app, one sitting. | card |
| End | GridZero / In review. Not yet released. | end card |

The same number, 204,240, comes back four ways: the formula, the agent's query, the report card and the
teammate's view.
