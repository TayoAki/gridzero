"""Turn a scan and a history trace into draft definitions, by rule. AI adds names and descriptions later; nothing
here needs it. Confidence follows the spec: high = declared, or two independent kinds of evidence with no conflict;
medium = one kind plus a matching name; low = data alone, a failed check, or a conflict.
"""
from __future__ import annotations

import collections
import re


def confidence(evidence: list[dict], conflict: bool = False, failed: bool = False) -> str:
    kinds = {e["type"] for e in evidence}
    if conflict or failed:
        return "low"
    if "declared" in kinds or "answer" in kinds or "import" in kinds:
        return "high"
    if "usage" in kinds and "profile" in kinds:
        return "high"
    if len(kinds) >= 2:
        return "medium"
    return "low"


def usage(count: int, people: int) -> dict:
    who = f" by {people} people" if people > 1 else ""
    return {"type": "usage", "text": f"Used in {count} quer{'y' if count == 1 else 'ies'}{who}.", "count": count, "people": people}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:60] or "unnamed"


MONEY = re.compile(r"(?i)(amount|price|revenue|total|cost|value|fee|gross|net|sales|spend|gold|qty|quantity)")


def draft(scan: dict, trace: dict | None = None, min_uses: int = 2, min_people: int = 2, suggest_basics: bool = False) -> list[dict]:
    """min_people: a metric, rule or dimension is only proposed when at least this many different people wrote it.
    One person repeating a filter is a habit; two people writing the same one is a shared definition."""
    tables, links = scan["tables"], scan["links"]
    trace = trace or {"joins": [], "filters": [], "groupings": [], "measures": []}
    short = lambda fq: fq.split(".")[-1]
    defs: list[dict] = []

    joined = {}
    for j in trace["joins"]:
        (t1, c1), (t2, c2) = j["key"]
        joined[frozenset([(t1, c1), (t2, c2)])] = j

    # ---- entities
    join_targets = collections.Counter()
    for j in trace["joins"]:
        for t, c in j["key"]:
            join_targets[(t, c)] += j["count"]
    for fq, t in tables.items():
        key = t["keys"][0] if t["keys"] else None
        evidence = list(key["evidence"]) if key else []
        if key and len(key["columns"]) == 1 and join_targets[(fq, key["columns"][0])]:
            evidence.append(usage(join_targets[(fq, key["columns"][0])], 1))
        broken = bool(t.get("grain_breaks"))
        defs.append({
            "kind": "entity", "name": slug(short(fq)), "label": short(fq).replace("_", " "),
            "body": {"table": fq, "grain": key["columns"] if key else None, "grain_holds": bool(key) and not broken, "row_count": t["rows"]},
            "evidence": evidence, "confidence": confidence(evidence, failed=broken or not key),
            "status": "needs_answer" if broken or not key else "inferred",
        })

    # ---- links
    for l in links:
        used = joined.get(frozenset([(l["from"], l["from_columns"][0]), (l["to"], l["to_columns"][0])]))
        if not (l.get("proposed") or (used and l.get("named") and (not l.get("copy") or l.get("home")))):
            continue
        evidence = list(l["evidence"]) + ([usage(used["count"], used["people"])] if used else [])
        defs.append({
            "kind": "link", "name": slug(f"{short(l['from'])}_{l['from_columns'][0]}_to_{short(l['to'])}"),
            "label": f"{short(l['from'])} → {short(l['to'])}",
            "body": {"from_entity": l["from"], "from_columns": l["from_columns"], "to_entity": l["to"], "to_columns": l["to_columns"], "cardinality": l["cardinality"], "coverage": l["coverage"]},
            "evidence": evidence, "confidence": confidence(evidence), "status": "inferred",
        })

    # ---- rules: filters people keep writing
    key_columns = {(fq, c) for fq, t in tables.items() for k in t["keys"] for c in k["columns"]}
    for f in trace["filters"]:
        if f["count"] < min_uses or f["people"] < min_people:
            continue
        text, fq = f["key"]
        # "key IS NULL" after an outer join finds unmatched rows; it is a query technique, not a business rule.
        if re.search(r"\bIS (NOT )?NULL$", text) and any(text.startswith(f"{short(t)}.{c} ") for t, c in key_columns):
            continue
        evidence = [usage(f["count"], f["people"])]
        defs.append({
            "kind": "rule", "name": slug(text.replace(short(fq) + ".", "")), "label": text.replace(short(fq) + ".", ""),
            "body": {"entity": fq, "expression": text, "meaning": ""},
            "evidence": evidence, "confidence": confidence(evidence), "status": "inferred",
        })

    # ---- dimensions: columns people group by
    for g in trace["groupings"]:
        if g["count"] < min_uses or g["people"] < min_people:
            continue
        fq, col = g["key"]
        info = next(c for c in tables[fq]["columns"] if c["name"] == col)
        evidence = [usage(g["count"], g["people"])]
        if info.get("top"):
            evidence.append({"type": "profile", "text": f"{info['distinct']} different values."})
        defs.append({
            "kind": "dimension", "name": slug(f"{short(fq)}_{col}"), "label": col.replace("_", " "),
            "body": {"entity": fq, "expression": col, "is_time": info["kind"] in ("date", "timestamp")},
            "evidence": evidence, "confidence": confidence(evidence), "status": "inferred",
        })

    # ---- metrics: named totals, grouped by the name people gave them
    by_name: dict[str, list[dict]] = collections.defaultdict(list)
    for m in trace["measures"]:
        if m["name"]:
            by_name[m["name"]].append(m)
    for name, uses in by_name.items():
        forms = collections.Counter(m["expression"] for m in uses)
        if sum(forms.values()) < min_uses or len({m["user"] for m in uses}) < min_people:
            continue
        (best, count), *others = forms.most_common()
        people = len({m["user"] for m in uses if m["expression"] == best})
        first = next(m for m in uses if m["expression"] == best)
        filters = collections.Counter(tuple(m["filters"]) for m in uses if m["expression"] == best).most_common(1)[0][0]
        evidence = [usage(count, people)]
        if others:
            evidence.append({"type": "conflict", "text": f"`{name}` is {best} in {count} quer{'y' if count == 1 else 'ies'} and " + ", ".join(f"{e} in {n}" for e, n in others) + "."})
        defs.append({
            "kind": "metric", "name": slug(name), "label": name.replace("_", " "),
            "body": {"entity": first["tables"][0] if first["tables"] else None, "expression": best, "filters": list(filters), "tables": first["tables"],
                     "alternatives": [{"expression": e, "count": n} for e, n in others]},
            "evidence": evidence, "confidence": confidence(evidence, conflict=bool(others)),
            "status": "needs_answer" if others else "inferred",
        })

    # ---- with no history to learn from, suggest the obvious totals so there is something to confirm or correct
    if suggest_basics:
        have = {(d["body"]["entity"], d["body"]["expression"]) for d in defs if d["kind"] == "metric"}
        targets = {l["to"] for l in links if l.get("proposed")}
        for fq, t in tables.items():
            if t["rows"] < 2:
                continue
            money = [c["name"] for c in t["columns"] if c["kind"] in ("num", "int") and MONEY.search(c["name"]) and not re.search(r"(?i)(_id|_key|pct|percent)$", c["name"])]
            if not money and fq in targets:
                continue  # a lookup table: counting its rows is rarely a business number
            thing = short(fq)
            basics = [(f"{thing}_count", f"Number of {thing.replace('_', ' ')}", "COUNT(*)")] + [(f"total_{c}", f"Total {c.replace('_', ' ')}", f"SUM({thing}.{c})") for c in money[:2]]
            for name, label, expression in basics:
                if (fq, expression) in have:
                    continue
                evidence = [{"type": "profile", "text": "Suggested from the table's columns. Nobody has been seen using it yet."}]
                defs.append({"kind": "metric", "name": slug(name), "label": label,
                             "body": {"entity": fq, "expression": expression, "filters": [], "tables": [fq], "alternatives": []},
                             "evidence": evidence, "confidence": "low", "status": "inferred"})
    return defs
