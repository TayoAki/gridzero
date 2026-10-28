//! Computed-column formulas (PRD FR-7): an Excel-like expression over a table's
//! columns, compiled to a Polars expression so it runs vectorised over every row.
//!
//!   =[revenue] * (1 - [discount])
//!   =IF([units] > 25, "bulk", "single")
//!   =UPPER(LEFT([region], 1)) & "-" & [order_id]
//!
//! Columns are written `[name]`, or bare when the name is a simple identifier.
//! Operators: + - * / ^ & = <> < > <= >= and unary minus. Functions are listed in
//! `call`.

use polars::prelude::*;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Col(String),
    Ident(String),
    Op(&'static str),
    LParen,
    RParen,
    Comma,
}

fn tokenize(src: &str) -> Result<Vec<Tok>, String> {
    let s: Vec<char> = src.trim().trim_start_matches('=').chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        match c {
            ' ' | '\t' | '\n' | '\r' => i += 1,
            '(' => {
                out.push(Tok::LParen);
                i += 1
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1
            }
            ',' => {
                out.push(Tok::Comma);
                i += 1
            }
            '"' => {
                let mut text = String::new();
                i += 1;
                loop {
                    match s.get(i) {
                        None => return Err("unterminated string".into()),
                        Some('"') if s.get(i + 1) == Some(&'"') => {
                            text.push('"');
                            i += 2
                        }
                        Some('"') => {
                            i += 1;
                            break;
                        }
                        Some(&ch) => {
                            text.push(ch);
                            i += 1
                        }
                    }
                }
                out.push(Tok::Str(text));
            }
            '[' => {
                let end = s[i..].iter().position(|&ch| ch == ']').ok_or("missing ]")?;
                out.push(Tok::Col(s[i + 1..i + end].iter().collect()));
                i += end + 1;
            }
            '0'..='9' | '.' => {
                let start = i;
                while i < s.len() && (s[i].is_ascii_digit() || s[i] == '.') {
                    i += 1;
                }
                if i < s.len() && (s[i] == 'e' || s[i] == 'E') {
                    i += 1;
                    if i < s.len() && (s[i] == '+' || s[i] == '-') {
                        i += 1;
                    }
                    while i < s.len() && s[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let text: String = s[start..i].iter().collect();
                out.push(Tok::Num(
                    text.parse().map_err(|_| format!("bad number {text}"))?,
                ));
            }
            c if c.is_alphabetic() || c == '_' => {
                let start = i;
                while i < s.len() && (s[i].is_alphanumeric() || s[i] == '_' || s[i] == '.') {
                    i += 1;
                }
                out.push(Tok::Ident(s[start..i].iter().collect()));
            }
            _ => {
                let two: String = s[i..(i + 2).min(s.len())].iter().collect();
                let op = match two.as_str() {
                    "<>" => Some("<>"),
                    "<=" => Some("<="),
                    ">=" => Some(">="),
                    "!=" => Some("<>"),
                    "==" => Some("="),
                    _ => None,
                };
                if let Some(op) = op {
                    out.push(Tok::Op(op));
                    i += 2;
                    continue;
                }
                let op = match c {
                    '+' => "+",
                    '-' => "-",
                    '*' => "*",
                    '/' => "/",
                    '^' => "^",
                    '&' => "&",
                    '=' => "=",
                    '<' => "<",
                    '>' => ">",
                    '%' => "%",
                    _ => return Err(format!("unexpected character '{c}'")),
                };
                out.push(Tok::Op(op));
                i += 1;
            }
        }
    }
    Ok(out)
}

/// Compile `src` against the table's column names (matched case-insensitively).
pub fn compile(src: &str, columns: &[String]) -> Result<Expr, String> {
    let toks = tokenize(src)?;
    if toks.is_empty() {
        return Err("the formula is empty".into());
    }
    let mut p = Parser {
        toks,
        pos: 0,
        columns,
    };
    let e = p.expr(0)?;
    if p.pos != p.toks.len() {
        return Err(format!("unexpected {:?}", p.toks[p.pos]));
    }
    Ok(e)
}

/// Column names a formula refers to, for dependency checks.
pub fn references(src: &str, columns: &[String]) -> Vec<String> {
    let Ok(toks) = tokenize(src) else {
        return Vec::new();
    };
    toks.into_iter()
        .filter_map(|t| match t {
            Tok::Col(n) | Tok::Ident(n) => find(columns, &n).map(str::to_string),
            _ => None,
        })
        .collect()
}

fn find<'a>(columns: &'a [String], name: &str) -> Option<&'a str> {
    columns
        .iter()
        .find(|c| c.as_str() == name)
        .or_else(|| columns.iter().find(|c| c.eq_ignore_ascii_case(name)))
        .map(String::as_str)
}

