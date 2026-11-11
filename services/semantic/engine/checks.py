"""The grader: checks that need no AI. Each reads a query's syntax tree against the scan's profiles and returns
findings {check, level, message, data}. C1 comes from the scan itself; C8 (a trusted number) is compare.py.

  C2 a join multiplies rows      C5 time zones
  C3 empty values                C6 double counting
  C4 test and cancelled rows     C7 WHERE and HAVING
"""
from __future__ import annotations

from sqlglot import exp

from .history import Names, Scope, conjuncts, derived_relations, is_window_agg, join_pairs, parse, own
from .scan import linked_flags

SAFE_AGGS = (exp.Min, exp.Max)
TZ_FUNCS = ("CONVERT_TIMEZONE", "FROM_UTC_TIMESTAMP", "TO_UTC_TIMESTAMP", "CONVERT_TZ", "TIMEZONE")
BUCKETS = (exp.DateTrunc, exp.TimestampTrunc, exp.Extract, exp.Year, exp.Month, exp.Week, exp.Day, exp.Date, exp.TsOrDsToDate, exp.DayOfWeek, exp.WeekOfYear)


def column_info(tables: dict, hit: tuple[str, str]) -> dict:
    return next(c for c in tables[hit[0]]["columns"] if c["name"] == hit[1])


def is_unique(tables: dict, fq: str, cols: list[str], scope: Scope | None = None) -> bool:
    """Do these columns identify one row of the table? True if any one of them is unique, or they are a known key.
    A view or CTE that keeps one row per key (GROUP BY, ROW_NUMBER() = 1) is unique on that key even if the table is not."""
    t = tables[fq]
    if scope is not None and fq in scope.unique:
        return bool({c.lower() for c in cols} & scope.unique[fq]) or scope.unique[fq] <= {c.lower() for c in cols}
    if any(c in t.get("unique", []) for c in cols):
        return True
    return any(set(k["columns"]) <= set(cols) for k in t.get("keys", []))


def finding(check: str, level: str, message: str, **data) -> dict:
    return {"check": check, "level": level, "message": message, "data": data}


