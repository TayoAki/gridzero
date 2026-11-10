"""Turn what the scan and the checks found into questions for a person, ranked by impact and doubt.

No AI here: the checks decide what is asked and a template words it. AI may reword a question for the reader, but
with no AI key these are what the person sees. Each question is about one idea, in business words, and carries the
numbers behind it. `options` describe ready answers; the caller runs each to show its number.
"""
from __future__ import annotations

import re

MONEY = re.compile(r"(?i)(amount|price|revenue|total|cost|value|fee|gross|net|sales|spend)")
LEVEL = {"fail": 3, "warn": 2, "info": 1}


def words(name: str) -> str:
    """order_ts -> order ts, sales_transactions -> sales transactions."""
    return re.sub(r"[_.]+", " ", name.split(".")[-1]).strip().lower()


def singular(table: str) -> str:
    w = words(table).split(" ")[-1]
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if re.search(r"(s|x|z|ch|sh|o)es$", w) and len(w) > 4:
        return w[:-2]
    return w[:-1] if w.endswith("s") and not w.endswith("ss") and len(w) > 3 else w


def a(noun: str) -> str:
    return ("an " if noun[:1] in "aeiou" else "a ") + noun


def question(kind: str, topic: str, prompt: str, impact: float, doubt: int, options: list[dict] | None = None, **data) -> dict:
    return {"kind": kind, "topic": topic, "prompt": prompt, "impact": round(impact, 3), "doubt": doubt, "score": round((0.2 + impact) * doubt, 3), "options": options or [], "data": data}


