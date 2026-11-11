"""Scan a source without AI: catalog, column profiles, key candidates and link candidates.

Everything is SQL run through `run(sql) -> list of row tuples`, so the heavy work happens in the warehouse and this
module never holds a connection or a credential. The SQL sticks to what Postgres and DuckDB both accept.
"""
from __future__ import annotations

import re
from typing import Callable

Run = Callable[[str], list]

SYSTEM_SCHEMAS = ("information_schema", "pg_catalog", "pg_toast")
KEY_NAME = re.compile(r"(?i:^id$|_id$|_key$|_code$|_no$)|[a-z](ID|Id|Key)$")
INGEST_NAME = re.compile(r"(?i)^_|(ingest|loaded|load_ts|updated_at|modified|_file|batch)")
TZ_NAME = re.compile(r"(?i)(^tz$|time_?zone|_tz$)")
FLAG_NAME = re.compile(r"(?i)^(is_)?(test|deleted|active|internal|cancell?ed|void|archived|draft|demo|fraud|sandbox)$")
STATUS_NAME = re.compile(r"(?i)(status|state|stage|outcome|result)$")
BAD_VALUE = re.compile(r"(?i)(cancel|void|test|fail|refund|delet|draft|abandon|reject|error|invalid|expired|duplicate)")


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def kind_of(data_type: str) -> str:
    t = data_type.upper()
    if re.search(r"BOOL|^BIT$", t):
        return "bool"
    if re.search(r"INTERVAL|USER-DEFINED|STRUCT|MAP|LIST|\[\]|JSON|VARIANT|ARRAY|BLOB|BYTEA|UNION", t):
        return "other"
    if re.search(r"TIMESTAMP|DATETIME", t):
        return "timestamp"
    if re.search(r"DATE|TIME", t):
        return "date"
    if re.search(r"INT|SERIAL", t) or re.search(r"(DEC\w*|NUM\w*)\(\d+,\s*0\)", t):
        return "int"
    if re.search(r"DEC|NUM|DOUBLE|FLOAT|REAL|MONEY", t):
        return "num"
    if re.search(r"CHAR|TEXT|STRING|UUID", t):
        return "str"
    return "other"


def read_catalog(run: Run, schemas: list[str] | None = None, dialect: str = "duckdb") -> dict:
    """Tables with their columns and declared keys: {"schema.table": {schema, table, columns: [{name, type, kind}], declared_key, declared_links}}."""
    where = "table_schema not in (%s)" % ", ".join(f"'{s}'" for s in SYSTEM_SCHEMAS)
    if schemas:
        where += " and table_schema in (%s)" % ", ".join("'" + s.replace("'", "''") + "'" for s in schemas)
    tables: dict[str, dict] = {}
    rows = run(f"select table_schema, table_name, column_name, data_type from information_schema.columns where {where} order by table_schema, table_name, ordinal_position")
    for schema, table, column, data_type in rows:
        t = tables.setdefault(f"{schema}.{table}", {"schema": schema, "table": table, "columns": [], "declared_key": [], "declared_links": []})
        t["columns"].append({"name": column, "type": data_type, "kind": kind_of(str(data_type))})
    try:
        if dialect == "postgres":
            cols = lambda rel, keys: f"(select array_to_string(array_agg(a.attname order by k.ord), ',') from unnest({keys}) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = {rel} and a.attnum = k.attnum)"
            for schema, table, contype, own, fschema, ftable, theirs in run(
                f"select n.nspname, c.relname, con.contype, {cols('con.conrelid', 'con.conkey')}, fn.nspname, fc.relname, {cols('con.confrelid', 'con.confkey')} "
                "from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace "
                "left join pg_class fc on fc.oid = con.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace where con.contype in ('p', 'f')"
            ):
                t = tables.get(f"{schema}.{table}")
                if not t:
                    continue
                if contype == "p":
                    t["declared_key"] = own.split(",")
                else:
                    t["declared_links"].append({"columns": own.split(","), "to": f"{fschema}.{ftable}", "to_columns": theirs.split(",")})
        else:
            for schema, table, column in run(
                "select tc.table_schema, tc.table_name, kcu.column_name from information_schema.table_constraints tc "
                "join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema and kcu.table_name = tc.table_name "
                "where tc.constraint_type = 'PRIMARY KEY' order by kcu.ordinal_position"
            ):
                if f"{schema}.{table}" in tables:
                    tables[f"{schema}.{table}"]["declared_key"].append(column)
    except Exception:
        pass  # declared constraints are a bonus; a source that hides them still scans
    return tables


