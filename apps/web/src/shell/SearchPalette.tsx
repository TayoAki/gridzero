// Jump to any workbook, report, agent, source or page from the keyboard.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "../agents/catalog";
import { previewOn, PREVIEW_SCREENS } from "../preview/registry";

interface Hit {
  to: string;
  label: string;
  kind: string;
}

const PAGES: Hit[] = [
  { to: "/", label: "Workbooks", kind: "page" },
  { to: "/dashboards", label: "Reports", kind: "page" },
  { to: "/agents", label: "Agents", kind: "page" },
  { to: "/definitions", label: "How we count", kind: "page" },
  { to: "/apps", label: "Apps", kind: "page" },
  { to: "/settings/ai", label: "AI and spending", kind: "page" },
  { to: "/account", label: "Account", kind: "page" },
  { to: "/trash", label: "Trash", kind: "page" },
];

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Hit[]>(PAGES);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void Promise.all([
      api<{ workbooks: { id: string; title: string }[] }>("GET", "/api/v1/workbooks"),
      api<{ dashboards: { id: string; name: string }[] }>("GET", "/api/v1/dashboards"),
      api<{ agents: { id: string; name: string }[] }>("GET", "/api/v1/agents"),
    ]).then(([w, d, a]) =>
      setAll([
        ...(w.ok ? w.data.workbooks.map((x) => ({ to: `/workbook/${x.id}`, label: x.title, kind: "workbook" })) : []),
        ...(d.ok ? d.data.dashboards.map((x) => ({ to: `/dashboards/${x.id}`, label: x.name, kind: "report" })) : []),
        ...(a.ok ? a.data.agents.map((x) => ({ to: `/agents/${x.id}`, label: x.name, kind: "agent" })) : []),
        ...PAGES,
        ...(previewOn() ? PREVIEW_SCREENS.map((s) => ({ to: `/preview/${s.code}`, label: `${s.code} · ${s.title}`, kind: "planned" })) : []),
      ]),
    );
  }, []);

  const hits = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((h) => words.every((w) => h.label.toLowerCase().includes(w) || h.kind.includes(w))).slice(0, 12);
  }, [all, q]);
  useEffect(() => setAt(0), [q]);

  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    navigate(h.to);
  };

  return (
    <div className="gz-search-back" onMouseDown={onClose}>
      <div className="gz-search" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Search workbooks, reports, agents and pages"
          aria-label="Search"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") { e.preventDefault(); setAt((n) => Math.min(hits.length - 1, n + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt((n) => Math.max(0, n - 1)); }
            else if (e.key === "Enter") go(hits[at]);
          }}
        />
        <div className="gz-search-list" role="listbox">
          {hits.length === 0 ? <p className="gz-muted">Nothing matches "{q}".</p> : hits.map((h, i) => (
            <button key={h.to + i} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onMouseEnter={() => setAt(i)} onClick={() => go(h)}>
              <span>{h.label}</span>
              <small>{h.kind}</small>
            </button>
          ))}
        </div>
        <div className="gz-search-foot">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
