"""Read query history (or any pile of SQL people wrote) into joins, named measures, filters and groupings.

Only syntax is read, with sqlglot: nothing here runs a query.
"""
from __future__ import annotations

import collections
import logging
import re

import sqlglot
from sqlglot import exp

logging.getLogger("sqlglot").setLevel(logging.ERROR)

PRESENTATION = (exp.Round, exp.Cast, exp.TryCast, exp.Paren)


class Names:
    """Looks up tables and columns of a scan by bare, case-insensitive name."""

    def __init__(self, tables: dict, dialect: str = "duckdb"):
        self.dialect = dialect  # the dialect normalised expressions are written in (the source's own)
        self.by_table: dict[str, list[str]] = collections.defaultdict(list)
        self.columns: dict[str, dict[str, str]] = {}
        for fq, t in tables.items():
            self.by_table[t["table"].lower()].append(fq)
            self.columns[fq] = {c["name"].lower(): c["name"] for c in t["columns"]}

    def table(self, node: exp.Table) -> str | None:
        hits = self.by_table.get(node.name.lower(), [])
        if len(hits) > 1 and node.db:
            narrowed = [h for h in hits if h.split(".")[0].lower() == node.db.lower()]
            hits = narrowed or hits
        return hits[0] if hits else None


def parse(sql: str, dialect: str) -> list[exp.Expression]:
    try:
        return [t for t in sqlglot.parse(sql, read=dialect) if t is not None]
    except Exception:
        return []


def own(select: exp.Select, kind) -> list:
    """Nodes of `kind` that belong to this SELECT, not to a subquery inside it."""
    out = []
    for node in select.find_all(kind):
        parent = node.parent_select if node is not select else None
        if parent is select:
            out.append(node)
    return out


def derived_relations(trees: list[exp.Expression], names: Names) -> dict[str, dict]:
    """Views and CTEs, each traced back to the base table it mainly reads: {name: {base, unique}}. `unique` is the
    set of columns the relation has one row per (from GROUP BY, or ROW_NUMBER() ... = 1), or None when it keeps its
    source's rows. A rough lineage, enough to see through `WITH latest AS (...)` and `CREATE VIEW clean_orders`."""
    out: dict[str, dict] = {}

    def describe(query: exp.Expression) -> dict | None:
        select = query if isinstance(query, exp.Select) else query.find(exp.Select)
        if select is None:
            return None
        src = select.args.get("from_") or select.args.get("from")
        node = src.this if src is not None else None
        if not isinstance(node, exp.Table):
            return None
        fq = names.table(node)
        inner = out.get(node.name.lower())
        base = fq or (inner and inner["base"])
        if not base:
            return None
        unique = set(inner["unique"]) if inner and inner["unique"] else None
        group = select.args.get("group")
        if group:
            unique = {g.name.lower() for g in group.expressions if isinstance(g, exp.Column)} or None
        qualify = select.args.get("qualify")
        if qualify is not None:
            for w in qualify.find_all(exp.Window):
                if isinstance(w.this, exp.RowNumber):
                    unique = {c.name.lower() for p in (w.args.get("partition_by") or []) for c in [p] if isinstance(c, exp.Column)} or unique
        return {"base": base, "unique": unique}

    for tree in trees:
        for cte in tree.find_all(exp.CTE):
            if (d := describe(cte.this)):
                out[cte.alias.lower()] = d
        if isinstance(tree, exp.Create) and isinstance(tree.this, (exp.Table, exp.Schema)) and tree.expression is not None:
            target = tree.this if isinstance(tree.this, exp.Table) else tree.this.this
            if (d := describe(tree.expression)) and not names.table(target):
                out[target.name.lower()] = d
    return out


class Scope:
    """The base tables one SELECT reads and how its columns map onto them."""

    def __init__(self, select: exp.Select, names: Names, derived: dict | None = None):
        self.select, self.names = select, names
        self.alias: dict[str, str] = {}
        self.tables: list[str] = []
        self.unique: dict[str, set] = {}  # base table -> columns a view or CTE over it has one row per
        sources = [select.args.get("from_") or select.args.get("from")] + list(select.args.get("joins") or [])
        for src in sources:
            node = src.this if src is not None else None
            if isinstance(node, exp.Table):
                fq = names.table(node)
                via = (derived or {}).get(node.name.lower()) if not fq else None
                if via:
                    fq = via["base"]
                    if via["unique"]:
                        self.unique[fq] = via["unique"]
                if fq:
                    self.alias[(node.alias or node.name).lower()] = fq
                    self.alias.setdefault(node.name.lower(), fq)
                    if fq not in self.tables:
                        self.tables.append(fq)

    def resolve(self, col: exp.Column) -> tuple[str, str] | None:
        name = col.name.lower()
        if col.table:
            fq = self.alias.get(col.table.lower())
            return (fq, self.names.columns[fq][name]) if fq and name in self.names.columns[fq] else None
        hits = [fq for fq in self.tables if name in self.names.columns[fq]]
        return (hits[0], self.names.columns[hits[0]][name]) if len(hits) == 1 else None

    def text(self, node: exp.Expression) -> str:
        """The expression with every column written as table.column, so the same idea reads the same in any query."""
        def fix(n):
            # `flag = TRUE` and `flag` are one rule; so are `flag = FALSE` and `NOT flag`.
            if isinstance(n, exp.EQ) and isinstance(n.this, exp.Column) and isinstance(n.expression, exp.Boolean):
                col = fix(n.this)
                return col if n.expression.this else exp.Not(this=col)
            if isinstance(n, exp.Column):
                hit = self.resolve(n)
                if hit:
                    return exp.column(hit[1], table=hit[0].split(".")[-1])
                return exp.column(n.name)
            return n
        return node.copy().transform(fix).sql(dialect=self.names.dialect)

    def tables_of(self, node: exp.Expression) -> list[str]:
        return sorted({hit[0] for c in node.find_all(exp.Column) if (hit := self.resolve(c))})


