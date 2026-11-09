//! Table-name references such as `=SUM(sales[units])`.
//!
//! IronCalc's own structured references turn into fixed ranges when parsed, so they
//! would go stale as a Data Table grows or filters. Instead each referenced column
//! gets a hidden defined name: the formula is stored against the name, the name
//! follows the table (`sync_structured`, after every mutation and on load), and the
//! formula bar shows `sales[units]` again.

use std::sync::OnceLock;

use ironcalc_base::UserModel;
use regex::Regex;
use tables::Manifest;

use crate::Workbook;

const PREFIX: &str = "_gzt_";

pub(crate) fn is_hidden(name: &str) -> bool {
    name.len() >= PREFIX.len() && name[..PREFIX.len()].eq_ignore_ascii_case(PREFIX)
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<String> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect();
    String::from_utf8(bytes?).ok()
}

fn hidden_name(table_id: &str, column: &str) -> String {
    format!("{PREFIX}{table_id}_{}", hex(column))
}

/// (table id, column name) of a hidden name.
fn parse_hidden(name: &str) -> Option<(String, String)> {
    let rest = name.get(PREFIX.len()..)?;
    let (id, col) = rest.split_once('_')?;
    Some((id.to_ascii_lowercase(), unhex(col)?))
}

/// A table's name as written in formulas: anything but letters, digits and `_` or `.`
/// becomes `_`, so a table called "my data" is `my_data[...]`.
fn formula_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Apply `f` to the parts of a formula outside string literals.
fn outside_strings(formula: &str, mut f: impl FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(formula.len());
    for (i, part) in formula.split('"').enumerate() {
        if i > 0 {
            out.push('"');
        }
        if i % 2 == 0 {
            out.push_str(&f(part));
        } else {
            out.push_str(part);
        }
    }
    out
}

/// Swap `table[column]` for hidden names; also returns the names the formula needs.
/// Unknown tables and columns are left alone, for the parser to report.
pub(crate) fn rewrite(raw: &str, m: &Manifest) -> (String, Vec<String>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"([A-Za-z_][A-Za-z0-9_.]*)\[\[?([^\[\]]+)\]?\]").expect("valid pattern")
    });
    if !raw.starts_with('=') || !raw.contains('[') {
        return (raw.to_string(), Vec::new());
    }
    let mut names = Vec::new();
    let text = outside_strings(raw, |part| {
        re.replace_all(part, |c: &regex::Captures| {
            let whole = c[0].to_string();
            let Some(t) = m
                .tables
                .iter()
                .find(|t| formula_name(&t.name).eq_ignore_ascii_case(&c[1]))
            else {
                return whole;
            };
            let Some(col) = t
                .columns
                .iter()
                .find(|col| col.name.eq_ignore_ascii_case(c[2].trim()))
            else {
                return whole;
            };
            let name = hidden_name(&t.id, &col.name);
            names.push(name.clone());
            name
        })
        .into_owned()
    });
    (text, names)
}

/// Show hidden names as `table[column]` again.
pub(crate) fn display(formula: &str, m: &Manifest) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)_gzt_[a-z0-9]+_[0-9a-f]+").expect("valid pattern"));
    if !formula.starts_with('=') {
        return formula.to_string();
    }
    outside_strings(formula, |part| {
        re.replace_all(part, |c: &regex::Captures| {
            let whole = c[0].to_string();
            let Some((id, col)) = parse_hidden(&whole) else {
                return whole;
            };
            match m.tables.iter().find(|t| t.id.eq_ignore_ascii_case(&id)) {
                Some(t) => format!("{}[{col}]", formula_name(&t.name)),
                None => whole,
            }
        })
        .into_owned()
    })
}

/// A valid range to create a hidden name with before its real one is known.
pub(crate) fn placeholder(um: &UserModel) -> String {
    format!("{}!$A$1", quoted(&um.get_worksheets_properties()[0].name))
}

fn quoted(sheet: &str) -> String {
    format!("'{}'", sheet.replace('\'', "''"))
}

fn column_letters(mut c: u32) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            return out;
        }
        c = c / 26 - 1;
    }
}

impl Workbook {
    /// Where a hidden name should point now; `#REF!` when its table or column is gone.
    fn structured_target(&self, name: &str, sheet_names: &[String]) -> String {
        let Some((id, col)) = parse_hidden(name) else {
            return "#REF!".into();
        };
        let Some(spec) = self
            .tables
            .manifest()
            .tables
            .iter()
            .find(|t| t.id.eq_ignore_ascii_case(&id))
        else {
            return "#REF!".into();
        };
        let Some(sheet_name) = sheet_names.get(spec.sheet as usize) else {
            return "#REF!".into();
        };
        for t in self.tables.regions(spec.sheet) {
            if t.id != spec.id {
                continue;
            }
            for vis in 0..t.visible.len() as u32 {
                if self.tables.column_name(&t.id, vis).as_deref() == Some(col.as_str()) {
                    let letters = column_letters(t.col + vis);
                    // Spreadsheet rows are 1-based; the header sits at t.row.
                    let first = t.row + 2;
                    let last = (t.row as u64 + 1 + t.rows.max(1)).min(crate::MAX_ROWS as u64);
                    return format!(
                        "{}!${letters}${first}:${letters}${last}",
                        quoted(sheet_name)
                    );
                }
            }
        }
        "#REF!".into()
    }

    /// Point every hidden name at its table's current cells; true when any moved.
    pub(crate) fn sync_structured(&mut self) -> bool {
        let list: Vec<(String, String)> = self
            .um
            .get_defined_name_list()
            .into_iter()
            .filter(|(n, _, _)| is_hidden(n))
            .map(|(n, _, f)| (n, f))
            .collect();
        if list.is_empty() {
            return false;
        }
        let sheets: Vec<String> = self
            .um
            .get_worksheets_properties()
            .into_iter()
            .map(|s| s.name)
            .collect();
        let mut changed = false;
        for (name, formula) in list {
            let want = self.structured_target(&name, &sheets);
            if want != formula
                && self
                    .um
                    .get_model_mut()
                    .update_defined_name(&name, None, &name, None, &want)
                    .is_ok()
            {
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_names_round_trip() {
        assert!(is_hidden("_GZT_t1_61"));
        assert_eq!(unhex(&hex("unit price")).as_deref(), Some("unit price"));
        assert_eq!(
            parse_hidden(&hidden_name("t12", "a_b")),
            Some(("t12".to_string(), "a_b".to_string()))
        );
        assert_eq!(column_letters(0), "A");
        assert_eq!(column_letters(27), "AB");
        assert_eq!(formula_name("my data-2"), "my_data_2");
    }

    #[test]
    fn leaves_strings_and_unknown_tables_alone() {
        let m = Manifest::default();
        let (t, n) = rewrite("=sales[units]&\"sales[units]\"", &m);
        assert_eq!(t, "=sales[units]&\"sales[units]\"");
        assert!(n.is_empty());
    }
}
