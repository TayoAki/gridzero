// The strip above a report's cards: the date range, compare with the period before, and a chip for
// every filter in force.

import { PRESETS, PRESET_NAMES, chosen, keyOf, periodDays } from "./slicing";
import type { Preset } from "./slicing";
import type { Report } from "./useReport";

const DAY = 86_400_000;

export function FilterBar({ report, stuck }: { report: Report; stuck: number }) {
  const { state, fields } = report;
  const dates = fields.filter((f) => f.type === "date");
  const picks = Object.entries(state.picks).filter(([, p]) => chosen(p));
  const period = state.period && dates.some((d) => keyOf(d.name) === keyOf(state.period!.field)) ? state.period : null;
  const days = periodDays(period);
  if (!dates.length && !picks.length) return null;
  const field = period?.field ?? dates[0]?.name ?? "";
  const length = days ? Math.round((Date.parse(days.to) - Date.parse(days.from)) / DAY) : 0;
  const span = dates.find((d) => keyOf(d.name) === keyOf(field))?.days;
  return (
    <div className="filter-bar" role="group" aria-label="Report filters">
      {dates.length > 0 && (
        <span className="filter-dates">
          <label>
            Dates
            <select aria-label="Date range" value={period?.preset ?? "all"} onChange={(e) => report.setPeriod(e.target.value === "all" ? null : { field, preset: e.target.value as Preset, from: period?.from ?? span?.[0], to: period?.to ?? span?.[1] })}>
              {PRESETS.map((p) => <option key={p} value={p}>{PRESET_NAMES[p]}</option>)}
            </select>
          </label>
          {dates.length > 1 && (
            <label>
              by
              <select aria-label="Date field" value={field} onChange={(e) => report.setPeriod(period ? { ...period, field: e.target.value } : { field: e.target.value, preset: "all" })}>
                {dates.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
            </label>
          )}
          {period?.preset === "custom" && (
            <>
              <input type="date" aria-label="From" value={period.from ?? ""} min={span?.[0]} max={span?.[1]} onChange={(e) => report.setPeriod({ ...period, from: e.target.value })} />
              <span>to</span>
              <input type="date" aria-label="To" value={period.to ?? ""} min={span?.[0]} max={span?.[1]} onChange={(e) => report.setPeriod({ ...period, to: e.target.value })} />
            </>
          )}
          {days && (
            <label className="filter-compare" title={`Figures show their change from the ${length} days before`}>
              <input type="checkbox" checked={state.compare} onChange={(e) => report.setCompare(e.target.checked)} /> Compare with the {length} days before
            </label>
          )}
          {span && !days && <span className="filter-span">Data runs {span[0]} to {span[1]}</span>}
        </span>
      )}
      {picks.map(([key, p]) => {
        const name = fields.find((f) => keyOf(f.name) === key)?.name ?? key;
        const text = p.range ? `${p.range[0].toLocaleString()} to ${p.range[1].toLocaleString()}` : p.values!.length > 3 ? `${p.values!.length} chosen` : p.values!.join(", ");
        return (
          <span key={key} className="filter-chip">
            {name}: {text}
            <button aria-label={`Remove the ${name} filter`} onClick={() => report.setPick(name, null)}>✕</button>
          </span>
        );
      })}
      {(picks.length > 0 || days) && <button className="link-button" onClick={report.clear}>Clear all</button>}
      {stuck > 0 && (picks.length > 0 || days) && (
        <span className="filter-note" title="A card an agent wrote as a snapshot, or one that reads a sheet range, has no rows underneath to filter.">
          {stuck} {stuck === 1 ? "card does" : "cards do"} not follow these filters
        </span>
      )}
    </div>
  );
}
