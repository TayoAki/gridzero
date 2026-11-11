// The frame every signed-in page sits in: rail, sidebar, tabs, main, right panel, bottom bar.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { api } from "../agents/catalog";
import { authClient } from "../auth-client";
import { previewOn, PREVIEW_GROUPS } from "../preview/registry";
import { AgentPanel } from "./AgentPanel";
import { ShellContext } from "./context";
import type { ShellApi, Status } from "./context";
import { Icon } from "./icons";
import { SearchPalette } from "./SearchPalette";

type Section = "home" | "reports" | "agents" | "count" | "apps" | "settings" | "preview";

function sectionOf(path: string): Section {
  if (path.startsWith("/dashboards")) return "reports";
  if (path.startsWith("/agents")) return "agents";
  if (path.startsWith("/definitions") || path.startsWith("/metrics")) return "count";
  if (path.startsWith("/apps")) return "apps";
  if (path.startsWith("/settings") || path.startsWith("/account")) return "settings";
  if (path.startsWith("/preview")) return "preview";
  return "home";
}

const DEFAULT_TITLES: [RegExp, string][] = [
  [/^\/$/, "Home"],
  [/^\/trash/, "Trash"],
  [/^\/workbook\//, "Workbook"],
  [/^\/dashboards/, "Report"],
  [/^\/agents\/.+/, "Agent"],
  [/^\/agents/, "Agents"],
  [/^\/definitions/, "How we count"],
  [/^\/metrics/, "Metric models"],
  [/^\/apps/, "Apps"],
  [/^\/settings\/ai/, "AI settings"],
  [/^\/account/, "Account"],
  [/^\/preview/, "Preview"],
];
const defaultTitle = (path: string) => DEFAULT_TITLES.find(([re]) => re.test(path))?.[1] ?? "Page";

interface Tab {
  path: string;
  title: string;
}

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows may refuse; the shell works without it.
  }
}

type Theme = "system" | "light" | "dark";
export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

interface Listed {
  to: string;
  label: string;
  note?: string;
}

/** The list for the section you are in. */
function useSidebar(section: Section, tick: number): { heading: string; items: Listed[] | null; action?: { label: string; run: () => Promise<string | null> } } {
  const [items, setItems] = useState<Listed[] | null>(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    const done = (rows: Listed[]) => live && setItems(rows);
    if (section === "home")
      api<{ workbooks: { id: string; title: string; role: string; owner: string }[] }>("GET", "/api/v1/workbooks").then((r) => done((r.ok ? r.data.workbooks : []).map((w) => ({ to: `/workbook/${w.id}`, label: w.title, note: w.role === "owner" ? undefined : `Shared by ${w.owner}` }))));
    else if (section === "reports") api<{ dashboards: { id: string; name: string; owner: string | null }[] }>("GET", "/api/v1/dashboards").then((r) => done((r.ok ? r.data.dashboards : []).map((d) => ({ to: `/dashboards/${d.id}`, label: d.owner ? `${d.name} (from ${d.owner})` : d.name }))));
    else if (section === "agents") api<{ agents: { id: string; name: string }[] }>("GET", "/api/v1/agents").then((r) => done((r.ok ? r.data.agents : []).map((a) => ({ to: `/agents/${a.id}`, label: a.name }))));
    else if (section === "count")
      api<{ workspaces: { id: string; name: string }[] }>("GET", "/api/v1/workspaces").then(async (r) => {
        const rows: Listed[] = [];
        for (const w of (r.ok ? r.data.workspaces : []).slice(0, 6)) {
          const s = await api<{ sources: { id: string; name: string }[] }>("GET", `/api/v1/workspaces/${w.id}/sources`);
          for (const src of s.ok ? s.data.sources : []) rows.push({ to: `/definitions/${src.id}`, label: src.name, note: w.name });
        }
        done([...rows, { to: "/metrics", label: "Metric models" }]);
      });
    else if (section === "apps") done([{ to: "/apps", label: "Connected apps" }]);
    else if (section === "settings") done([{ to: "/settings/ai", label: "AI and spending" }, { to: "/account", label: "Account" }, { to: "/trash", label: "Trash" }]);
    else done(PREVIEW_GROUPS.map((g) => ({ to: `/preview#${g.code}`, label: `${g.code} · ${g.name}`, note: `${g.screens.length} screens` })));
    return () => {
      live = false;
    };
  }, [section, tick]);
  const heading = { home: "Workbooks", reports: "Reports", agents: "Agents", count: "Data", apps: "Apps", settings: "Settings", preview: "Preview" }[section];
  const action =
    section === "home"
      ? { label: "New workbook", run: async () => { const r = await api<{ id: string }>("POST", "/api/v1/workbooks"); return r.ok ? `/workbook/${r.data.id}` : null; } }
      : undefined;
  return { heading, items, action };
}