struct Parser<'a> {
    toks: Vec<Tok>,
    pos: usize,
    columns: &'a [String],
}

fn binding(op: &str) -> (u8, u8) {
    match op {
        "=" | "<>" | "<" | ">" | "<=" | ">=" => (1, 2),
        "&" => (3, 4),
        "+" | "-" => (5, 6),
        "*" | "/" | "%" => (7, 8),
        "^" => (10, 9),
        _ => (0, 0),
    }
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn expr(&mut self, min: u8) -> Result<Expr, String> {
        let mut lhs = self.unary()?;
        while let Some(Tok::Op(op)) = self.peek() {
            let op = *op;
            let (l, r) = binding(op);
            if l < min {
                break;
            }
            self.pos += 1;
            let rhs = self.expr(r)?;
            lhs = match op {
                "+" => lhs + rhs,
                "-" => lhs - rhs,
                "*" => lhs * rhs,
                "/" => lhs.cast(DataType::Float64) / rhs.cast(DataType::Float64),
                "%" => lhs % rhs,
                "^" => lhs.cast(DataType::Float64).pow(rhs.cast(DataType::Float64)),
                "&" => concat_str([text(lhs), text(rhs)], "", true),
                "=" => lhs.eq(rhs),
                "<>" => lhs.neq(rhs),
                "<" => lhs.lt(rhs),
                ">" => lhs.gt(rhs),
                "<=" => lhs.lt_eq(rhs),
                ">=" => lhs.gt_eq(rhs),
                _ => unreachable!(),
            };
        }
        Ok(lhs)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Some(Tok::Op("-")) => {
                self.pos += 1;
                Ok(lit(0) - self.expr(9)?)
            }
            Some(Tok::Op("+")) => {
                self.pos += 1;
                self.expr(9)
            }
            _ => self.primary(),
        }
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Some(Tok::Num(n)) => Ok(if n.fract() == 0.0 && n.abs() < 9e15 {
                lit(n as i64)
            } else {
                lit(n)
            }),
            Some(Tok::Str(s)) => Ok(lit(s)),
            Some(Tok::Col(name)) => self.column(&name),
            Some(Tok::LParen) => {
                let e = self.expr(0)?;
                self.expect_rparen()?;
                Ok(e)
            }
            Some(Tok::Ident(name)) => {
                if self.peek() == Some(&Tok::LParen) {
                    self.pos += 1;
                    let mut args = Vec::new();
                    if self.peek() != Some(&Tok::RParen) {
                        loop {
                            args.push(self.expr(0)?);
                            match self.next() {
                                Some(Tok::Comma) => continue,
                                Some(Tok::RParen) => break,
                                _ => return Err(format!("expected , or ) in {name}()")),
                            }
                        }
                    } else {
                        self.pos += 1;
                    }
                    call(&name, args)
                } else if name.eq_ignore_ascii_case("TRUE") {
                    Ok(lit(true))
                } else if name.eq_ignore_ascii_case("FALSE") {
                    Ok(lit(false))
                } else {
                    self.column(&name)
                }
            }
            Some(t) => Err(format!("unexpected {t:?}")),
            None => Err("the formula ends early".into()),
        }
    }

    fn column(&self, name: &str) -> Result<Expr, String> {
        find(self.columns, name)
            .map(col)
            .ok_or_else(|| format!("no column named \"{name}\""))
    }

    fn expect_rparen(&mut self) -> Result<(), String> {
        match self.next() {
            Some(Tok::RParen) => Ok(()),
            _ => Err("missing )".into()),
        }
    }
}

fn text(e: Expr) -> Expr {
    e.cast(DataType::String)
}

