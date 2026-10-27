"""Generate tests/golden/s1_formulas.json for Spike S1.

Expected values follow documented Excel semantics. They are hand-verified,
not exported from Excel (no Excel available when the spike ran); financial
and statistical expectations are computed below from the standard closed-form
definitions so they are exact to float precision.

Run: python -I tests/golden/gen_s1_cases.py
"""
import json
import math
import pathlib
import statistics

# Fixture loaded into Sheet1 before each case.
FIXTURE = {
    **{f"A{i}": i for i in range(1, 11)},
    "B1": "apple", "B2": "banana", "B3": "cherry", "B4": "date", "B5": "elderberry",
    "C1": 10, "C2": 20, "C3": 30, "C4": 40, "C5": 50,
    "D1": "North", "D2": "South", "D3": "North", "D4": "East", "D5": "North",
    "E1": True, "E2": False,
    "F1": 45306,  # 2024-01-15
    "G1": "  hello   world  ", "G2": "Hello",
}

A = list(range(1, 11))


def num(v, tol=1e-9):
    return {"type": "number", "value": v, "tol": tol}


def s(v):
    return {"type": "string", "value": v}


def b(v):
    return {"type": "bool", "value": v}


def err(v):
    return {"type": "error", "value": v}


def irr(flows):
    lo, hi = -0.99, 10.0
    f = lambda r: sum(c / (1 + r) ** i for i, c in enumerate(flows))
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def rate(nper, pmt, pv):
    lo, hi = 1e-9, 1.0
    f = lambda r: pv * (1 + r) ** nper + pmt * ((1 + r) ** nper - 1) / r
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


r = 0.05 / 12
pmt = -(200000 * r * (1 + r) ** 360) / ((1 + r) ** 360 - 1)

