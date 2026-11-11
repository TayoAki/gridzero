// Building blocks for planned screens. They use the product's own styles so a planned screen looks
// like a real one; the frame around it says the data is a sample.

import type { ReactNode } from "react";

import { useStatus } from "../shell/context";
import type { Status, Tone } from "../shell/context";

/** A planned screen's body: a heading, an optional lead line, and the bottom bar it would show. */
export function Screen({ title, lead, status, children, narrow = false }: { title: string; lead?: string; status?: Status; children: ReactNode; narrow?: boolean }) {
  useStatus("preview-screen", status ?? null);
  return (
    <div className={`pv-screen${narrow ? " narrow" : ""}`}>
      <h1>{title}</h1>
      {lead && <p className="pv-lead">{lead}</p>}
      {children}
    </div>
  );
}

export function Stats({ items }: { items: { value: string; label: string; tone?: Tone }[] }) {
  return (
    <div className="pv-stats">
      {items.map((s) => (
        <div key={s.label} className={`pv-stat${s.tone ? ` ${s.tone}` : ""}`}>
          <b>{s.value}</b>
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Banner({ tone, children }: { tone: Tone | "info"; children: ReactNode }) {
  return <div className={`pv-banner ${tone}`} role={tone === "bad" ? "alert" : "status"}>{children}</div>;
}

/** A plain table. Numbers line up when the column name ends with "#". */
export function Rows({ columns, rows, caption }: { columns: string[]; rows: (string | number)[][]; caption?: string }) {
  return (
    <div className="pv-table-wrap">
      <table className="pv-table">
        {caption && <caption>{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c} className={c.endsWith("#") ? "n" : undefined}>{c.replace(/#$/, "")}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={columns[j]?.endsWith("#") ? "n" : undefined}>{v}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Choices, each with the number or consequence it leads to. */
export function Options({ items, picked }: { items: { label: string; note?: string }[]; picked?: number }) {
  return (
    <div className="def-options">
      {items.map((o, i) => (
        <button key={o.label} className={`def-option${picked === i ? " picked" : ""}`} type="button">
          <span className="def-option-letter">{String.fromCharCode(65 + i)}</span>
          <span>{o.label}{o.note && <span className="def-option-number">{o.note}</span>}</span>
        </button>
      ))}
    </div>
  );
}

export function Checks({ items }: { items: { ok: boolean | "warn"; text: string; note?: string }[] }) {
  return (
    <ul className="pv-checks">
      {items.map((c) => (
        <li key={c.text} className={c.ok === true ? "ok" : c.ok === "warn" ? "warn" : "no"}>
          <span aria-hidden="true">{c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✕"}</span>
          <span>{c.text}{c.note && <small>{c.note}</small>}</span>
        </li>
      ))}
    </ul>
  );
}

export function Steps({ items, at }: { items: string[]; at: number }) {
  return (
    <ol className="pv-steps">
      {items.map((s, i) => <li key={s} className={i < at ? "done" : i === at ? "on" : ""}>{s}</li>)}
    </ol>
  );
}

export function Card({ title, children, tone }: { title?: string; children: ReactNode; tone?: Tone }) {
  return (
    <section className={`pv-card${tone ? ` ${tone}` : ""}`}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function Split({ children }: { children: ReactNode }) {
  return <div className="pv-split">{children}</div>;
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="def-actions">{children}</div>;
}

export function Primary({ children }: { children: ReactNode }) {
  return <button className="primary-inline" type="button">{children}</button>;
}

export function Secondary({ children }: { children: ReactNode }) {
  return <button className="secondary" type="button">{children}</button>;
}

export function Chip({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`def-chip${tone === "good" ? " def-confirmed" : tone === "warn" || tone === "bad" ? " def-disputed" : ""}`}>{children}</span>;
}

/** A short exchange with the agent. */
export function Chat({ turns }: { turns: { who: "you" | "agent"; text: string }[] }) {
  return (
    <div className="pv-chat">
      {turns.map((t, i) => <div key={i} className={`chat-msg ${t.who === "you" ? "user" : "assistant"}`}><div className="chat-bubble">{t.text}</div></div>)}
    </div>
  );
}

export function Timeline({ items }: { items: { when: string; text: string; tone?: Tone }[] }) {
  return (
    <ol className="pv-timeline">
      {items.map((t) => <li key={t.when + t.text} className={t.tone}><time>{t.when}</time><span>{t.text}</span></li>)}
    </ol>
  );
}

/** How a report looks to the client it is sent to: no product controls, the sender's own name. */
export function ClientPage({ brand, address, title, children, footer }: { brand: string; address: string; title: string; children: ReactNode; footer: string }) {
  return (
    <div className="pv-client">
      <div className="pv-client-bar"><span className="pv-client-dot" /><span>{address}</span></div>
      <div className="pv-client-body">
        <div className="pv-client-brand">{brand}</div>
        <h1>{title}</h1>
        {children}
        <p className="pv-client-foot">{footer}</p>
      </div>
    </div>
  );
}

/** A phone-sized frame, for screens meant to be read on one. */
export function Phone({ children }: { children: ReactNode }) {
  return <div className="pv-phone">{children}</div>;
}

export function Para({ children }: { children: ReactNode }) {
  return <p className="pv-para">{children}</p>;
}