def profile_table(run: Run, t: dict, max_rows: int = 1_000_000) -> None:
    """Row count plus distinct, empty, min and max per column, in one query; common values for columns with few values."""
    rel = f"{q(t['schema'])}.{q(t['table'])}"
    t["rows"] = int(run(f"select count(*) from {rel}")[0][0])
    t["sampled"] = t["rows"] > max_rows
    src = f"(select * from {rel} limit {max_rows}) s" if t["sampled"] else rel
    n = min(t["rows"], max_rows)
    cols = [c for c in t["columns"] if c["kind"] != "other"]
    for c in t["columns"]:
        c.update({"distinct": None, "nulls": None, "min": None, "max": None, "top": None})
    if not cols:
        return
    parts = []
    for c in cols:
        parts += [f"count(distinct {q(c['name'])})", f"count({q(c['name'])})"]
        if c["kind"] in ("int", "num", "date", "timestamp"):
            parts += [f"cast(min({q(c['name'])}) as varchar)", f"cast(max({q(c['name'])}) as varchar)"]
    row = list(run(f"select {', '.join(parts)} from {src}")[0])
    for c in cols:
        c["distinct"], filled = int(row.pop(0)), int(row.pop(0))
        c["nulls"] = n - filled
        if c["kind"] in ("int", "num", "date", "timestamp"):
            c["min"], c["max"] = row.pop(0), row.pop(0)
    for c in cols:
        if c["kind"] in ("str", "bool") and 0 < c["distinct"] <= 20 and (c["distinct"] < n or c["kind"] == "bool"):
            top = run(f"select cast({q(c['name'])} as varchar), count(*) from {src} where {q(c['name'])} is not null group by 1 order by 2 desc, 1 limit 20")
            c["top"] = [[v, int(k)] for v, k in top]


def looks_like_key(name: str) -> bool:
    return bool(KEY_NAME.search(name))


def stems(table: str) -> set[str]:
    """Singular forms a table's name may stand for: heroes -> hero, sales_franchises -> franchise, dim_hero -> hero."""
    last = re.sub(r"^(dim|fact|stg|raw|src)_", "", table.lower()).split("_")[-1]
    out = {last}
    for suffix, repl in (("ies", "y"), ("es", ""), ("s", "")):
        if last.endswith(suffix) and len(last) > len(suffix) + 1:
            out.add(last[: -len(suffix)] + repl)
    return out


def names_table(column: str, table: str) -> bool:
    """Is this column the table's own id (heroes.hero_id, dim_hero.hero_key, orders.id)?"""
    a = squash(column)
    return a == "id" or any(a in (s + "id", s + "key") for s in stems(table))


def squash(name: str) -> str:
    return name.lower().replace("_", "")


def infer_keys(run: Run, t: dict) -> None:
    """Sets t["unique"] (every unique, never-empty column), t["keys"] (the proposed ones, with evidence) and t["grain"]."""
    n = t["rows"]
    t["unique"] = [c["name"] for c in t["columns"] if n >= 2 and c["distinct"] == n and c["nulls"] == 0]
    keys = []
    for c in t["columns"]:
        name = c["name"]
        declared = t["declared_key"] == [name]
        if not declared and not (name in t["unique"] and c["kind"] in ("int", "str") and looks_like_key(name)):
            continue
        evidence = [{"type": "profile", "text": f"Unique and never empty in {n:,} rows."}] if name in t["unique"] else []
        if declared:
            evidence.insert(0, {"type": "declared", "text": "Declared as the primary key in the database."})
        if looks_like_key(name):
            evidence.append({"type": "name", "text": f"The name `{name}` looks like a key."})
        own = names_table(name, t["table"])
        keys.append({"columns": [name], "declared": declared, "names_table": own, "evidence": evidence})
    if len(t["declared_key"]) > 1:
        keys.append({"columns": list(t["declared_key"]), "declared": True, "names_table": True, "evidence": [{"type": "declared", "text": "Declared as the primary key in the database."}]})
    if not keys and n >= 2:
        # No single column works: try pairs of key-like columns (a link table, a log keyed by two ids).
        likely = [c["name"] for c in t["columns"] if c["kind"] in ("int", "str") and looks_like_key(c["name"]) and c["nulls"] == 0][:6]
        for i, a in enumerate(likely):
            for b in likely[i + 1 :]:
                distinct = int(run(f"select count(*) from (select distinct {q(a)}, {q(b)} from {q(t['schema'])}.{q(t['table'])}) d")[0][0])
                if distinct == n:
                    keys.append({"columns": [a, b], "declared": False, "names_table": False, "evidence": [{"type": "profile", "text": f"`{a}` and `{b}` together are unique in {n:,} rows."}]})
    keys.sort(key=lambda k: (not k["declared"], not k["names_table"], len(k["columns"])))
    t["keys"] = keys
    t["grain"] = keys[0]["columns"] if keys else None


