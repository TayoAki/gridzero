// Formula coverage: common Excel formulas over a small fixed block, with the result
// Excel gives. Each product runs the same list; `matches` decides agreement.
//
//   node bench/formulas.mjs > formulas.tsv     (a sheet to paste into another product)
//
// The data block sits in A1:C6; formulas go in column E, from row 1.

export const DATA = [
  ["Name", "Qty", "Price"],
  ["apple", 3, 1.5],
  ["banana", 5, 0.25],
  ["cherry", 2, 4],
  ["apple", 7, 1.5],
  ["date", 4, 2],
];

/** [area, formula, expected display]. */
export const FORMULAS = [
  ["math", "=SUM(B2:B6)", "21"],
  ["math", "=AVERAGE(B2:B6)", "4.2"],
  ["math", "=MIN(B2:B6)", "2"],
  ["math", "=MAX(B2:B6)", "7"],
  ["math", "=COUNT(B2:B6)", "5"],
  ["math", "=COUNTA(A2:A6)", "5"],
  ["math", "=COUNTBLANK(D1:D3)", "3"],
  ["math", "=PRODUCT(2,3,4)", "24"],
  ["math", "=ROUND(3.14159,2)", "3.14"],
  ["math", "=ROUNDUP(3.141,1)", "3.2"],
  ["math", "=ROUNDDOWN(3.19,1)", "3.1"],
  ["math", "=INT(-3.5)", "-4"],
  ["math", "=MOD(10,3)", "1"],
  ["math", "=ABS(-7)", "7"],
  ["math", "=POWER(2,10)", "1024"],
  ["math", "=SQRT(144)", "12"],
  ["math", "=CEILING(4.2,1)", "5"],
  ["math", "=FLOOR(4.8,1)", "4"],
  ["math", "=SUMPRODUCT(B2:B6,C2:C6)", "32.25"],
  ["math", '=SUMIF(A2:A6,"apple",B2:B6)', "10"],
  ["math", '=SUMIFS(B2:B6,A2:A6,"apple",C2:C6,1.5)', "10"],
  ["math", '=COUNTIF(A2:A6,"apple")', "2"],
  ["math", '=COUNTIFS(B2:B6,">3",C2:C6,"<2")', "2"],
  ["math", '=AVERAGEIF(A2:A6,"apple",B2:B6)', "5"],
  ["stats", "=MEDIAN(B2:B6)", "4"],
  ["stats", "=LARGE(B2:B6,2)", "5"],
  ["stats", "=SMALL(B2:B6,2)", "3"],
  ["stats", "=RANK.EQ(5,B2:B6)", "2"],
  ["stats", "=ROUND(STDEV.S(B2:B6),4)", "1.9235"],
  ["stats", "=ROUND(VAR.P(B2:B6),2)", "2.96"],
  ["text", '=LEN("spreadsheet")', "11"],
  ["text", '=UPPER("abc")', "ABC"],
  ["text", '=LOWER("ABC")', "abc"],
  ["text", '=PROPER("hello world")', "Hello World"],
  ["text", '=LEFT("GridZero",4)', "Grid"],
  ["text", '=RIGHT("GridZero",4)', "Zero"],
  ["text", '=MID("GridZero",3,2)', "id"],
  ["text", '=TRIM("  a  b  ")', "a b"],
  ["text", '=CONCAT("a","b","c")', "abc"],
  ["text", '="x"&"y"', "xy"],
  ["text", '=TEXTJOIN("-",TRUE,"a","","b")', "a-b"],
  ["text", '=SUBSTITUTE("a-b-c","-","+")', "a+b+c"],
  ["text", '=REPLACE("abcdef",2,3,"X")', "aXef"],
  ["text", '=FIND("c","abcabc")', "3"],
  ["text", '=SEARCH("C","abcabc")', "3"],
  ["text", '=REPT("ab",3)', "ababab"],
  ["text", '=EXACT("a","A")', "FALSE"],
  ["text", '=VALUE("42")', "42"],
  ["text", '=TEXT(0.256,"0.0%")', "25.6%"],
  ["text", '=TEXT(1234.5,"#,##0.00")', "1,234.50"],
  ["logic", '=IF(B2>2,"big","small")', "big"],
  ["logic", "=AND(TRUE,FALSE)", "FALSE"],
  ["logic", "=OR(TRUE,FALSE)", "TRUE"],
  ["logic", "=NOT(TRUE)", "FALSE"],
  ["logic", "=XOR(TRUE,FALSE)", "TRUE"],
  ["logic", '=IFERROR(1/0,"err")', "err"],
  ["logic", '=IFS(B3>4,"a",TRUE,"b")', "a"],
  ["logic", '=SWITCH(2,1,"one",2,"two","other")', "two"],
  ["logic", "=ISNUMBER(B2)", "TRUE"],
  ["logic", "=ISTEXT(A2)", "TRUE"],
  ["logic", "=ISBLANK(D1)", "TRUE"],
  ["logic", "=ISERROR(1/0)", "TRUE"],
  ["lookup", '=VLOOKUP("cherry",A2:C6,3,FALSE)', "4"],
  ["lookup", '=HLOOKUP("Qty",A1:C6,3,FALSE)', "5"],
  ["lookup", "=INDEX(B2:B6,4)", "7"],
  ["lookup", '=MATCH("date",A2:A6,0)', "5"],
  ["lookup", '=XLOOKUP("banana",A2:A6,C2:C6)', "0.25"],
  ["lookup", '=XMATCH("cherry",A2:A6)', "3"],
  ["lookup", '=CHOOSE(2,"a","b","c")', "b"],
  ["lookup", "=ROWS(A1:C6)", "6"],
  ["lookup", "=COLUMNS(A1:C6)", "3"],
  ["lookup", "=OFFSET(A1,2,1)", "5"],
  ["lookup", '=INDIRECT("B4")', "2"],
  ["arrays", "=COUNTA(UNIQUE(A2:A6))", "4"],
  ["arrays", "=INDEX(SORT(B2:B6,1,-1),1)", "7"],
  ["arrays", '=SUM(FILTER(B2:B6,A2:A6="apple"))', "10"],
  ["arrays", "=SUM(SEQUENCE(4))", "10"],
  ["arrays", "=LET(x,5,x*2)", "10"],
  ["arrays", "=LAMBDA(x,x+1)(2)", "3"],
  ["dates", "=YEAR(DATE(2024,2,29))", "2024"],
  ["dates", "=MONTH(DATE(2024,2,29))", "2"],
  ["dates", "=DAY(DATE(2024,2,29))", "29"],
  ["dates", "=DAYS(DATE(2024,3,1),DATE(2024,2,1))", "29"],
  ["dates", "=WEEKDAY(DATE(2024,1,1))", "2"],
  ["dates", '=TEXT(EOMONTH(DATE(2024,1,15),1),"yyyy-mm-dd")', "2024-02-29"],
  ["dates", '=TEXT(EDATE(DATE(2024,1,31),1),"yyyy-mm-dd")', "2024-02-29"],
  ["dates", "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))", "23"],
  ["dates", '=TEXT(DATE(2024,12,25),"dddd")', "Wednesday"],
  ["dates", "=HOUR(TIME(13,45,0))", "13"],
  ["finance", "=ROUND(PMT(0.05/12,360,200000),2)", "-1073.64"],
  ["finance", "=ROUND(FV(0.05,10,-100),2)", "1257.79"],
  ["finance", "=ROUND(NPV(0.1,100,100),2)", "173.55"],
  ["errors", "=1/0", "#DIV/0!"],
  ["errors", "=NA()", "#N/A"],
  ["errors", "=SQRT(-1)", "#NUM!"],
  ["errors", '=VLOOKUP("zzz",A2:C6,2,FALSE)', "#N/A"],
];

/** Same result, allowing for number formatting (1,234.5 vs 1234.5) and TRUE/true. */
export function matches(got, expected) {
  const g = String(got ?? "").trim();
  const e = String(expected).trim();
  if (g === e || g.toUpperCase() === e.toUpperCase()) return true;
  const n = (s) => (/^-?[\d,]*\.?\d+(e-?\d+)?$/i.test(s) ? Number(s.replace(/,/g, "")) : NaN);
  const [a, b] = [n(g), n(e)];
  return !Number.isNaN(a) && !Number.isNaN(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

/** A sheet to paste into another product: data in A:C, formula in E, Excel's answer in G. */
export function pasteSheet() {
  const lines = [];
  for (let i = 0; i < FORMULAS.length; i++) {
    const data = DATA[i] ?? ["", "", ""];
    const [, formula, expected] = FORMULAS[i];
    lines.push([...data, "", formula, "", `'${expected}`].join("\t"));
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("bench/formulas.mjs")) process.stdout.write(pasteSheet());
