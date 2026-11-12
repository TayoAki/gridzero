// A report opened from its view link, by someone who may not have an account. They see the cards
// and can filter them; nothing can be changed, and the queries behind the cards are not sent.
// Also the page that accepts an invitation to a report.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { FilterBar } from "./FilterBar";
import { TabStrip, onTab, placed } from "./ReportGrid";
import type { ReportTab } from "./ReportGrid";
import { SlicerCard } from "./Slicer";
import { fieldNamed, keyOf } from "./slicing";
import type { Widget } from "./spec";
import { useReport } from "./useReport";
import { WidgetBody, WidgetFrame } from "./WidgetView";

export function PublicReportPage() {
  const { token = "" } = useParams();
  const [report, setReport] = useState<{ name: string; tabs?: ReportTab[]; widgets: Widget[] } | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/v1/public/reports/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (res.ok) setReport(body);
        else setError(body?.error ?? "This report could not be opened.");
      })
      .catch(() => live && setError("This report could not be opened."));
    return () => {
      live = false;
    };
  }, [token]);
  useEffect(() => {
    if (report) document.title = `${report.name} · GridZero`;
  }, [report]);
  const base = `/api/v1/public/reports/${encodeURIComponent(token)}`;
  const filters = useReport(`public:${token}`, report?.widgets ?? null, { fields: `${base}/fields`, view: (id) => `${base}/widgets/${id}/view` });
  const tabs = report?.tabs ?? [];
  const widgets = onTab(report?.widgets ?? [], tabs, tab);
  const spots = placed(widgets);

  return (
    <div className="public-report">
      <header className="public-head">
        <strong>{report?.name ?? "Report"}</strong>
        <span className="chat-head-spacer" />
        <span>Shared from GridZero · view only</span>
      </header>
      {error ? (
        <p className="error" role="alert">{error}</p>
      ) : report === null ? (
        <div className="gz-skel"><span /><span /><span /></div>
      ) : widgets.length === 0 ? (
        <p className="present-empty">This report has no cards yet.</p>
      ) : (
        <>
          <TabStrip tabs={tabs} current={tab} onPick={setTab} />
          <FilterBar report={filters} stuck={widgets.filter((w) => w.data.kind !== "slicer" && filters.show(w).how === "none").length} />
          <div className="widget-grid public-grid">
            {widgets.map((w) => {
              const at = spots.find((p) => p.id === w.id)!;
              const shown = filters.show(w);
              return (
                <div key={w.id} className="widget-slot" style={{ gridColumn: `${at.x + 1} / span ${at.w}`, gridRow: `${at.y + 1} / span ${at.h}` }}>
                  {w.data.kind === "slicer" ? (
                    <SlicerCard title={w.title} style={w.data.style} field={fieldNamed(filters.fields, w.data.field)} pick={filters.state.picks[keyOf(w.data.field)]} onPick={(p) => filters.setPick((w.data as { field: string }).field, p)} />
                  ) : (
                    <WidgetFrame title={w.title} theme={w.theme} size={w.size} foot={<span>{shown.busy ? "Filtering…" : shown.how === "live" || shown.how === "card" ? "Filtered" : `As of ${new Date(w.refreshedAt).toLocaleDateString()}`}</span>}>
                      {shown.data ? <WidgetBody form={w.form} theme={w.theme} size={at.h === 1 && w.data.kind !== "number" ? "s" : w.size} data={shown.data} title={w.title} onPick={filters.clickFilter(w)} options={w.options} /> : <p className="widget-nothing">Nothing matches the filters.</p>}
                    </WidgetFrame>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Accept an invitation to a report, then open it. */
export function ReportInvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // StrictMode runs effects twice in development; accepting twice is harmless but shows a flash.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch(`/api/v1/report-invites/${encodeURIComponent(token ?? "")}/accept`, { method: "POST", credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (res.ok) navigate(`/dashboards/${body.dashboardId}`, { replace: true });
        else setError(body?.error ?? "This invitation could not be opened.");
      })
      .catch(() => setError("This invitation could not be opened."));
  }, [token]);
  return (
    <main className="invite-page">
      {error ? <p role="alert">{error} <Link to="/">Go home</Link></p> : <p>Opening the report…</p>}
    </main>
  );
}