interface Notice {
  to: string;
  text: string;
  /** A second line, and whether it is new since the bell was last opened. */
  detail?: string;
  fresh?: boolean;
}

async function loadNotices(): Promise<Notice[]> {
  const out: Notice[] = [];
  // Alerts that fired and reports shared with you come first, newest at the top.
  const told = await api<{ notifications: { title: string; body: string; link: string | null; read: boolean }[] }>("GET", "/api/v1/notifications");
  for (const n of (told.ok ? told.data.notifications : []).slice(0, 8)) out.push({ to: n.link ?? "/", text: n.title, detail: n.body, fresh: !n.read });
  if (out.some((n) => n.fresh)) void api("POST", "/api/v1/notifications/read", {});
  const ws = await api<{ workspaces: { id: string }[] }>("GET", "/api/v1/workspaces");
  for (const w of (ws.ok ? ws.data.workspaces : []).slice(0, 4)) {
    const s = await api<{ sources: { id: string; name: string }[] }>("GET", `/api/v1/workspaces/${w.id}/sources`);
    for (const src of (s.ok ? s.data.sources : []).slice(0, 6)) {
      const r = await api<{ me: string; questions: { status: string; assigneeId: string | null }[]; changes: unknown[] }>("GET", `/api/v1/sources/${src.id}/review`);
      if (!r.ok) continue;
      const open = r.data.questions.filter((q) => q.status === "open");
      const mine = open.filter((q) => q.assigneeId === r.data.me).length;
      if (mine) out.push({ to: `/definitions/${src.id}`, text: `${mine} ${mine === 1 ? "question" : "questions"} passed to you in ${src.name}` });
      else if (open.length) out.push({ to: `/definitions/${src.id}`, text: `${open.length} open ${open.length === 1 ? "question" : "questions"} in ${src.name}` });
      if (r.data.changes.length) out.push({ to: `/definitions/${src.id}`, text: `${r.data.changes.length} ${r.data.changes.length === 1 ? "change is" : "changes are"} waiting to be published in ${src.name}` });
    }
  }
  return out;
}