def name_match(column: str, key: str, key_table: str) -> bool:
    a, k = squash(column), squash(key)
    if k == "id":
        return any(a == s + "id" for s in stems(key_table))
    return a == k or a.endswith(k)


def infer_links(run: Run, tables: dict, exhaustive: bool = False) -> list[dict]:
    """Links whose every value appears in another table's key. By default only pairs whose names match are tested, so
    the scan costs one query per plausible link, not one per pair of columns. `exhaustive` tests every pair (research)."""
    links = []
    for fq, t in tables.items():
        for c in t["columns"]:
            if c["kind"] not in ("int", "str") or not c.get("distinct") or c["distinct"] < 2:
                continue
            targets = []
            for fq2, t2 in tables.items():
                # a table's own id that repeats (re-sent rows, versions) is still what other tables point at
                near = [{"columns": [g["column"]], "declared": False, "names_table": True, "evidence": [], "repeats": True} for g in t2.get("grain_breaks", [])]
                for key in t2.get("keys", []) + near:
                    if len(key["columns"]) != 1:
                        continue
                    k = key["columns"][0]
                    kc = next(x for x in t2["columns"] if x["name"] == k)
                    if kc["kind"] != c["kind"] or (fq == fq2 and k == c["name"]):
                        continue
                    named = name_match(c["name"], k, t2["table"])
                    if named or exhaustive:
                        targets.append((fq2, t2, key, k, named))
            for fq2, t2, key, k, named in targets:
                rel, rel2 = f"{q(t['schema'])}.{q(t['table'])}", f"{q(t2['schema'])}.{q(t2['table'])}"
                filled, found = run(f"select count(*), count(k.{q(k)}) from {rel} a left join (select distinct {q(k)} from {rel2}) k on a.{q(c['name'])} = k.{q(k)} where a.{q(c['name'])} is not null")[0]
                filled, found = int(filled), int(found)
                coverage = (found / filled) if filled else 0.0
                if coverage < 0.95:
                    continue
                one = c["distinct"] == t["rows"] - c["nulls"]
                links.append({
                    "from": fq, "from_columns": [c["name"]], "to": fq2, "to_columns": [k],
                    "cardinality": "one_to_one" if one and c["nulls"] == 0 else "many_to_one",
                    "coverage": round(coverage, 4), "named": named, "declared": False,
                    # the key is the table's own id (heroes.hero_id), not a copy of someone else's (dim_hero.hero_id)
                    "home": bool(key["declared"] or key.get("repeats") or (key["names_table"] and key is t2["keys"][0])),
                    "target_repeats": bool(key.get("repeats")),
                    # key to key: the same thing stored twice (a copy, a shard, an extension table), not a link between two things
                    "copy": bool(t["keys"]) and t["keys"][0]["columns"] == [c["name"]],
                    "evidence": [{"type": "profile", "text": f"{coverage:.0%} of `{t['table']}.{c['name']}` values are a `{t2['table']}.{k}`."}]
                    + ([{"type": "name", "text": f"The name `{c['name']}` matches the key `{k}`."}] if named else []),
                })
    for fq, t in tables.items():
        for d in t["declared_links"]:
            hit = next((l for l in links if l["from"] == fq and l["from_columns"] == d["columns"] and l["to"] == d["to"]), None)
            if hit:
                hit["declared"] = True
                hit["evidence"].insert(0, {"type": "declared", "text": "Declared as a foreign key in the database."})
            else:
                links.append({"from": fq, "from_columns": d["columns"], "to": d["to"], "to_columns": d["to_columns"], "cardinality": "many_to_one", "coverage": None, "named": True, "declared": True, "home": True, "copy": False, "target_repeats": False,
                              "evidence": [{"type": "declared", "text": "Declared as a foreign key in the database."}]})
    # A column that matches the same key name in several tables points at the table that owns the key.
    by_column: dict[tuple, list] = {}
    for l in links:
        by_column.setdefault((l["from"], tuple(l["from_columns"])), []).append(l)
    same_schema = lambda l: l["from"].split(".")[0] == l["to"].split(".")[0]
    rank = lambda l: 4 if l["declared"] else (0 if not l["named"] else 3 if l["home"] and same_schema(l) else 2 if l["home"] else 1)
    for group in by_column.values():
        best = max(rank(l) for l in group)
        for l in group:
            l["proposed"] = best > 0 and rank(l) == best and not (l["copy"] and not l["declared"])
    # A unique column that is really a link to another table's key is not this table's own key (reviews.quest_id).
    for l in links:
        t = tables[l["from"]]
        if l["proposed"] and len(t["keys"]) > 1:
            t["keys"] = [k for k in t["keys"] if k["declared"] or k["names_table"] or k["columns"] != l["from_columns"]]
            t["grain"] = t["keys"][0]["columns"]
    return links


