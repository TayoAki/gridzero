// A report sent by email: its live cards are refreshed, then every card is written out as text and
// small tables. Charts are not drawn in the message; the link opens the report itself.

import { asc, eq } from "drizzle-orm";

import { db } from "../db/client.ts";
import { dashboard, widget } from "../db/schema.ts";
import { env } from "../env.ts";
import { mailEnabled, sendMail } from "../mail.ts";
import { postWebhook } from "../webhook.ts";
import { RefreshError, refreshWidget } from "./refresh.ts";
import type { WidgetData, WidgetSource } from "./spec.ts";

const escape = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plain = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const MAX_ROWS = 12;

const cell = 'style="padding:4px 12px 4px 0;border-bottom:1px solid #e3e5e8;text-align:left;font-size:13px"';
const num = 'style="padding:4px 0 4px 12px;border-bottom:1px solid #e3e5e8;text-align:right;font-size:13px"';

function table(columns: string[], rows: (string | number | null)[][], total: number): string {
  const head = `<tr>${columns.map((c, i) => `<th ${i && typeof rows[0]?.[i] === "number" ? num : cell}>${escape(c)}</th>`).join("")}</tr>`;
  const body = rows.map((r) => `<tr>${columns.map((_, i) => (typeof r[i] === "number" ? `<td ${num}>${plain(r[i] as number)}</td>` : `<td ${cell}>${escape(r[i])}</td>`)).join("")}</tr>`).join("");
  const more = total > rows.length ? `<p style="color:#6b7280;font-size:12px;margin:4px 0 0">and ${total - rows.length} more</p>` : "";
  return `<table style="border-collapse:collapse">${head}${body}</table>${more}`;
}

/** One card as HTML, or nothing for a card that holds no numbers to send. */
export function cardHtml(title: string, data: WidgetData): string {
  let inner: string;
  switch (data.kind) {
    case "number": {
      const change = data.delta ? ` <span style="font-size:13px;color:${data.delta > 0 ? "#18794e" : "#b42318"}">${data.delta > 0 ? "up" : "down"} ${plain(Math.abs(data.delta))} since the last refresh</span>` : "";
      inner = `<p style="font-size:26px;font-weight:700;margin:0">${plain(data.value)}${escape(data.unit ?? "")}${change}</p>${data.label ? `<p style="color:#6b7280;font-size:12px;margin:2px 0 0">${escape(data.label)}</p>` : ""}`;
      break;
    }
    case "series":
      inner = table(["", "Value"], data.points.slice(0, MAX_ROWS).map((p) => [p.label, p.value]), data.points.length);
      break;
    case "table":
      inner = table(data.columns, data.rows.slice(0, MAX_ROWS), data.rows.length);
      break;
    case "list":
      inner = `<ul style="margin:0;padding-left:18px;font-size:13px">${data.items.slice(0, MAX_ROWS).map((i) => `<li>${escape(i.title)}${i.detail ? `: ${escape(i.detail)}` : ""}</li>`).join("")}</ul>`;
      break;
    case "text":
      inner = `<p style="font-size:13px;margin:0;white-space:pre-wrap">${escape(data.text)}</p>`;
      break;
    case "slicer":
      return "";
  }
  return `<div style="margin:0 0 22px"><h3 style="font-size:14px;margin:0 0 6px">${escape(title)}</h3>${inner}</div>`;
}

/** One card as a line of plain text, for a chat channel. Empty for a card with nothing to say. */
export function cardText(title: string, data: WidgetData): string {
  switch (data.kind) {
    case "number":
      return `• ${title}: ${plain(data.value)}${data.unit ?? ""}`;
    case "series":
      return `• ${title}: ${data.points.slice(0, 6).map((p) => `${p.label} ${plain(p.value)}`).join("; ")}${data.points.length > 6 ? `; and ${data.points.length - 6} more` : ""}`;
    case "table":
      return `• ${title}: ${data.rows.length} ${data.rows.length === 1 ? "row" : "rows"}`;
    case "list":
      return `• ${title}: ${data.items.slice(0, 3).map((i) => i.title).join("; ")}`;
    case "text":
      return `• ${title}${data.text ? `: ${data.text.slice(0, 200)}` : ""}`;
    case "slicer":
      return "";
  }
}

/**
 * Refresh a report's live cards and email it. Returns the reason it could not be sent, or null.
 * A card that fails to refresh goes out with its last figures and a line saying so.
 */
export async function sendReport(dashboardId: string, ownerId: string, recipients: string[], webhook: string | null = null): Promise<string | null> {
  const [board] = await db.select().from(dashboard).where(eq(dashboard.id, dashboardId));
  if (!board || board.ownerId !== ownerId) return "The report no longer exists.";
  if (!recipients.length && !webhook) return "Nobody is set to receive this report.";
  if (recipients.length && !mailEnabled() && !webhook) return "Email is not set up on this server, so the report was not sent.";
  const rows = await db.select().from(widget).where(eq(widget.dashboardId, dashboardId)).orderBy(asc(widget.position));
  if (!rows.some((w) => (w.data as WidgetData).kind !== "slicer")) return "The report has no cards to send.";
  const parts: string[] = [];
  const lines: string[] = [];
  for (const w of rows) {
    let row = w;
    let stale = "";
    if ((w.source as WidgetSource).kind !== "snapshot") {
      try {
        row = await refreshWidget(ownerId, w);
      } catch (e) {
        if (!(e instanceof RefreshError)) throw e;
        stale = `<p style="color:#b54708;font-size:12px;margin:4px 0 0">Could not refresh: ${escape(e.message)} These are the figures from ${escape(w.refreshedAt.toISOString().slice(0, 10))}.</p>`;
      }
    }
    const html = cardHtml(row.title, row.data as WidgetData);
    if (html) parts.push(stale ? html.replace(/<\/div>$/, `${stale}</div>`) : html);
    const line = cardText(row.title, row.data as WidgetData);
    if (line) lines.push(line);
  }
  const url = board.linkToken ? `${env.publicUrl}/r/${board.linkToken}` : `${env.publicUrl}/dashboards/${board.id}`;
  const when = new Date().toISOString().slice(0, 10);
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2328;max-width:640px"><h2 style="font-size:18px;margin:0 0 4px">${escape(board.name)}</h2><p style="color:#6b7280;font-size:12px;margin:0 0 18px">As of ${when}</p>${parts.join("")}<p style="font-size:13px"><a href="${escape(url)}">Open the report</a> for the charts.</p></div>`;
  const problems: string[] = [];
  if (recipients.length) {
    if (!mailEnabled()) problems.push("Email is not set up on this server, so it was not emailed.");
    else if (!(await sendMail({ to: recipients, subject: `${board.name}: ${when}`, html }))) problems.push("The email could not be sent.");
  }
  if (webhook) {
    // `text` is what Slack's incoming webhooks read; the rest is for anything else that listens.
    const failed = await postWebhook(webhook, { text: `*${board.name}* as of ${when}\n${lines.join("\n")}\n${url}`, report: board.name, asOf: when, url, cards: lines.map((l) => l.replace(/^• /, "")) });
    if (failed) problems.push(failed);
  }
  return problems.length ? problems.join(" ") : null;
}