def build_questions(scan: dict, findings: list[dict] | None = None, definitions: list[dict] | None = None, limit: int = 10) -> list[dict]:
    """Questions from the scan (what the data shows), the findings (what the checks flagged in existing queries) and
    the draft definitions (conflicts). Ranked; the first `limit` are the setup interview and the rest wait."""
    tables, links = scan["tables"], scan["links"]
    out: list[dict] = []
    biggest = max((t["rows"] for t in tables.values()), default=1) or 1
    size = lambda fq: tables[fq]["rows"] / biggest
    flagged = {(f["check"], f["data"].get("table")) for f in findings or []}
    doubt_for = lambda check, fq: 3 if (check, fq) in flagged else 2

    for fq, t in tables.items():
        thing = singular(t["table"])
        # C1: the same id more than once
        for g in t.get("grain_breaks", []):
            extra = g["rows"] - g["distinct"]
            ingest = t.get("ingest_columns") or []
            how = f" The copies differ in `{ingest[0]}`, so they look like re-sent or updated records." if ingest else ""
            out.append(question(
                "duplicates", f"Repeated {thing}s",
                f"{extra} of {g['rows']} rows in {words(t['table'])} repeat {a(thing)} that is already there (the same {words(g['column'])}).{how} "
                f"When {a(thing)} appears more than once, is it a duplicate that was sent again, a corrected version, or a separate event? Which copy should count: the latest, the first, or all of them?",
                size(fq) * max(extra / g["rows"], 0.2), doubt_for("C6", fq) + 0,
                [{"label": "Count the latest copy of each", "change": "latest"}, {"label": "Count every row", "change": "all"}],
                table=fq, column=g["column"], check="C1"))
        # C4: rows marked as test, cancelled, inactive
        for flag in t.get("flags", []):
            values = ", ".join(str(v) for v in flag["values"])
            if flag["kind"] == "flag":
                label = words(flag["column"]).replace("is ", "")
                users = [l["from"] for l in links if l.get("proposed") and l["to"] == fq and l["from"] != fq]
                also = f" Rows in {', '.join(words(u) for u in users)} belong to them." if users else ""
                out.append(question(
                    "excluded_rows", f"{thing.capitalize()}s marked {label}",
                    f"{flag['rows']} of {t['rows']} {thing}s are marked as {label} ({words(flag['column'])} = {values}).{also} "
                    f"Are these test, QA or internal {thing}s that should be left out of reported numbers, or should they count?",
                    max(size(fq), max((size(u) for u in users), default=0)), doubt_for("C4", fq),
                    [{"label": f"Leave out {label} {thing}s", "change": "exclude"}, {"label": "Count them", "change": "include"}],
                    table=fq, column=flag["column"], values=flag["values"], check="C4"))
            else:
                col = next(c for c in t["columns"] if c["name"] == flag["column"])
                every = ", ".join(str(v[0]) for v in col["top"])
                out.append(question(
                    "excluded_rows", f"Which {words(flag['column'])} values count",
                    f"{words(t['table']).capitalize()} have a {words(flag['column'])} of: {every}. {flag['rows']} of {t['rows']} are {values}. "
                    f"Which of these should count in totals, and are cancelled, failed or refunded {thing}s left out?",
                    size(fq) * max(flag["rows"] / t["rows"], 0.3), doubt_for("C4", fq),
                    [{"label": f"Leave out {values}", "change": "exclude"}, {"label": "Count every status", "change": "include"}],
                    table=fq, column=flag["column"], values=flag["values"], check="C4"))
        # C5: a time zone is stored, so "day" and "week" depend on whose clock
        times = [c["name"] for c in t["columns"] if c["kind"] == "timestamp" and c["name"] not in (t.get("ingest_columns") or [])]
        tz_here = t.get("tz_columns") or []
        tz_linked = [(l["to"], tables[l["to"]]["tz_columns"][0]) for l in links if l.get("proposed") and l["from"] == fq and tables[l["to"]].get("tz_columns")]
        if times and (tz_here or tz_linked):
            where = words(tz_linked[0][0]) if tz_linked else words(t["table"])
            out.append(question(
                "time_zone", "Whose clock decides the day and the week",
                f"Times in {words(t['table'])} ({words(times[0])}) are stored in one time zone, usually UTC, but each {singular(where)} has its own time zone. "
                f"When you report by day, week or month, does a period follow each {singular(where)}'s local time or UTC? And which day does your week start on?",
                size(fq), doubt_for("C5", fq) + 0,
                [{"label": "Local time of each " + singular(where), "change": "local"}, {"label": "UTC", "change": "utc"}],
                table=fq, column=times[0], check="C5"))
        # late data: rows are loaded after the moment they describe
        ingest = [c for c in (t.get("ingest_columns") or []) if next(x for x in t["columns"] if x["name"] == c)["kind"] == "timestamp"]
        if times and ingest:
            out.append(question(
                "late_data", "How late records can arrive",
                f"Rows in {words(t['table'])} are loaded some time after they happen ({words(ingest[0])} is later than {words(times[0])}). "
                f"How late can {a(thing)} arrive or be changed, for example after a device or till was offline? Should a period that was already reported be restated when late {thing}s arrive?",
                size(fq) * 0.6, 2, table=fq, column=ingest[0], check="late"))
        # units: what a money column is in
        money = [c["name"] for c in t["columns"] if c["kind"] in ("num", "int") and MONEY.search(c["name"]) and not re.search(r"(?i)_id$|pct|percent", c["name"])]
        if money and t["rows"] >= 5:
            out.append(question(
                "unit", f"What {words(money[0])} is measured in",
                f"What currency or unit is {words(money[0])} in {words(t['table'])} in? Is it one currency for everything, and does it include tax, discounts or shipping?",
                size(fq) * 0.3, 1, table=fq, column=money[0], check="unit"))
        # category columns on fact-like tables: do all kinds count alike
        if t["rows"] >= 20:
            for c in t["columns"]:
                if c["kind"] == "str" and c.get("top") and 2 <= len(c["top"]) <= 6 and not any(c["name"] == f["column"] for f in t.get("flags", [])) and not re.search(r"(?i)name|email|phone|city|country|zip|post", c["name"]):
                    kinds = ", ".join(f"{v[0]} ({v[1]})" for v in c["top"])
                    out.append(question(
                        "categories", f"Do all {words(c['name'])}s count the same",
                        f"{words(t['table']).capitalize()} come in these kinds of {words(c['name'])}: {kinds}. Should every kind count in the same total, or is any of them reported separately or booked by another team?",
                        size(fq) * 0.5, 1, table=fq, column=c["name"], check="categories"))
                    break

    # C2: a link whose "one" side is not one row per id, or a child table with several rows per parent
    for l in links:
        if not l.get("proposed") or l["from"] == l["to"]:
            continue
        child, parent = tables[l["from"]], tables[l["to"]]
        col = next(c for c in child["columns"] if c["name"] == l["from_columns"][0])
        per_parent = child["rows"] - (col["nulls"] or 0) > (col["distinct"] or 0)
        child_money = [c["name"] for c in child["columns"] if c["kind"] in ("num", "int") and MONEY.search(c["name"])]
        parent_money = [c["name"] for c in parent["columns"] if c["kind"] in ("num", "int") and MONEY.search(c["name"])]
        if per_parent and child_money and parent_money and child["rows"] < parent["rows"]:
            c_thing, p_thing = singular(child["table"]), singular(parent["table"])
            c_time = [c["name"] for c in child["columns"] if c["kind"] in ("timestamp", "date")]
            when = f" {a(c_thing).capitalize()} has its own date ({words(c_time[0])}), which can be days after the {p_thing}'s." if c_time else ""
            out.append(question(
                "child_amounts", f"How {c_thing}s change the {p_thing} total",
                f"{a(p_thing).capitalize()} can have more than one {c_thing}, and both carry an amount.{when} Is the number you trust before or after {c_thing}s are taken off (gross or net)? "
                f"And does {a(c_thing)} count in the period of the original {p_thing}, or in the period the {c_thing} itself happened?",
                size(l["to"]), doubt_for("C2", l["from"]) if ("C2", l["from"]) in flagged or ("C2", l["to"]) in flagged else 2,
                [{"label": f"Net of {c_thing}s, in the {p_thing}'s period", "change": "net_original"}, {"label": f"Net of {c_thing}s, in the {c_thing}'s own period", "change": "net_own"}, {"label": "Gross", "change": "gross"}],
                table=l["to"], child=l["from"], check="C2"))
        if l.get("target_repeats"):
            p_thing = singular(parent["table"])
            versions = [c["name"] for c in parent["columns"] if re.search(r"(?i)valid_|is_current|effective|version|_from$|_to$", c["name"])]
            how = f" It looks like history is kept ({', '.join(words(v) for v in versions[:3])})." if versions else ""
            out.append(question(
                "versions", f"Several rows per {p_thing}",
                f"{words(parent['table']).capitalize()} holds more than one row for the same {p_thing}.{how} Do you need each {p_thing} as it is today, or as it was at the time of each {singular(child['table'])}? How often does {a(p_thing)} change?",
                size(l["from"]), doubt_for("C2", l["to"]), table=l["to"], child=l["from"], check="C2"))

    # C9: the same name worked out in different ways
    for d in definitions or []:
        if d["kind"] == "metric" and d["body"].get("alternatives"):
            forms = [{"label": d["body"]["expression"], "change": "formula", "expression": d["body"]["expression"]}] + [{"label": a["expression"], "change": "formula", "expression": a["expression"]} for a in d["body"]["alternatives"]]
            out.append(question("conflict", f"Two ways to work out {d['label']}", f"People work out {d['label']} in {len(forms)} different ways. Which one is right?", 0.8, 3, forms, definition=d["name"], check="C9"))

    # C8 and ownership: always worth one question
    out.append(question(
        "trusted_number", "A number you already trust",
        "Is there a report or figure you already trust for this (for example Finance's ledger or a board pack)? What does it say for a recent period, who owns it, and who should sign off the definition if two teams disagree?",
        0.5, 2, check="C8"))

    out.sort(key=lambda q_: -q_["score"])
    seen, unique = set(), []
    for q_ in out:
        key = (q_["kind"], q_["data"].get("table"), q_["data"].get("column"))
        if key not in seen:
            seen.add(key)
            unique.append(q_)
    for i, q_ in enumerate(unique):
        q_["rank"] = i + 1
        q_["at_setup"] = i < limit
    return unique