def lint_select(select: exp.Select, tables: dict, names: Names, derived: dict | None = None) -> list[dict]:
    out: list[dict] = []
    scope = Scope(select, names, derived)
    if not scope.tables:
        return out
    short = lambda fq: fq.split(".")[-1]
    aggs = [a for a in own(select, exp.AggFunc) if not is_window_agg(a)]
    referenced = {hit for c in own(select, exp.Column) if (hit := scope.resolve(c))}

    # ---- C2 / C6: joins that multiply rows
    by_join: dict[int, list] = {}
    for j, a, b in join_pairs(select, scope):
        by_join.setdefault(id(j), []).append((a, b))
    for pairs in by_join.values():
        sides: dict[str, list[str]] = {}
        for a, b in pairs:
            sides.setdefault(a[0], []).append(a[1])
            sides.setdefault(b[0], []).append(b[1])
        if len(sides) != 2:
            continue
        (t1, c1), (t2, c2) = sides.items()
        u1, u2 = is_unique(tables, t1, c1, scope), is_unique(tables, t2, c2, scope)
        if not u1 and not u2:
            out.append(finding("C2", "fail", f"Joining `{short(t1)}` to `{short(t2)}` on {', '.join(c1)} matches many rows to many rows, so rows are repeated.", tables=[t1, t2], columns=c1))
            continue
        for many, one in ((t1, t2), (t2, t1)):
            # `one` has one row per key; `many` repeats it. Sums over `one`'s columns are counted once per `many` row.
            if not is_unique(tables, many, sides[many], scope) and is_unique(tables, one, sides[one], scope):
                for a in aggs:
                    if isinstance(a, SAFE_AGGS) or a.find(exp.Distinct):
                        continue
                    cols = [hit for c in a.find_all(exp.Column) if (hit := scope.resolve(c))]
                    if cols and all(h[0] == one for h in cols) and not any(h[1] in sides[one] for h in cols):
                        out.append(finding("C2", "fail", f"`{a.sql(dialect='duckdb')}` reads `{short(one)}`, but the join to `{short(many)}` repeats each `{short(one)}` row once per match, so it is counted more than once.", tables=[one, many], expression=a.sql(dialect="duckdb")))

    # ---- C3: empty values
    for a in aggs:
        if isinstance(a, (exp.Avg, exp.Count)) and isinstance(a.this, exp.Column) and (hit := scope.resolve(a.this)):
            info = column_info(tables, hit)
            if info.get("nulls"):
                what = "averages only the rows that have a value" if isinstance(a, exp.Avg) else "counts only the rows that have a value"
                out.append(finding("C3", "warn", f"`{a.sql(dialect='duckdb')}` {what}: {info['nulls']} of {tables[hit[0]]['rows']} rows in `{short(hit[0])}` have no `{hit[1]}`.", column=list(hit), nulls=info["nulls"]))
    for c in conjuncts(select.args.get("where")):
        target = c.this if isinstance(c, exp.Not) else c
        if isinstance(c, exp.NEQ) or (isinstance(c, exp.Not) and isinstance(target, (exp.In, exp.EQ, exp.Like))):
            col = target.this if isinstance(target.this, exp.Column) else None
            if col is not None and (hit := scope.resolve(col)) and column_info(tables, hit).get("nulls"):
                out.append(finding("C3", "warn", f"`{c.sql(dialect='duckdb')}` also drops the {column_info(tables, hit)['nulls']} rows where `{hit[1]}` is empty.", column=list(hit)))

    # ---- C5: time zones
    tz_tables = [fq for fq in tables if tables[fq].get("tz_columns")]
    if tz_tables:
        for b in own(select, BUCKETS) + [f for f in own(select, exp.Anonymous) if f.name.upper() in ("DATE_TRUNC", "DATE", "TO_DATE", "WEEK", "DATE_PART")]:
            cols = [hit for c in b.find_all(exp.Column) if (hit := scope.resolve(c)) and column_info(tables, hit)["kind"] == "timestamp"]
            if not cols:
                continue
            converted = b.find(exp.AtTimeZone, exp.ConvertTimezone, exp.FromTimeZone) or any(f.name.upper() in TZ_FUNCS for f in b.find_all(exp.Anonymous)) or "from_utc_timestamp" in b.sql().lower() or "at time zone" in b.sql().lower()
            if not converted:
                where = tz_tables[0]
                out.append(finding("C5", "fail", f"`{b.sql(dialect='duckdb')}` cuts days and weeks on the stored time, but `{short(where)}.{tables[where]['tz_columns'][0]}` says the business runs in other time zones.", column=list(cols[0]), tz_table=where))
                break

    # ---- C6: double counting
    if select.args.get("distinct"):
        for fq in scope.tables:
            t = tables[fq]
            if t.get("grain_breaks") or t.get("ingest_columns"):
                why = f"`{t['grain_breaks'][0]['column']}` repeats in {t['grain_breaks'][0]['rows'] - t['grain_breaks'][0]['distinct']} rows" if t.get("grain_breaks") else f"`{t['ingest_columns'][0]}` differs between copies"
                out.append(finding("C6", "warn", f"DISTINCT only removes rows that are identical in every column. In `{short(fq)}`, {why}, so copies can survive.", table=fq))
                break
    for a in aggs:
        if isinstance(a, exp.Count) and isinstance(a.this, exp.Star):
            for fq in scope.tables:
                if tables[fq].get("grain_breaks") and len(scope.tables) == 1:
                    g = tables[fq]["grain_breaks"][0]
                    out.append(finding("C6", "warn", f"`COUNT(*)` counts {g['rows']} rows in `{short(fq)}`, but there are only {g['distinct']} different `{g['column']}`.", table=fq))
    if aggs and len(scope.tables) == 1:
        t = tables[scope.tables[0]]
        if t.get("grain_breaks") and not any(f["check"] == "C6" for f in out) and any(isinstance(a, (exp.Sum, exp.Avg)) for a in aggs):
            g = t["grain_breaks"][0]
            out.append(finding("C6", "warn", f"`{short(scope.tables[0])}` has {g['rows']} rows for {g['distinct']} different `{g['column']}`, so totals count some of them more than once.", table=scope.tables[0]))

    # ---- C7: WHERE and HAVING
    having = select.args.get("having")
    for c in conjuncts(having):
        if not c.find(exp.AggFunc) and c.find(exp.Column):
            out.append(finding("C7", "warn", f"`{c.sql(dialect='duckdb')}` is in HAVING but does not use a total. It filters groups after they are built; as a row filter it belongs in WHERE.", condition=c.sql(dialect="duckdb")))
    for j in select.args.get("joins") or []:
        if (j.side or "").upper() == "LEFT" and isinstance(j.this, exp.Table) and (right := names.table(j.this)):
            for c in conjuncts(select.args.get("where")):
                if isinstance(c, exp.Is) or (isinstance(c, exp.Not) and isinstance(c.this, exp.Is)):
                    continue
                if c.find(exp.Coalesce) or isinstance(c, exp.Or):
                    continue
                hits = [hit for col in c.find_all(exp.Column) if (hit := scope.resolve(col))]
                if hits and all(h[0] == right for h in hits):
                    out.append(finding("C7", "fail", f"`{c.sql(dialect='duckdb')}` filters `{short(right)}` after a LEFT JOIN, which drops every row that has no match and turns it into an inner join. Put the condition in the ON clause.", condition=c.sql(dialect="duckdb"), table=right))
    return out


