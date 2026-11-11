# Reports: review of the BI research and design, and what changed

A review of the November 2026 research and design pack ("GridZero: BI research, competitive comparison and dashboard
UI design") against the product as it now stands, followed by what was built from it and what is still open.

## Where the pack is right

- **Answer first, show the source, ask then pin.** These three principles fit the product and are now visible on every
  report card.
- **The three P0 gaps are the right three**: a filter bar, sharing, and digests. Each needs the backend, and none is
  built.
- **Delivery beats display.** It matches what the agency persona asked for in the UI plan: a report nobody can send is
  not a report.

## Where it needs correcting

- **The scores are self-assessed.** "Level with Power BI at 4.05" comes from a matrix the pack's own caveats call a
  judgement, with nothing tested hands-on. Use the matrix to find gaps, not as a claim.
- **The navigation it proposes is superseded.** The pack groups pages in a 232 px sidebar. The shell that shipped has a
  rail, a list, tabs, the agent panel and a bottom bar; reports sit inside it.
- **It predates How we count.** The pack grounds numbers in uploaded metric models only. Widgets can now follow a
  confirmed definition or a query over a workbook table, so the filter bar and the "why" line must work for those too.
- **The "why" line needs a rule.** A sentence written by an agent at refresh is a claim. It should be built only from
  confirmed numbers, say so, and be left off when the change is small or the number is unconfirmed.
- **AI keys.** The pack says "your own Anthropic key". The product also takes an OpenRouter key and can include AI.

## Built from it now (no backend change)

| From the pack | What a person sees |
|---|---|
| Show the source (principle 3) | Every card has a footer saying where its number comes from: How we count, a metric, a query over a workbook table, a sheet range, or a snapshot that does not update |
| Stale state | A card whose refresh failed, or a live card nobody has refreshed for a day and a half, turns amber, keeps its last value, says why and offers "Try again" |
| One place for trust | The bottom bar says how many widgets the report has, how old the oldest refresh is, and how many need a look |
| Refresh | "Refresh all" runs the live widgets one after the other |
| Present mode (REQ-10) | "Present" opens the report full window in dark, large type, with no controls; it reloads every minute, refreshes live widgets every fifteen, and Escape goes back |
| Ask, then pin (principle 4) | An empty report offers three questions that open the agent panel, in place of a link to another page |
| Calm colour, readable charts | Chart axes follow the theme and use fewer gridlines; the page says "report" throughout |

## Still open, in the pack's own order

| Item | Needs |
|---|---|
| REQ-01 Filter bar | A `filters` column on the report; merged into metric, definition and table-query widgets at refresh |
| REQ-02 Sharing | The workbook sharing model applied to reports; ties in with the client page in the UI plan |
| REQ-03 Digests | A schedule kind that renders a report to email or chat |
| REQ-04 "Why" line | The rule above, then a field on number data filled at refresh |
| REQ-05 Alerts | Thresholds on a widget, checked by the scheduler |
| REQ-09 Comparison series | A second query with shifted dates; drawn dashed |
| Goals on a number | A target stored with the widget |

Not done here and not in the pack: a headline row that keeps number cards together at the top. Order is still the
person's own drag order.

## Added after the review: Prism BI's chart builder

Prism BI is a browser BI tool by the same author. Its chart builder (a query result in, an ECharts option out, for
some 25 chart types) now draws every widget chart. What came across:

| From Prism | In GridZero |
|---|---|
| `lib/charts.ts`, `lib/format.ts` | `apps/web/src/widgets/prism/`, with colours taken from the page's theme and animation off |
| Chart types | Eight new widget forms: bars across, pie, donut, funnel, treemap, waterfall (from a series); stacked bars and heatmap (from a table) |
| Compact number formats (112K, 1.2M) | Axis and bar labels |

Not brought across, and why:

- **The query engine, the plain-English parser and file upload.** GridZero's numbers come from its own queries, run as
  the person asking and grounded in confirmed definitions. A second engine in the browser would be a second answer.
- **Cross-filtering and click-to-drill.** They depend on the filter bar (REQ-01), which needs the backend.
  can draw them; widget data cannot yet describe them. They are registered and ready.

## Added next: the rest of the chart types, and the grid

- **Nine more forms**, so every chart the builder draws can be a widget: gauge (from a number); radar and histogram
  (from a series); bars with a line, scatter, bubble, sunburst, flow (sankey) and box plot (from a table).
- **A rule for what fits.** `fits(form, data)` in `widgets/spec.ts` says which columns each form needs: a scatter needs
  two number columns, a flow two label columns and a number, a box plot a label and five numbers. The server applies
  it when an agent proposes a widget, when an agent refreshes one, and when a person changes a card's form; the card
  menu uses it to list only forms that fit.
- **Agents know when to use each.** The tool description says what each form is for (ranking, share, steps, what made
  up a change, two measures together, flow, spread, one rate) and to shape the data for the form.
- **The drag-and-resize grid** from Prism's dashboards (react-grid-layout): each card keeps `{x, y, w, h}` on a
  12-column grid. Cards nobody has placed flow in their old order, and a chart starts two rows tall.

## Added after Prism's second version: slicers, focus mode and Excel

Prism's next version added Power BI-style slicers, a focus mode, Excel export, multi-sheet import and a light theme.

- **Slicers** are ported as cards on the report grid (`widgets/Slicer.tsx`, `widgets/slicing.ts`): buttons, a tick
  list, a dropdown, and a from-to range for number columns. A slicer is a widget row with form `slicer` whose data is
  `{ field, style }`, added with `POST /api/v1/dashboards/:id/slicers`. The fields offered are the report's table
  columns and what each series is split by, read from its title.
- **The difference from Prism.** Prism holds the whole dataset in the browser and re-runs every query when a slicer
  changes. GridZero cards hold results, so a slicer filters the rows and points already on a card. Cards that hold one
  figure cannot follow, and the page says so. Re-running a card's query with the slicer applied is the server-side
  filter bar in `BACKEND-NEEDS.md`, still to do.
- **Focus mode** is "Open large" in a card's menu: the card at full size, its rows on request, and an Excel download.
- **Excel export** writes one sheet per card with a summary sheet first (`widgets/excel.ts`, using `write-excel-file`,
  loaded only when asked for).
- **Not ported:** the light theme (GridZero has its own light and dark themes) and multi-sheet import (GridZero's
  importer is its own).

## Closing the gaps against the leading tools (November 2026)

A comparison with Power BI, Tableau, Looker, Metabase, Sigma and Row Zero listed seven gaps. What was built for each:

| Gap | Built | Still open |
|---|---|---|
| 1. Filters that re-run the query | Report filters are applied to the workbook tables under a card before its query runs (`definitions/tables.ts`, `services/semantic/tables.py`), so totals follow. Works for cards on workbook tables, definitions on a workbook, and metric models | Definitions on a database source and sheet-range cards are filtered on the card only |
| 2. Cross-filtering and drill-down | Clicking a bar or slice filters the rest of the report; "Rows behind it" shows the rows a card was worked out from, with their count and totals | Drilling down a hierarchy (year to month to day) in place |
| 3. Sharing and permissions | Viewer and editor invitations, a view link without sign-in, cards always run as the owner | Per-person row limits; embedding in another site |
| 4. Scheduled delivery and alerts | A report emailed on a schedule; alerts on a figure card, told once per crossing, in the app and by email | Charts or a PDF in the email; Slack or webhook delivery |
| 5. Live connectors | A file at a web address, synced on a schedule, beside the five warehouse connectors | Connectors that sign in to a vendor (ad platforms, Shopify, CRMs): each needs that vendor's developer account and review |
| 6. A chart without the agent | "Add a card": table, total, split, chart | Calculated columns and joins in the builder |
| 7. Comparisons and time | A report date range with presets; a figure's change from the period before; trend line, forecast and unusual-point flags on a card | Targets and reference lines; a second series for the period before on a chart |

From the third version of Prism BI: the analytics overlays (`widgets/prism/analytics.ts`) and the drill-through totals are ported. Its Model tab's idea, suggesting links between tables from matching keys, is what the scan's modelling step already does and now settles by itself. Not ported: maps (bundled geometry), the in-browser SQL tab (GridZero queries tables on the server), and its single-workspace server (GridZero has its own accounts, sharing and schedules).
