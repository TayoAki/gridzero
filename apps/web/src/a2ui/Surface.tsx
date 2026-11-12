// A2UI 1.0 renderer (https://a2ui.org, Apache-2.0). Draws a surface an agent described as data, using
// GridZero's own components: nothing the agent sends is run as code. Supports the basic catalog's layout,
// text and input components and GridZero's chart component; the server refuses the rest before they get here.

import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { DESIGN_FORMS, THEMES, fits, widgetData } from "../widgets/spec";
import type { WidgetData, WidgetForm, WidgetTheme } from "../widgets/spec";
import { WidgetBody, WidgetFrame } from "../widgets/WidgetView";

type Json = unknown;
interface Comp {
  id: string;
  component: string;
  [key: string]: Json;
}

/** What the person did, in the shape A2UI's renderer-to-agent `action` message has. */
export interface A2uiAction {
  name: string;
  userMessage?: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, Json>;
}

// --- JSON Pointers (RFC 6901) ---------------------------------------------------

const parts = (pointer: string) => pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

export function getAt(data: Json, pointer: string): Json {
  let at = data;
  for (const key of parts(pointer)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, Json>)[key];
  }
  return at;
}

/** A copy of `data` with `value` at `pointer`; containers on the way are made as needed. Undefined removes the key. */
export function setAt(data: Json, pointer: string, value: Json): Json {
  const keys = parts(pointer);
  if (keys.length === 0) return value;
  const walk = (node: Json, i: number): Json => {
    const key = keys[i]!;
    const base: Record<string, Json> | Json[] = Array.isArray(node) ? [...node] : node !== null && typeof node === "object" ? { ...(node as Record<string, Json>) } : /^\d+$/.test(key) ? [] : {};
    const next = i === keys.length - 1 ? value : walk((base as Record<string, Json>)[key], i + 1);
    if (next === undefined && !Array.isArray(base)) delete (base as Record<string, Json>)[key];
    else (base as Record<string, Json>)[key] = next;
    return base;
  };
  return walk(data, 0);
}

// --- messages to a surface -------------------------------------------------------

export interface SurfaceState {
  id: string;
  components: Map<string, Comp>;
  data: Json;
  deleted: boolean;
}

/** Apply a surface's messages in order. Messages the renderer does not know are skipped. */
export function applyMessages(messages: Json[]): SurfaceState {
  const state: SurfaceState = { id: "", components: new Map(), data: {}, deleted: false };
  const add = (list: Json) => {
    if (Array.isArray(list)) for (const c of list) if (c && typeof c === "object" && typeof (c as Comp).id === "string" && typeof (c as Comp).component === "string") state.components.set((c as Comp).id, c as Comp);
  };
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, Record<string, Json>>;
    if (msg.createSurface) {
      state.id = String(msg.createSurface.surfaceId ?? "");
      add(msg.createSurface.components);
      if (msg.createSurface.dataModel !== undefined) state.data = msg.createSurface.dataModel;
    } else if (msg.updateComponents) add(msg.updateComponents.components);
    else if (msg.updateDataModel) state.data = setAt(state.data, typeof msg.updateDataModel.path === "string" ? msg.updateDataModel.path : "", msg.updateDataModel.value);
    else if (msg.deleteSurface) state.deleted = true;
  }
  return state;
}

// --- values: literals, bindings, formatString ---------------------------------------

interface Scope {
  data: Json;
  /** Where relative paths start: the current item inside a list template, or the root. */
  base: string;
  index?: number;
}

const absolute = (path: string, scope: Scope) => (path.startsWith("/") ? path : `${scope.base}/${path}`);