CASES = [
    # --- math & arithmetic ---
    ("math", "=SUM(A1:A10)", num(55)),
    ("math", "=AVERAGE(A1:A10)", num(5.5)),
    ("math", "=MIN(A1:A10)", num(1)),
    ("math", "=MAX(A1:A10)", num(10)),
    ("math", "=PRODUCT(A1:A5)", num(120)),
    ("math", "=ROUND(2.345,2)", num(2.35)),
    ("math", "=ROUND(-2.5,0)", num(-3)),
    ("math", "=ROUNDUP(3.14159,2)", num(3.15)),
    ("math", "=ROUNDDOWN(3.14159,2)", num(3.14)),
    ("math", "=INT(-3.7)", num(-4)),
    ("math", "=TRUNC(-3.7)", num(-3)),
    ("math", "=MOD(10,3)", num(1)),
    ("math", "=MOD(-10,3)", num(2)),
    ("math", "=ABS(-42)", num(42)),
    ("math", "=POWER(2,10)", num(1024)),
    ("math", "=SQRT(144)", num(12)),
    ("math", "=PI()", num(math.pi, 1e-12)),
    ("math", "=EXP(1)", num(math.e, 1e-12)),
    ("math", "=LN(EXP(2))", num(2)),
    ("math", "=LOG10(1000)", num(3)),
    ("math", "=LOG(8,2)", num(3)),
    ("math", "=SUMPRODUCT(A1:A3,C1:C3)", num(140)),
    ("math", '=SUMIF(D1:D5,"North",C1:C5)', num(90)),
    ("math", '=SUMIFS(C1:C5,D1:D5,"North",C1:C5,">20")', num(80)),
    ("math", "=CEILING(4.3,1)", num(5)),
    ("math", "=FLOOR(4.7,1)", num(4)),
    ("math", "=MROUND(10,3)", num(9)),
    ("math", "=GCD(24,36)", num(12)),
    ("math", "=LCM(4,6)", num(12)),
    ("math", "=FACT(5)", num(120)),
    ("math", "=COMBIN(5,2)", num(10)),
    ("math", "=QUOTIENT(17,5)", num(3)),
    ("math", "=SIGN(-5)", num(-1)),
    ("math", "=EVEN(3)", num(4)),
    ("math", "=ODD(2)", num(3)),
    ("math", "=SUMSQ(1,2,3)", num(14)),
    ("math", "=1/0", err("#DIV/0!")),
    ("math", "=2^3+4*5", num(28)),
    ("math", "=-2^2", num(4)),
    ("math", "=10%", num(0.1)),
    ("math", "=0.1+0.2", num(0.3, 1e-15)),
    # --- statistical ---
    ("stat", "=COUNT(A1:A10)", num(10)),
    ("stat", "=COUNTA(B1:B5)", num(5)),
    ("stat", "=COUNTBLANK(H1:H5)", num(5)),
    ("stat", '=COUNTIF(D1:D5,"North")', num(3)),
    ("stat", '=COUNTIFS(D1:D5,"North",C1:C5,">=30")', num(2)),
    ("stat", '=AVERAGEIF(D1:D5,"North",C1:C5)', num(30)),
    ("stat", "=MEDIAN(A1:A10)", num(5.5)),
    ("stat", "=MEDIAN(1,3,2)", num(2)),
    ("stat", "=MODE.SNGL(1,2,2,3)", num(2)),
    ("stat", "=STDEV.S(A1:A10)", num(statistics.stdev(A))),
    ("stat", "=STDEV.P(A1:A10)", num(statistics.pstdev(A))),
    ("stat", "=VAR.S(A1:A10)", num(statistics.variance(A))),
    ("stat", "=VAR.P(A1:A10)", num(statistics.pvariance(A))),
    ("stat", "=LARGE(A1:A10,2)", num(9)),
    ("stat", "=SMALL(A1:A10,3)", num(3)),
    ("stat", "=RANK.EQ(30,C1:C5)", num(3)),
    ("stat", "=PERCENTILE.INC(A1:A10,0.25)", num(3.25)),
    ("stat", "=QUARTILE.INC(A1:A10,3)", num(7.75)),
    ("stat", '=MAXIFS(C1:C5,D1:D5,"North")', num(50)),
    ("stat", '=MINIFS(C1:C5,D1:D5,"North")', num(10)),
    ("stat", "=GEOMEAN(1,2,4)", num(2)),
    ("stat", "=CORREL(A1:A5,C1:C5)", num(1)),
    ("stat", "=SLOPE(C1:C5,A1:A5)", num(10)),
    ("stat", "=INTERCEPT(C1:C5,A1:A5)", num(0, 1e-9)),
    ("stat", "=AVERAGEA(E1:E2)", num(0.5)),
    ("stat", "=AVERAGE(E1:E2,4)", num(4)),
    # --- logical ---
    ("logic", '=IF(A1>0,"pos","neg")', s("pos")),
    ("logic", '=IF(A1>5,"big")', b(False)),
    ("logic", "=AND(TRUE,FALSE)", b(False)),
    ("logic", "=OR(TRUE,FALSE)", b(True)),
    ("logic", "=NOT(E1)", b(False)),
    ("logic", "=XOR(TRUE,TRUE)", b(False)),
    ("logic", '=IFERROR(1/0,"err")', s("err")),
    ("logic", '=IFNA(NA(),"na")', s("na")),
    ("logic", '=IFS(A5>8,"a",A5>3,"b",TRUE,"c")', s("b")),
    ("logic", '=SWITCH(2,1,"one",2,"two","other")', s("two")),
    ("logic", "=IF(TRUE,1,1/0)", num(1)),
    ("logic", "=TRUE+TRUE", num(2)),
    ("logic", '=A1="1"', b(False)),
    ("logic", '="a"="A"', b(True)),
    # --- text ---
    ("text", '=CONCATENATE("a","b","c")', s("abc")),
    ("text", '="x"&"y"&1', s("xy1")),
    ("text", '=LEFT("spreadsheet",6)', s("spread")),
    ("text", '=RIGHT("spreadsheet",5)', s("sheet")),
    ("text", '=MID("spreadsheet",7,5)', s("sheet")),
    ("text", '=LEN("hello")', num(5)),
    ("text", '=UPPER("abc")', s("ABC")),
    ("text", '=LOWER("ABC")', s("abc")),
    ("text", '=PROPER("hello world")', s("Hello World")),
    ("text", "=TRIM(G1)", s("hello world")),
    ("text", '=SUBSTITUTE("a-b-c","-","+")', s("a+b+c")),
    ("text", '=SUBSTITUTE("a-b-c","-","+",2)', s("a-b+c")),
    ("text", '=REPLACE("abcdef",2,3,"X")', s("aXef")),
    ("text", '=FIND("c","abcabc")', num(3)),
    ("text", '=FIND("c","abcabc",4)', num(6)),
    ("text", '=SEARCH("B","abc")', num(2)),
    ("text", '=FIND("B","abc")', err("#VALUE!")),
    ("text", '=REPT("ab",3)', s("ababab")),
    ("text", '=EXACT("a","A")', b(False)),
    ("text", '=TEXT(1234.567,"#,##0.00")', s("1,234.57")),
    ("text", '=TEXT(0.25,"0%")', s("25%")),
    ("text", '=TEXT(45306,"yyyy-mm-dd")', s("2024-01-15")),
    ("text", '=VALUE("42")', num(42)),
    ("text", '=TEXTJOIN("-",TRUE,"a","","b")', s("a-b")),
    ("text", "=CHAR(65)", s("A")),
    ("text", '=CODE("A")', num(65)),
    ("text", '=TEXTBEFORE("user@example.com","@")', s("user")),
    ("text", '=TEXTAFTER("user@example.com","@")', s("example.com")),
    ("text", "=CONCAT(B1:B2)", s("applebanana")),
    ("text", "=T(42)", s("")),
    ("text", '="10"+5', num(15)),
    ("text", '=LEN(G1)', num(17)),
    # --- lookup & reference ---
    ("lookup", '=VLOOKUP("cherry",B1:C5,2,FALSE)', num(30)),
    ("lookup", '=VLOOKUP("fig",B1:C5,2,FALSE)', err("#N/A")),
    ("lookup", "=INDEX(C1:C5,4)", num(40)),
    ("lookup", '=MATCH("date",B1:B5,0)', num(4)),
    ("lookup", "=INDEX(B1:C5,2,2)", num(20)),
    ("lookup", '=XLOOKUP("banana",B1:B5,C1:C5)', num(20)),
    ("lookup", '=XLOOKUP("fig",B1:B5,C1:C5,"missing")', s("missing")),
    ("lookup", "=XMATCH(40,C1:C5)", num(4)),
    ("lookup", '=CHOOSE(2,"a","b","c")', s("b")),
    ("lookup", "=ROWS(A1:A10)", num(10)),
    ("lookup", "=COLUMNS(A1:D1)", num(4)),
    ("lookup", "=ROW(C7)", num(7)),
    ("lookup", "=COLUMN(D1)", num(4)),
    ("lookup", "=ADDRESS(2,3)", s("$C$2")),
    ("lookup", '=INDIRECT("A3")', num(3)),
    ("lookup", "=SUM(OFFSET(A1,2,0,3,1))", num(12)),
    ("lookup", "=LOOKUP(3.5,A1:A10)", num(3)),
    ("lookup", "=MATCH(35,C1:C5,1)", num(3)),
    ("lookup", "=INDEX(A1:A10,MATCH(7,A1:A10,0))", num(7)),
    ("lookup", "=INDEX(A1:A3,5)", err("#REF!")),
    ("lookup", "=FOOBAR(1)", err("#NAME?")),
    # --- dynamic arrays & lambdas ---
    ("dynamic", "=SUM(SEQUENCE(5))", num(15)),
    ("dynamic", "=ROWS(UNIQUE(D1:D5))", num(3)),
    ("dynamic", '=SUM(FILTER(C1:C5,D1:D5="North"))', num(90)),
    ("dynamic", "=INDEX(SORT(C1:C5,1,-1),1)", num(50)),
    ("dynamic", "=SUM(TRANSPOSE(A1:A3))", num(6)),
    ("dynamic", "=LET(x,5,y,x*2,x+y)", num(15)),
    ("dynamic", "=LAMBDA(x,x*2)(21)", num(42)),
    ("dynamic", "=SUM(A1:A10*2)", num(110)),
    ("dynamic", "=INDEX(TAKE(A1:A10,-2),1)", num(9)),
    ("dynamic", "=SEQUENCE(3,1,10,10)", num(10), [[2, 0, num(30)]]),
    ("dynamic", "=SORT(C1:C3,1,-1)", num(30), [[1, 0, num(20)], [2, 0, num(10)]]),
    ("dynamic", "=SUM(MAP(A1:A3,LAMBDA(v,v*v)))", num(14)),
    # --- date & time ---
    ("date", "=DATE(2024,1,15)", num(45306)),
    ("date", "=YEAR(F1)", num(2024)),
    ("date", "=MONTH(F1)", num(1)),
    ("date", "=DAY(F1)", num(15)),
    ("date", "=WEEKDAY(F1)", num(2)),
    ("date", "=EOMONTH(F1,1)", num(45351)),
    ("date", "=EDATE(F1,1)", num(45337)),
    ("date", '=DATEDIF(DATE(2020,1,1),DATE(2024,1,1),"Y")', num(4)),
    ("date", "=DAYS(DATE(2024,3,1),DATE(2024,2,1))", num(29)),
    ("date", "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))", num(23)),
    ("date", "=TIME(12,0,0)", num(0.5)),
    ("date", "=HOUR(0.75)", num(18)),
    ("date", '=DATEVALUE("2024-01-15")', num(45306)),
    ("date", "=DATE(1900,3,1)", num(61)),
    ("date", "=YEARFRAC(DATE(2024,1,1),DATE(2024,7,1))", num(0.5)),
    # --- financial ---
    ("financial", "=PMT(0.05/12,360,200000)", num(pmt, 1e-7)),
    ("financial", "=FV(0.05,10,-100)", num(100 * ((1.05 ** 10) - 1) / 0.05, 1e-9)),
    ("financial", "=PV(0.05,10,-100)", num(100 * (1 - 1.05 ** -10) / 0.05, 1e-9)),
    ("financial", "=NPV(0.1,100,100,100)", num(sum(100 / 1.1 ** k for k in (1, 2, 3)), 1e-9)),
    ("financial", "=IRR({-100,60,60})", num(irr([-100, 60, 60]), 1e-7)),
    ("financial", "=NPER(0.05,-100,500)", num(-math.log(1 - 0.05 * 500 / 100) / math.log(1.05), 1e-9)),
    ("financial", "=SLN(10000,1000,5)", num(1800)),
    ("financial", "=RATE(10,-100,800)", num(rate(10, -100, 800), 1e-7)),
    # --- information ---
    ("info", "=ISNUMBER(A1)", b(True)),
    ("info", "=ISTEXT(B1)", b(True)),
    ("info", "=ISBLANK(H1)", b(True)),
    ("info", "=ISERROR(1/0)", b(True)),
    ("info", '=ISNA(VLOOKUP("x",B1:C5,2,FALSE))', b(True)),
    ("info", '=TYPE("a")', num(2)),
    ("info", "=N(TRUE)", num(1)),
    # --- engineering ---
    ("eng", "=DEC2BIN(10)", s("1010")),
    ("eng", '=HEX2DEC("FF")', num(255)),
    ("eng", "=BITAND(12,10)", num(8)),
    ("eng", '=CONVERT(1,"km","m")', num(1000)),
]


def main():
    out = []
    for i, c in enumerate(CASES, start=1):
        cat, formula, expect = c[0], c[1], c[2]
        case = {"id": f"S1-{i:03d}", "category": cat, "formula": formula, "expect": expect}
        if len(c) > 3:
            case["spill"] = [{"dr": dr, "dc": dc, "expect": e} for dr, dc, e in c[3]]
        out.append(case)
    doc = {
        "source": "hand-verified against documented Excel semantics (not Excel-exported)",
        "fixture": FIXTURE,
        "formula_cell": "Z1",
        "cases": out,
    }
    path = pathlib.Path(__file__).with_name("s1_formulas.json")
    path.write_text(json.dumps(doc, indent=1))
    print(f"wrote {len(out)} cases to {path}")


if __name__ == "__main__":
    main()