export function Shell({ email }: { email: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const section = sectionOf(pathname);

  const [tabs, setTabs] = useState<Tab[]>(() => stored<Tab[]>("gz_tabs", []));
  // Names pages give their own tabs. Kept apart from the tab list: a page names itself before the shell has added its tab.
  const [titles, setTitles] = useState<Record<string, string>>(() => stored<Record<string, string>>("gz_titles", {}));
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [panels, setPanels] = useState<Record<string, { title: string; body: ReactNode }>>({});
  const [sideOpen, setSideOpen] = useState(() => stored("gz_side", true));
  const [rightOpen, setRightOpen] = useState(() => stored("gz_right", true));
  const [theme, setTheme] = useState<Theme>(() => stored<Theme>("gz_theme", "system"));
  const [searching, setSearching] = useState(false);
  const [popover, setPopover] = useState<"bell" | "settings" | null>(null);
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const look = () => api<{ unread: number }>("GET", "/api/v1/notifications").then((r) => r.ok && setUnread(r.data.unread));
    void look();
    const timer = window.setInterval(look, 120_000);
    return () => window.clearInterval(timer);
  }, []);
  const [tick, setTick] = useState(0);
  const railRef = useRef<HTMLElement>(null);

  // Every page you visit is a tab, named by the page once it knows its own name.
  useEffect(() => {
    setTabs((prev) => {
      // "/dashboards" only redirects to a report, so it never gets a tab of its own.
      if (pathname === "/dashboards" || prev.some((t) => t.path === pathname)) return prev;
      return [...prev, { path: pathname, title: defaultTitle(pathname) }].slice(-8);
    });
    setTick((n) => n + 1);
    setPopover(null);
  }, [pathname]);
  useEffect(() => store("gz_tabs", tabs), [tabs]);
  useEffect(() => store("gz_titles", Object.fromEntries(tabs.filter((t) => titles[t.path]).map((t) => [t.path, titles[t.path]]))), [tabs, titles]);
  useEffect(() => store("gz_side", sideOpen), [sideOpen]);
  useEffect(() => store("gz_right", rightOpen), [rightOpen]);
  useEffect(() => {
    store("gz_theme", theme);
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching((v) => !v);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setRightOpen((v) => !v);
      } else if (e.key === "Escape") setPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shell = useMemo<ShellApi>(
    () => ({
      setStatus: (owner, status) => setStatuses((prev) => { const next = { ...prev }; if (status) next[owner] = status; else delete next[owner]; return next; }),
      setTitle: (path, title) => setTitles((prev) => (prev[path] === title ? prev : { ...prev, [path]: title })),
      setPanel: (owner, panel) => setPanels((prev) => { const next = { ...prev }; if (panel) next[owner] = panel; else delete next[owner]; return next; }),
      openAgent: () => setRightOpen(true),
    }),
    [],
  );

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (path === pathname) navigate(next[next.length - 1]?.path ?? "/");
        return next;
      });
    },
    [navigate, pathname],
  );

  const side = useSidebar(section, tick);
  const status = Object.values(statuses).at(-1) ?? null;
  const panel = Object.values(panels).at(-1) ?? null;
  const titleOf = (path: string) => titles[path] ?? defaultTitle(path);
  const title = titleOf(pathname);
  // The chat page is already the agent, so the panel would only repeat it.
  const rightShown = rightOpen && !/^\/agents\/.+/.test(pathname);
  const looking =
    /^\/workbook\/([^/]+)/.test(pathname) ? `workbook "${title}", id ${pathname.split("/")[2]}` : /^\/dashboards\/([^/]+)/.test(pathname) ? `report "${title}", id ${pathname.split("/")[2]}` : null;

  const rail: [string, string, string, Section | null][] = [
    ["/", "home", "Workbooks", "home"],
    ["/dashboards", "reports", "Reports", "reports"],
    ["/agents", "agents", "Agents", "agents"],
    ["/definitions", "count", "How we count", "count"],
    ["/apps", "apps", "Apps", "apps"],
  ];
  if (previewOn()) rail.push(["/preview", "preview", "Preview of what is planned", "preview"]);

  return (
    <ShellContext.Provider value={shell}>
      <div className={`gz-shell${sideOpen ? "" : " no-side"}${rightShown ? "" : " no-right"}`}>
        <nav className="gz-rail" aria-label="Main" ref={railRef}>
          <Link to="/" className="gz-logo" aria-label="GridZero home">G</Link>
          <button className="gz-rail-btn" onClick={() => setSearching(true)} title="Search (Ctrl K)" aria-label="Search"><Icon name="search" /></button>
          <span className="gz-rail-rule" />
          {rail.map(([to, icon, label, sec]) => (
            <Link key={to} to={to} className={`gz-rail-btn${section === sec ? " on" : ""}`} title={label} aria-label={label} aria-current={section === sec ? "page" : undefined}><Icon name={icon} /></Link>
          ))}
          <button className="gz-rail-btn gz-side-toggle" onClick={() => setSideOpen((v) => !v)} title={sideOpen ? "Hide the list" : "Show the list"} aria-label="Toggle the list" aria-pressed={sideOpen}><Icon name="list" /></button>
          <span className="gz-rail-space" />
          <button className={`gz-rail-btn${popover === "bell" ? " on" : ""}`} title="For you" aria-label="For you" onClick={() => { setPopover(popover === "bell" ? null : "bell"); setNotices(null); setUnread(0); void loadNotices().then(setNotices); }}><Icon name="bell" />{unread > 0 && <span className="gz-badge" aria-label={`${unread} new`}>{unread}</span>}</button>
          <button className={`gz-rail-btn${popover === "settings" || section === "settings" ? " on" : ""}`} title="Settings" aria-label="Settings" onClick={() => setPopover(popover === "settings" ? null : "settings")}><Icon name="settings" /></button>
          {popover === "bell" && (
            <div className="gz-pop" role="dialog" aria-label="For you">
              <strong>For you</strong>
              {notices === null ? <p className="gz-muted">Looking…</p> : notices.length === 0 ? <p className="gz-muted">Nothing needs you right now.</p> : notices.map((n, i) => <Link key={i} to={n.to} className={`gz-pop-item${n.fresh ? " fresh" : ""}`} onClick={() => setPopover(null)}>{n.text}{n.detail && <span>{n.detail}</span>}</Link>)}
            </div>
          )}
          {popover === "settings" && (
            <div className="gz-pop" role="dialog" aria-label="Settings">
              <strong>{email}</strong>
              <div className="gz-seg" role="group" aria-label="Theme">
                {(["system", "light", "dark"] as Theme[]).map((t) => <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
              </div>
              <Link to="/settings/ai" className="gz-pop-item">AI and spending</Link>
              <Link to="/account" className="gz-pop-item">Account</Link>
              <Link to="/trash" className="gz-pop-item">Trash</Link>
              <button className="gz-pop-item" onClick={() => void authClient.signOut()}>Log out</button>
              <p className="gz-muted"><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link></p>
            </div>
          )}
        </nav>

        <aside className="gz-side" aria-label={side.heading}>
          <div className="gz-side-head">{side.heading}</div>
          {side.action && <button className="gz-side-action" onClick={async () => { const to = await side.action!.run(); if (to) navigate(to); }}>+ {side.action.label}</button>}
          <div className="gz-side-list">
            {side.items === null ? <div className="gz-skel"><span /><span /><span /></div> : side.items.length === 0 ? <p className="gz-muted">Nothing here yet.</p> : side.items.map((it) => (
              <NavLink key={it.to} to={it.to} className={({ isActive }) => `gz-side-item${isActive && !it.to.includes("#") ? " on" : ""}`}>
                <span>{it.label}</span>
                {it.note && <small>{it.note}</small>}
              </NavLink>
            ))}
          </div>
        </aside>

        <div className="gz-center">
          <div className="gz-tabs" role="tablist">
            {tabs.map((t) => (
              <div key={t.path} className={`gz-tab${t.path === pathname ? " on" : ""}`} role="tab" aria-selected={t.path === pathname}>
                <Link to={t.path} title={titleOf(t.path)}>{titleOf(t.path)}</Link>
                <button aria-label={`Close ${titleOf(t.path)}`} onClick={() => closeTab(t.path)}><Icon name="close" size={12} /></button>
              </div>
            ))}
            <span className="gz-rail-space" />
            <button className={`gz-tabs-btn${rightShown ? " on" : ""}`} onClick={() => setRightOpen((v) => !v)} title="Agent panel (Ctrl J)" aria-label="Toggle the agent panel" aria-pressed={rightShown}><Icon name="panel" size={16} /></button>
          </div>
          <div className="gz-main"><Outlet /></div>
        </div>

        <aside className="gz-right" aria-label={panel ? panel.title : "Agent"}>
          {panel ? (
            <>
              <div className="gz-right-head"><strong>{panel.title}</strong></div>
              <div className="gz-right-body">{panel.body}</div>
            </>
          ) : (
            <AgentPanel looking={looking} onClose={() => setRightOpen(false)} />
          )}
        </aside>

        <footer className={`gz-foot${status?.tone ? ` ${status.tone}` : ""}`}>
          <span className="gz-foot-left">{status?.left ?? title}</span>
          <span className="gz-foot-right">
            {status?.right}
            {status?.action && (status.action.to ? <Link className="gz-foot-action" to={status.action.to}>{status.action.label}</Link> : <button className="gz-foot-action" onClick={status.action.onClick}>{status.action.label}</button>)}
            {!rightShown && !/^\/agents\/.+/.test(pathname) && <button className="gz-foot-ask" onClick={() => setRightOpen(true)}>Ask the agent</button>}
          </span>
        </footer>

        {/* Phones: the rail becomes a bar along the bottom. */}
        <nav className="gz-phone-nav" aria-label="Main">
          {rail.slice(0, 4).map(([to, icon, label, sec]) => <Link key={to} to={to} className={section === sec ? "on" : ""} aria-label={label}><Icon name={icon} /></Link>)}
          <button onClick={() => setRightOpen((v) => !v)} aria-label="Agent" className={rightShown ? "on" : ""}><Icon name="panel" /></button>
        </nav>
      </div>
      {searching && <SearchPalette onClose={() => setSearching(false)} />}
    </ShellContext.Provider>
  );
}