function text(v: Json): string {
  return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** A value that may be written out, bound to the data model, or a call to one of the basic functions. */
export function resolve(value: Json, scope: Scope): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, Json>;
  if (typeof v["@path"] === "string") return getAt(scope.data, absolute(v["@path"], scope));
  if (typeof v["@call"] === "string") {
    const args = (v.args ?? {}) as Record<string, Json>;
    switch (v["@call"]) {
      case "@index":
        return scope.index;
      case "formatString":
        return text(resolve(args.value, scope)).replace(/\\\$\{|\$\{([^}]*)\}/g, (all, expr: string | undefined) => (expr === undefined ? "${" : text(getAt(scope.data, absolute(expr.trim(), scope)))));
      case "formatNumber": {
        const n = Number(resolve(args.value, scope));
        return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: typeof args.decimals === "number" ? args.decimals : 2 }) : "";
      }
      case "formatCurrency": {
        const n = Number(resolve(args.value, scope));
        try {
          return Number.isFinite(n) ? n.toLocaleString(undefined, { style: "currency", currency: text(resolve(args.currency, scope)) || "USD" }) : "";
        } catch {
          return String(n);
        }
      }
      case "pluralize":
        return Number(resolve(args.value, scope)) === 1 ? text(resolve(args.one, scope)) : text(resolve(args.other, scope));
      default:
        // A function this renderer does not have gives nothing, rather than guessing.
        return undefined;
    }
  }
  return value;
}

const pathOf = (value: Json, scope: Scope): string | null => (value && typeof value === "object" && typeof (value as Record<string, Json>)["@path"] === "string" ? absolute((value as Record<string, string>)["@path"]!, scope) : null);

// --- Markdown, the small part a Text needs ------------------------------------------