def strip_presentation(node: exp.Expression) -> exp.Expression:
    """ROUND(SUM(x), 2) and CAST(SUM(x) AS DECIMAL) are the same measure as SUM(x)."""
    while isinstance(node, PRESENTATION) and node.this is not None and node.this.find(exp.AggFunc):
        node = node.this
    return node


def conjuncts(node: exp.Expression | None) -> list[exp.Expression]:
    if node is None:
        return []
    node = node.this if isinstance(node, (exp.Where, exp.Having)) else node
    return list(node.flatten()) if isinstance(node, exp.And) else [node]


def is_rule_like(node: exp.Expression) -> bool:
    """A filter simple enough to name: a column against fixed values."""
    if isinstance(node, exp.Not):
        return is_rule_like(node.this)
    if isinstance(node, (exp.Column, exp.Boolean)):
        return isinstance(node, exp.Column)
    if isinstance(node, (exp.EQ, exp.NEQ, exp.Is, exp.Like, exp.ILike)):
        return isinstance(node.this, exp.Column) and isinstance(node.expression, (exp.Literal, exp.Boolean, exp.Null))
    if isinstance(node, exp.In):
        return isinstance(node.this, exp.Column) and all(isinstance(e, exp.Literal) for e in node.expressions) and not node.args.get("query")
    return False


def is_window_agg(agg: exp.Expression) -> bool:
    return agg.find_ancestor(exp.Window) is not None


def join_pairs(select: exp.Select, scope: Scope) -> list[tuple]:
    """Equalities between two base-table columns in this SELECT's joins (ON or USING)."""
    pairs = []
    for j in select.args.get("joins") or []:
        on = j.args.get("on")
        for eq in on.find_all(exp.EQ) if on else []:
            if isinstance(eq.left, exp.Column) and isinstance(eq.right, exp.Column):
                a, b = scope.resolve(eq.left), scope.resolve(eq.right)
                if a and b and a != b:
                    pairs.append((j, a, b))
        using = j.args.get("using") or []
        joined = scope.names.table(j.this) if isinstance(j.this, exp.Table) else None
        for u in using:
            name = u.name.lower()
            others = [fq for fq in scope.tables if fq != joined and name in scope.names.columns[fq]]
            if joined and others and name in scope.names.columns[joined]:
                pairs.append((j, (others[0], scope.names.columns[others[0]][name]), (joined, scope.names.columns[joined][name])))
    return pairs


def trace(statements: list[dict], tables: dict, dialect: str = "duckdb") -> dict:
    """statements: [{sql, dialect, user?, ref?}]. Returns counts of what people actually wrote. `dialect` is the
    one expressions are written back in."""
    names = Names(tables, dialect)
    joins: dict[tuple, dict] = {}
    measures: list[dict] = []
    filters: dict[tuple, dict] = {}
    groupings: dict[tuple, dict] = {}
    parsed = failed = 0

    def bump(store, key, user, **extra):
        item = store.setdefault(key, {"count": 0, "users": set(), **extra})
        item["count"] += 1
        item["users"].add(user)

    for st in statements:
        trees = parse(st["sql"], st.get("dialect", "duckdb"))
        if not trees:
            failed += 1
            continue
        derived = derived_relations(trees, names)
        parsed += 1
        user = st.get("user") or st.get("ref") or "?"
        for tree in trees:
            for select in tree.find_all(exp.Select):
                scope = Scope(select, names, derived)
                if not scope.tables:
                    continue
                for _, a, b in join_pairs(select, scope):
                    bump(joins, tuple(sorted([a, b])), user)
                where = [c for c in conjuncts(select.args.get("where"))]
                where_text = sorted(scope.text(c) for c in where if is_rule_like(c) and scope.tables_of(c))
                for c in where:
                    if is_rule_like(c) and (ts := scope.tables_of(c)):
                        bump(filters, (scope.text(c), ts[0]), user)
                group = select.args.get("group")
                for g in (group.expressions if group else []):
                    if isinstance(g, exp.Column) and (hit := scope.resolve(g)):
                        bump(groupings, hit, user)
                for p in select.expressions:
                    body = p.this if isinstance(p, exp.Alias) else p
                    aggs = [a for a in body.find_all(exp.AggFunc) if not is_window_agg(a) and a.parent_select is select]
                    if not aggs:
                        continue
                    core = strip_presentation(body)
                    ts = scope.tables_of(core) or scope.tables[:1]
                    measures.append({
                        "name": p.alias.lower() if isinstance(p, exp.Alias) else None,
                        "expression": scope.text(core), "tables": ts, "filters": where_text,
                        "user": user, "ref": st.get("ref"),
                    })
    pack = lambda store: [{"key": k, "count": v["count"], "people": len(v["users"])} for k, v in sorted(store.items(), key=lambda kv: -kv[1]["count"])]
    return {"parsed": parsed, "failed": failed, "joins": pack(joins), "filters": pack(filters), "groupings": pack(groupings), "measures": measures}


def literal_free(sql: str) -> str:
    """Query text safe to keep as evidence: long literals and numbers replaced with ?; short category values kept."""
    sql = re.sub(r"'(?:[^']|''){25,}'", "?", sql)
    return re.sub(r"\b\d{5,}\b", "?", sql)
