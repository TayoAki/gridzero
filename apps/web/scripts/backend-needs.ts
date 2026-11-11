// Writes the list of what the planned screens need from the backend, read from the screens' own
// descriptions (src/preview/meta). Run: node apps/web/scripts/backend-needs.ts
// It replaces the part of docs/specs/BACKEND-NEEDS.md between the two markers.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PREVIEW_GROUPS, PREVIEW_SCREENS } from "../src/preview/registry.ts";
import type { Need, NeedKind } from "../src/preview/types.ts";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "specs", "BACKEND-NEEDS.md");
const START = "<!-- generated:start -->";
const END = "<!-- generated:end -->";

interface Row extends Need {
  screens: string[];
}
const byKey = new Map<string, Row>();
const rank = { no: 0, partly: 1, yes: 2 } as const;
for (const s of PREVIEW_SCREENS)
  for (const n of s.needs) {
    const key = `${n.kind}|${n.name.toLowerCase()}`;
    const row = byKey.get(key);
    if (!row) byKey.set(key, { ...n, screens: [s.code] });
    else {
      row.screens.push(s.code);
      // When screens disagree: a connection counts as far as any screen found it built; anything else takes the least-built answer.
      if (n.kind === "connection" ? rank[n.exists] > rank[row.exists] : rank[n.exists] < rank[row.exists]) row.exists = n.exists;
    }
  }

const WORD = { yes: "Built", partly: "Partly", no: "Not built" } as const;
const TITLE: Record<NeedKind, string> = { connection: "Connections to outside systems", endpoint: "API endpoints", job: "Background jobs", data: "Stored data", policy: "Rules the product must enforce" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const out: string[] = [];
const rows = [...byKey.values()];
out.push(`${PREVIEW_SCREENS.length} planned screens name ${rows.length} different needs: ${rows.filter((r) => r.exists === "yes").length} built, ${rows.filter((r) => r.exists === "partly").length} partly built, ${rows.filter((r) => r.exists === "no").length} not built.`, "");
for (const kind of Object.keys(TITLE) as NeedKind[]) {
  const list = rows.filter((r) => r.kind === kind).sort((a, b) => b.screens.length - a.screens.length || a.name.localeCompare(b.name));
  out.push(`### ${TITLE[kind]} (${list.length})`, "", "| Need | Today | Screens | What it has to do |", "|---|---|---|---|");
  for (const r of list) out.push(`| ${cell(r.name)} | ${WORD[r.exists]} | ${r.screens.join(", ")} | ${cell(r.note)} |`);
  out.push("");
}
out.push("### By screen", "");
for (const g of PREVIEW_GROUPS) {
  out.push(`**${g.code} · ${g.name}**`, "");
  for (const s of g.screens) out.push(`- ${s.code} ${s.title} (for ${s.for}): ${s.needs.map((n) => n.name).join("; ")}`);
  out.push("");
}

const doc = readFileSync(file, "utf8");
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a < 0 || b < 0) throw new Error("docs/specs/BACKEND-NEEDS.md is missing its generated markers");
writeFileSync(file, doc.slice(0, a + START.length) + "\n\n" + out.join("\n") + "\n" + doc.slice(b));
console.log(`${rows.length} needs from ${PREVIEW_SCREENS.length} screens`);
for (const r of rows.filter((x) => x.kind === "connection")) console.log(`${WORD[r.exists].padEnd(9)} ${r.name}  [${r.screens.join(",")}]`);