fn int_arg(e: &Expr, what: &str) -> Result<i64, String> {
    match e {
        Expr::Literal(lv) => lv
            .to_any_value()
            .and_then(|v| v.extract::<i64>())
            .ok_or_else(|| format!("{what} must be a whole number")),
        _ => Err(format!("{what} must be a number, not a column")),
    }
}

fn call(name: &str, mut a: Vec<Expr>) -> Result<Expr, String> {
    let upper = name.to_ascii_uppercase();
    let n = a.len();
    let want = |k: std::ops::RangeInclusive<usize>| -> Result<(), String> {
        if k.contains(&n) {
            Ok(())
        } else {
            Err(format!(
                "{upper}() takes {} arguments, got {n}",
                if k.start() == k.end() {
                    k.start().to_string()
                } else {
                    format!("{}-{}", k.start(), k.end())
                }
            ))
        }
    };
    let f64_ = |e: Expr| e.cast(DataType::Float64);
    Ok(match upper.as_str() {
        "IF" => {
            want(2..=3)?;
            let otherwise = if n == 3 { a.pop().unwrap() } else { lit(NULL) };
            let then = a.pop().unwrap();
            when(a.pop().unwrap()).then(then).otherwise(otherwise)
        }
        "AND" | "OR" => {
            if n == 0 {
                return Err(format!("{upper}() needs arguments"));
            }
            let mut it = a.into_iter();
            let first = it.next().unwrap();
            it.fold(first, |acc, e| {
                if upper == "AND" {
                    acc.and(e)
                } else {
                    acc.or(e)
                }
            })
        }
        "NOT" => {
            want(1..=1)?;
            a.pop().unwrap().not()
        }
        "ABS" => {
            want(1..=1)?;
            a.pop().unwrap().abs()
        }
        "ROUND" => {
            want(1..=2)?;
            let digits = if n == 2 {
                int_arg(&a.pop().unwrap(), "ROUND digits")?
            } else {
                0
            };
            f64_(a.pop().unwrap()).round(digits.max(0) as u32, RoundMode::HalfAwayFromZero)
        }
        "FLOOR" | "INT" => {
            want(1..=1)?;
            f64_(a.pop().unwrap()).floor()
        }
        "CEILING" => {
            want(1..=1)?;
            f64_(a.pop().unwrap()).ceil()
        }
        "SQRT" => {
            want(1..=1)?;
            f64_(a.pop().unwrap()).sqrt()
        }
        "POWER" => {
            want(2..=2)?;
            let y = a.pop().unwrap();
            f64_(a.pop().unwrap()).pow(f64_(y))
        }
        "LN" => {
            want(1..=1)?;
            f64_(a.pop().unwrap()).log(lit(std::f64::consts::E))
        }
        "LOG10" => {
            want(1..=1)?;
            f64_(a.pop().unwrap()).log(lit(10.0))
        }
        "EXP" => {
            want(1..=1)?;
            f64_(a.pop().unwrap()).exp()
        }
        "MOD" => {
            want(2..=2)?;
            let d = a.pop().unwrap();
            a.pop().unwrap() % d
        }
        "MIN" | "MAX" => {
            if n == 0 {
                return Err(format!("{upper}() needs arguments"));
            }
            if upper == "MIN" {
                polars::lazy::dsl::min_horizontal(a).map_err(|e| e.to_string())?
            } else {
                polars::lazy::dsl::max_horizontal(a).map_err(|e| e.to_string())?
            }
        }
        "UPPER" => {
            want(1..=1)?;
            text(a.pop().unwrap()).str().to_uppercase()
        }
        "LOWER" => {
            want(1..=1)?;
            text(a.pop().unwrap()).str().to_lowercase()
        }
        "LEN" => {
            want(1..=1)?;
            text(a.pop().unwrap()).str().len_chars()
        }
        "TRIM" => {
            want(1..=1)?;
            text(a.pop().unwrap()).str().strip_chars(lit(NULL))
        }
        "LEFT" | "RIGHT" => {
            want(1..=2)?;
            let k = if n == 2 { a.pop().unwrap() } else { lit(1) };
            let s = text(a.pop().unwrap());
            if upper == "LEFT" {
                s.str().head(k)
            } else {
                s.str().tail(k)
            }
        }
        "MID" => {
            want(3..=3)?;
            let len = a.pop().unwrap();
            let start = a.pop().unwrap();
            text(a.pop().unwrap()).str().slice(start - lit(1), len)
        }
        "CONCAT" | "CONCATENATE" => {
            if n == 0 {
                return Err(format!("{upper}() needs arguments"));
            }
            concat_str(a.into_iter().map(text).collect::<Vec<_>>(), "", true)
        }
        "SUBSTITUTE" => {
            want(3..=3)?;
            let new = a.pop().unwrap();
            let old = a.pop().unwrap();
            text(a.pop().unwrap()).str().replace_all(old, new, true)
        }
        "CONTAINS" => {
            want(2..=2)?;
            let needle = a.pop().unwrap();
            text(a.pop().unwrap()).str().contains_literal(needle)
        }
        "YEAR" | "MONTH" | "DAY" | "WEEKDAY" | "HOUR" => {
            want(1..=1)?;
            let d = a.pop().unwrap().dt();
            match upper.as_str() {
                "YEAR" => d.year(),
                "MONTH" => d.month(),
                "DAY" => d.day(),
                "WEEKDAY" => d.weekday(),
                _ => d.hour(),
            }
        }
        "TEXT" => {
            want(1..=1)?;
            text(a.pop().unwrap())
        }
        "VALUE" => {
            want(1..=1)?;
            a.pop().unwrap().strict_cast(DataType::Float64)
        }
        "ISBLANK" => {
            want(1..=1)?;
            a.pop().unwrap().is_null()
        }
        "COALESCE" | "IFNULL" | "IFBLANK" => {
            if n < 2 {
                return Err(format!("{upper}() needs at least 2 arguments"));
            }
            coalesce(&a)
        }
        _ => return Err(format!("unknown function {upper}()")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn df() -> DataFrame {
        df!(
            "units" => [10i64, 30, 5],
            "price" => [2.0, 1.5, 4.0],
            "discount" => [Some(0.1), None, Some(0.5)],
            "region" => ["north", "South", "east"],
        )
        .unwrap()
    }

    fn eval(src: &str) -> Series {
        let d = df();
        let names: Vec<String> = d.get_column_names().iter().map(|s| s.to_string()).collect();
        let e = compile(src, &names).unwrap();
        d.lazy()
            .select([e.alias("out")])
            .collect()
            .unwrap()
            .column("out")
            .unwrap()
            .as_materialized_series()
            .clone()
    }

    fn texts(src: &str) -> Vec<String> {
        let s = eval(src);
        (0..s.len())
            .map(|i| importer::display(&s.get(i).unwrap()))
            .collect()
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(
            texts("=[units] * [price] * (1 - COALESCE([discount], 0))"),
            ["18", "45", "10"]
        );
        assert_eq!(texts("=2 + 3 * 4 ^ 2")[0], "50");
        assert_eq!(texts("=-units + 1"), ["-9", "-29", "-4"]);
        assert_eq!(texts("=units / 4")[0], "2.5");
    }

    #[test]
    fn text_functions_and_if() {
        assert_eq!(
            texts(r#"=IF(units > 25, "bulk", "single") & "-" & UPPER(LEFT(region, 1))"#),
            ["single-N", "bulk-S", "single-E"]
        );
        assert_eq!(texts("=LEN([region])")[1], "5");
        assert_eq!(texts("=ROUND(price / 3, 2)")[0], "0.67");
        assert_eq!(
            texts("=AND(units >= 10, NOT(ISBLANK(discount)))"),
            ["TRUE", "FALSE", "FALSE"]
        );
        assert_eq!(texts("=MAX(units, 12)"), ["12", "30", "12"]);
        assert_eq!(
            texts(r#"=SUBSTITUTE(region, "th", "TH")"#),
            ["norTH", "SouTH", "east"]
        );
    }

    #[test]
    fn errors_name_the_problem() {
        let names = vec!["a".to_string()];
        assert!(compile("=[b] + 1", &names).unwrap_err().contains("\"b\""));
        assert!(compile("=FOO(a)", &names).unwrap_err().contains("FOO"));
        assert!(compile("=(a + 1", &names).unwrap_err().contains(")"));
        assert!(compile("=IF(a)", &names).unwrap_err().contains("IF()"));
        assert_eq!(references("=[A] + a * 2", &names), ["a", "a"]);
    }
}