def lint_flags(tree: exp.Expression, tables: dict, names: Names, scan_result: dict | None = None) -> list[dict]:
    """C4, for a whole statement: it works out a total over a table that marks some rows as test, cancelled or
    inactive, and never mentions that column (through any CTE or subquery)."""
    if not any(not is_window_agg(a) for a in tree.find_all(exp.AggFunc)):
        return []
    read = {fq for t in tree.find_all(exp.Table) if (fq := names.table(t))}
    mentioned = {c.name.lower() for c in tree.find_all(exp.Column)}
    out = []
    for fq in sorted(read):
        for flag in tables[fq].get("flags", []):
            if flag["column"].lower() not in mentioned:
                values = ", ".join(str(v) for v in flag["values"])
                out.append(finding("C4", "warn", f"{flag['rows']} of {tables[fq]['rows']} rows in `{fq.split('.')[-1]}` have `{flag['column']}` = {values}, and this counts them.", table=fq, column=flag["column"], values=flag["values"], rows=flag["rows"]))
        for flag in linked_flags(scan_result, fq) if scan_result else []:
            if flag["column"].lower() not in mentioned:
                other = flag["table"].split(".")[-1]
                values = ", ".join(str(v) for v in flag["values"])
                out.append(finding("C4", "warn", f"`{fq.split('.')[-1]}` rows belong to `{other}` (through `{flag['via']}`), and {flag['rows']} `{other}` rows have `{flag['column']}` = {values}. This counts their rows.", table=fq, flag_table=flag["table"], column=flag["column"], values=flag["values"], via=flag["via"]))
    return out


def lint(sql: str, dialect: str, tables: dict, scan_result: dict | None = None) -> list[dict]:
    """Every finding for every SELECT in the statement(s). The same finding is reported once. Pass the whole scan
    as `scan_result` to also follow links (a test flag on a linked table)."""
    names = Names(tables)
    seen, out = set(), []
    trees = parse(sql, dialect)
    derived = derived_relations(trees, names)
    for tree in trees:
        for f in lint_flags(tree, tables, names, scan_result):
            if (f["check"], f["message"]) not in seen:
                seen.add((f["check"], f["message"]))
                out.append(f)
        for select in tree.find_all(exp.Select):
            try:
                found = lint_select(select, tables, names, derived)
            except Exception:
                found = []  # a construct the checks do not understand must not stop the others
            for f in found:
                key = (f["check"], f["message"])
                if key not in seen:
                    seen.add(key)
                    out.append(f)
    return out


def grain_findings(tables: dict) -> list[dict]:
    """C1: tables where "one row per X" does not hold."""
    out = []
    for fq, t in tables.items():
        for g in t.get("grain_breaks", []):
            out.append(finding("C1", "fail", f"`{t['table']}` has {g['rows']:,} rows but {g['distinct']:,} different `{g['column']}`: {g['rows'] - g['distinct']:,} rows repeat one.", table=fq, **g))
    return out


def resolve_expression(expression: str, dialect: str, tables: dict) -> dict:
    """C10: does the expression parse, and is every table.column in it real? Returns {ok, error?, expression, tables,
    aggregate}. `expression` comes back normalised (columns as table.column) in the same dialect."""
    import sqlglot

    names = Names(tables, dialect)
    try:
        node = sqlglot.parse_one(expression, read=dialect)
    except Exception as e:
        return {"ok": False, "error": f"That is not valid SQL: {str(e).splitlines()[0][:160]}"}
    if node.find(exp.Select, exp.Subquery) is not None:
        return {"ok": False, "error": "Use one expression, not a whole query."}
    everything = sqlglot.parse_one("SELECT 1 FROM " + ", ".join(f'"{t["schema"]}"."{t["table"]}"' for t in tables.values()), read="duckdb")
    scope = Scope(everything, names)
    used = []
    for col in node.find_all(exp.Column):
        hit = scope.resolve(col)
        if not hit:
            where = f"`{col.table}.{col.name}`" if col.table else f"`{col.name}`"
            return {"ok": False, "error": f"There is no column {where} in the scanned tables (write columns as table.column)."}
        used.append(hit[0])
    return {"ok": True, "expression": scope.text(node), "tables": sorted(set(used)), "aggregate": node.find(exp.AggFunc) is not None}
