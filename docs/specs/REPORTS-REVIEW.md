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
- **The drag-and-resize grid.** Reports keep their small, medium and large cards for now.
- **The other chart types** (scatter, bubble, radar, gauge, box plot, sankey, sunburst, combo, histogram). The builder
  can draw them; widget data cannot yet describe them. They are registered and ready.