/** Bold, italic, code and https links inside one line. Anything else is shown as typed. */
function inline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>"]+)/g;
  let last = 0;
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const key = out.length;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={key}>{m[3]}</code>);
    else out.push(<a key={key} href={m[5] ?? m[6]} target="_blank" rel="noopener noreferrer">{m[4] ?? m[6]}</a>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** Headings, bullet lists and paragraphs. No HTML is ever passed through. */
function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of source.split("\n")) {
    const heading = /^(#{1,5})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]!);
      continue;
    }
    flush();
    if (heading) blocks.push(<div key={blocks.length} className={`a2-heading h${heading[1]!.length}`} role="heading" aria-level={heading[1]!.length + 2}>{inline(heading[2]!)}</div>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

// --- drawing ---------------------------------------------------------------------

const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", spaceBetween: "space-between", spaceAround: "space-around", spaceEvenly: "space-evenly", stretch: "stretch" };
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
const MAX_DEPTH = 24;

export function Surface({ messages, onAction, busy = false }: { messages: Json[]; onAction: (action: A2uiAction) => void; busy?: boolean }) {
  const initial = useMemo(() => applyMessages(messages), [messages]);
  // What the person types and picks lives here; it starts from what the agent sent.
  const [data, setData] = useState<Json>(initial.data);
  const [tab, setTab] = useState<Record<string, number>>({});
  // Chart data by component, kept while it reads the same, so typing in a field does not redraw the charts.
  const charts = useRef(new Map<string, { key: string; data: WidgetData | null }>());
  if (initial.deleted || !initial.components.has("root")) return null;
  const write = (path: string | null, value: Json) => path !== null && setData((d: Json) => setAt(d, path, value));

  const draw = (id: string, scope: Scope, depth: number, key?: string): ReactNode => {
    const c = initial.components.get(id);
    if (!c || depth > MAX_DEPTH) return null;
    const k = key ?? id;
    const kids = (list: Json): ReactNode[] => {
      if (Array.isArray(list)) return list.filter((x): x is string => typeof x === "string").map((child) => draw(child, scope, depth + 1));
      // A template: one copy of a component for each item of a list in the data model.
      const t = list as { componentId?: Json; path?: Json } | null;
      if (t && typeof t.componentId === "string" && typeof t.path === "string") {
        const at = absolute(t.path, scope);
        const items = getAt(scope.data, at);
        return Array.isArray(items) ? items.slice(0, 100).map((_, i) => draw(t.componentId as string, { data: scope.data, base: `${at}/${i}`, index: i }, depth + 1, `${t.componentId as string}:${i}`)) : [];
      }
      return [];
    };
    const weight = typeof c.weight === "number" ? { flex: c.weight } : undefined;
    switch (c.component) {
      case "Text":
        return <div key={k} className={`a2-text${c.variant === "caption" ? " caption" : ""}`} style={weight}><Markdown source={text(resolve(c.text, scope))} /></div>;
      case "Image": {
        const url = typeof c.url === "string" && /^https:\/\//.test(c.url) ? c.url : null;
        return url ? <img key={k} className={`a2-image ${typeof c.variant === "string" ? c.variant : ""}`} src={url} alt={text(resolve(c.description, scope))} loading="lazy" referrerPolicy="no-referrer" style={{ objectFit: c.fit === "scaleDown" ? "scale-down" : (c.fit as "contain" | "cover" | "fill" | "none" | undefined) }} /> : null;
      }
      case "Row":
      case "Column":
        return <div key={k} className={c.component === "Row" ? "a2-row" : "a2-column"} style={{ justifyContent: JUSTIFY[String(c.justify)], alignItems: ALIGN[String(c.align)], ...weight }}>{kids(c.children)}</div>;
      case "List":
        return <div key={k} className={c.direction === "horizontal" ? "a2-row a2-list" : "a2-column a2-list"} style={{ alignItems: ALIGN[String(c.align)], ...weight }}>{kids(c.children)}</div>;
      case "Card":
        return <div key={k} className="a2-card" style={weight}>{typeof c.child === "string" && draw(c.child, scope, depth + 1)}</div>;
      case "Divider":
        return <hr key={k} className={c.axis === "vertical" ? "a2-divider vertical" : "a2-divider"} />;
      case "Tabs": {
        const tabs = Array.isArray(c.tabs) ? (c.tabs as { title?: Json; child?: Json }[]).filter((t) => t && typeof t.child === "string") : [];
        const on = Math.min(tab[c.id] ?? 0, tabs.length - 1);
        return (
          <div key={k} className="a2-tabs" style={weight}>
            <div role="tablist">{tabs.map((t, i) => <button key={i} role="tab" aria-selected={i === on} className={i === on ? "on" : ""} onClick={() => setTab({ ...tab, [c.id]: i })}>{text(resolve(t.title, scope))}</button>)}</div>
            {tabs[on] && draw(tabs[on]!.child as string, scope, depth + 1)}
          </div>
        );
      }
      case "Button": {
        const action = (c.action ?? {}) as { event?: { name?: Json; userMessage?: Json; context?: Record<string, Json> }; functionCall?: { "@call"?: Json; args?: { url?: Json } } };
        const press = () => {
          if (action.functionCall?.["@call"] === "openUrl") {
            const url = action.functionCall.args?.url;
            if (typeof url === "string" && /^https:\/\//.test(url)) window.open(url, "_blank", "noopener,noreferrer");
            return;
          }
          if (!action.event || typeof action.event.name !== "string") return;
          const context: Record<string, Json> = {};
          for (const [name, v] of Object.entries(action.event.context ?? {})) context[name] = resolve(v, { ...scope, data }) ?? null;
          const said = text(resolve(action.event.userMessage, { ...scope, data }));
          onAction({ name: action.event.name, ...(said ? { userMessage: said } : {}), surfaceId: initial.id, sourceComponentId: c.id, timestamp: new Date().toISOString(), context });
        };
        return <button key={k} className={`a2-button ${c.variant === "primary" ? "primary" : c.variant === "borderless" ? "borderless" : ""}`} disabled={busy && !action.functionCall} onClick={press}>{typeof c.child === "string" && draw(c.child, scope, depth + 1)}</button>;
      }
      case "TextField": {
        const path = pathOf(c.value, scope);
        const value = text(path !== null ? getAt(data, path) : resolve(c.value, { ...scope, data }));
        const label = text(resolve(c.label, scope));
        const common = { value, placeholder: text(resolve(c.placeholder, scope)), onChange: (e: { target: { value: string } }) => write(path, c.variant === "number" && e.target.value !== "" && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value) };
        return (
          <label key={k} className="a2-field" style={weight}>
            {label && <span>{label}</span>}
            {c.variant === "longText" ? <textarea rows={3} {...common} /> : <input type={c.variant === "number" ? "number" : "text"} {...common} />}
          </label>
        );
      }
      case "CheckBox": {
        const path = pathOf(c.value, scope);
        return (
          <label key={k} className="a2-check" style={weight}>
            <input type="checkbox" checked={(path !== null ? getAt(data, path) : resolve(c.value, { ...scope, data })) === true} onChange={(e) => write(path, e.target.checked)} /> {text(resolve(c.label, scope))}
          </label>
        );
      }
      case "ChoicePicker": {
        const path = pathOf(c.value, scope);
        const raw = path !== null ? getAt(data, path) : resolve(c.value, { ...scope, data });
        const picked = Array.isArray(raw) ? raw.map(String) : raw === undefined || raw === null || raw === "" ? [] : [String(raw)];
        const options = Array.isArray(c.options) ? (c.options as { label?: Json; value?: Json }[]).filter((o) => o && o.value !== undefined) : [];
        const many = c.variant === "multipleSelection";
        const label = text(resolve(c.label, scope));
        const choose = (v: string) => write(path, many ? (picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]) : [v]);
        return (
          <div key={k} className={`a2-choice${c.displayStyle === "chips" ? " chips" : ""}`} role={many ? "group" : "radiogroup"} aria-label={label || undefined} style={weight}>
            {label && <span className="a2-choice-label">{label}</span>}
            {options.map((o) => {
              const v = String(o.value);
              const on = picked.includes(v);
              return c.displayStyle === "chips" ? (
                <button key={v} type="button" aria-pressed={on} className={on ? "on" : ""} onClick={() => choose(v)}>{text(resolve(o.label, scope)) || v}</button>
              ) : (
                <label key={v}><input type={many ? "checkbox" : "radio"} name={`${initial.id}:${c.id}`} checked={on} onChange={() => choose(v)} /> {text(resolve(o.label, scope)) || v}</label>
              );
            })}
          </div>
        );
      }
      case "Slider": {
        const path = pathOf(c.value, scope);
        const min = typeof c.min === "number" ? c.min : 0;
        const max = typeof c.max === "number" ? c.max : 100;
        const raw = Number(path !== null ? getAt(data, path) : resolve(c.value, { ...scope, data }));
        const value = Number.isFinite(raw) ? raw : min;
        return (
          <label key={k} className="a2-field" style={weight}>
            <span>{text(resolve(c.label, scope))} <b>{value.toLocaleString()}</b></span>
            <input type="range" min={min} max={max} step={typeof c.steps === "number" && c.steps > 0 ? (max - min) / c.steps : "any"} value={value} onChange={(e) => write(path, Number(e.target.value))} />
          </label>
        );
      }
      case "GridZeroChart": {
        const form = DESIGN_FORMS.includes(c.form as (typeof DESIGN_FORMS)[number]) ? (c.form as WidgetForm) : null;
        const raw = resolve(c.data, { ...scope, data });
        const key = JSON.stringify(raw);
        let held = charts.current.get(k);
        if (!held || held.key !== key) {
          const checked = widgetData.safeParse(raw);
          held = { key, data: checked.success ? checked.data : null };
          charts.current.set(k, held);
        }
        const parsed = held.data ? { success: true as const, data: held.data } : { success: false as const };
        const theme: WidgetTheme = THEMES.includes(c.theme as WidgetTheme) ? (c.theme as WidgetTheme) : "blue";
        const title = text(resolve(c.title, scope));
        if (!form || !parsed.success || fits(form, parsed.data) !== null) return <p key={k} className="a2-missing">This chart's data is not in a shape that can be drawn.</p>;
        const height = typeof c.height === "number" ? Math.min(480, Math.max(120, c.height)) : parsed.data.kind === "number" && form !== "gauge" ? 120 : 240;
        return (
          <div key={k} className="a2-chart" style={{ height, ...weight }}>
            <WidgetFrame title={title} theme={theme} size="m"><WidgetBody form={form} theme={theme} size="m" data={parsed.data} title={title} /></WidgetFrame>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return <div className="a2-surface" data-testid="a2ui-surface">{draw("root", { data, base: "" }, 0)}</div>;
}