def flags(t: dict) -> list[dict]:
    """Columns that usually mean "leave these rows out": a test or deleted flag, a status with a cancelled-like value."""
    out = []
    for c in t["columns"]:
        if c["kind"] == "bool" and FLAG_NAME.search(c["name"]) and c.get("top") and len(c["top"]) > 1:
            minority = min(c["top"], key=lambda v: v[1])
            out.append({"column": c["name"], "kind": "flag", "values": [minority[0]], "rows": minority[1]})
        elif c["kind"] == "str" and c.get("top") and STATUS_NAME.search(c["name"]):
            bad = [v for v in c["top"] if BAD_VALUE.search(str(v[0]))]
            if bad:
                out.append({"column": c["name"], "kind": "status", "values": [v[0] for v in bad], "rows": sum(v[1] for v in bad)})
    return out


def scan(run: Run, schemas: list[str] | None = None, dialect: str = "duckdb", exhaustive: bool = False, max_rows: int = 1_000_000) -> dict:
    tables = read_catalog(run, schemas, dialect)
    for t in tables.values():
        profile_table(run, t, max_rows)
        infer_keys(run, t)
        t["flags"] = flags(t)
        t["tz_columns"] = [c["name"] for c in t["columns"] if TZ_NAME.search(c["name"])]
        t["ingest_columns"] = [c["name"] for c in t["columns"] if INGEST_NAME.search(c["name"])]
        # C1: a column that looks like the table's own id but repeats means "one row per X" does not hold.
        t["grain_breaks"] = []
        exact = [c["name"] for c in t["columns"] if names_table(c["name"], t["table"])]
        own_id = lambda name: name in exact or (not exact and not t["keys"] and any(squash(name).endswith(s + "id") for s in stems(t["table"])))
        for c in t["columns"]:
            if c["kind"] in ("int", "str") and own_id(c["name"]) and c["distinct"] is not None and c["distinct"] < t["rows"] - (c["nulls"] or 0):
                t["grain_breaks"].append({"column": c["name"], "rows": t["rows"], "distinct": c["distinct"]})
    return {"tables": tables, "links": infer_links(run, tables, exhaustive)}


def linked_flags(scan_result: dict, fq: str) -> list[dict]:
    """Flags one link away: orders has no test flag, but each order belongs to a store, and stores has one."""
    out = []
    for l in scan_result["links"]:
        if l.get("proposed") and l["from"] == fq and l["to"] != fq:
            for flag in scan_result["tables"][l["to"]].get("flags", []):
                out.append({**flag, "table": l["to"], "via": l["from_columns"][0]})
    return out
