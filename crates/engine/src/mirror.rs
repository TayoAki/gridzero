//! Cell formulas reading Data Table and pivot cells.
//!
//! Tables and pivots are drawn over the grid without writing their values into
//! IronCalc, so a formula like `=B5` or `=SUM(F2:F9)` over one would see blanks.
//! The mirror writes into IronCalc exactly the region cells that some formula
//! references, straight into the model (`get_model_mut`, a vendored patch) so they
//! stay out of the undo history and the op-log. They are derived state: rebuilt
//! after every mutation, after load, and kept out of snapshots.
//!
//! Structural edits (rows, columns, sheets) and undo/redo move cells under the
//! mirror's feet, so before those the mirror is cleared and written afresh.

use std::collections::HashMap;
use std::sync::OnceLock;

use protocol::Action;
use regex::Regex;
use tables::CellVal;

use crate::{Workbook, MAX_COLS, MAX_ROWS};

/// Most region cells mirrored at once unless MIRROR_MAX_CELLS says otherwise;
/// references beyond it read as blanks.
pub const MAX_MIRROR_CELLS: usize = 10_000_000;

fn mirror_limit() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        std::env::var("MIRROR_MAX_CELLS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(MAX_MIRROR_CELLS)
    })
}

/// (sheet, row, col), 1-based like IronCalc.
type Key = (u32, i32, i32);

#[derive(Default)]
pub(crate) struct Mirror {
    cells: HashMap<Key, CellVal>,
    /// What the cells were derived from; unchanged means nothing to do.
    key: String,
}

impl Mirror {
    pub fn contains(&self, sheet: u32, row: i32, col: i32) -> bool {
        self.cells.contains_key(&(sheet, row, col))
    }
}

/// A rectangle a formula references, 0-based and inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct Rect {
    pub sheet: u32,
    pub r0: u32,
    pub c0: u32,
    pub r1: u32,
    pub c1: u32,
}

/// Actions after which mirrored cells may no longer sit where they were written.
fn moves_cells(action: &Action) -> bool {
    matches!(
        action,
        Action::Undo
            | Action::Redo
            | Action::InsertRows { .. }
            | Action::DeleteRows { .. }
            | Action::InsertCols { .. }
            | Action::DeleteCols { .. }
            | Action::AddSheet
            | Action::DeleteSheet { .. }
            | Action::MoveSheet { .. }
            | Action::DuplicateSheet { .. }
    )
}

fn col_number(letters: &str) -> Option<u32> {
    let mut n: u32 = 0;
    for b in letters.bytes() {
        n = n * 26 + (b.to_ascii_uppercase() - b'A' + 1) as u32;
    }
    (1..=MAX_COLS).contains(&n).then(|| n - 1)
}

fn row_number(digits: &str) -> Option<u32> {
    let n: u32 = digits.parse().ok()?;
    (1..=MAX_ROWS).contains(&n).then(|| n - 1)
}

/// The cell and range references in a formula (as IronCalc prints it). Generous:
/// a false match only mirrors a few extra cells.
pub(crate) fn references(formula: &str, sheet: u32, sheet_names: &[String]) -> Vec<Rect> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(concat!(
            r"(?:(?P<sheet>'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?",
            r"(?:\$?(?P<c0>[A-Za-z]{1,3})\$?(?P<r0>[0-9]+)(?::\$?(?P<c1>[A-Za-z]{1,3})\$?(?P<r1>[0-9]+))?",
            r"|\$?(?P<cc0>[A-Za-z]{1,3}):\$?(?P<cc1>[A-Za-z]{1,3})",
            r"|\$?(?P<rr0>[0-9]+):\$?(?P<rr1>[0-9]+))",
        ))
        .expect("valid pattern")
    });
    // Blank out string literals so their contents are not read as references.
    let mut text = String::with_capacity(formula.len());
    let mut in_string = false;
    for ch in formula.chars() {
        if ch == '"' {
            in_string = !in_string;
            text.push(ch);
        } else {
            text.push(if in_string { ' ' } else { ch });
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    for m in re.captures_iter(&text) {
        let whole = m.get(0).expect("match");
        let before = whole.start().checked_sub(1).map(|i| bytes[i]);
        let after = bytes.get(whole.end()).copied();
        if before.is_some_and(|b| b.is_ascii_alphanumeric() || b"_.$'".contains(&b))
            || after.is_some_and(|b| b.is_ascii_alphanumeric() || b"_(!".contains(&b))
        {
            continue;
        }
        let target = match m.name("sheet") {
            Some(name) => {
                let name = name.as_str();
                let name = name
                    .strip_prefix('\'')
                    .and_then(|n| n.strip_suffix('\''))
                    .map(|n| n.replace("''", "'"))
                    .unwrap_or_else(|| name.to_string());
                match sheet_names
                    .iter()
                    .position(|s| s.eq_ignore_ascii_case(&name))
                {
                    Some(i) => i as u32,
                    None => continue,
                }
            }
            None => sheet,
        };
        let rect = if let (Some(c0), Some(r0)) = (m.name("c0"), m.name("r0")) {
            let (Some(c0), Some(r0)) = (col_number(c0.as_str()), row_number(r0.as_str())) else {
                continue;
            };
            let (c1, r1) = match (m.name("c1"), m.name("r1")) {
                (Some(c1), Some(r1)) => match (col_number(c1.as_str()), row_number(r1.as_str())) {
                    (Some(c1), Some(r1)) => (c1, r1),
                    _ => continue,
                },
                _ => (c0, r0),
            };
            (r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1))
        } else if let (Some(a), Some(b)) = (m.name("cc0"), m.name("cc1")) {
            let (Some(a), Some(b)) = (col_number(a.as_str()), col_number(b.as_str())) else {
                continue;
            };
            (0, a.min(b), MAX_ROWS - 1, a.max(b))
        } else if let (Some(a), Some(b)) = (m.name("rr0"), m.name("rr1")) {
            let (Some(a), Some(b)) = (row_number(a.as_str()), row_number(b.as_str())) else {
                continue;
            };
            (a.min(b), 0, a.max(b), MAX_COLS - 1)
        } else {
            continue;
        };
        out.push(Rect {
            sheet: target,
            r0: rect.0,
            c0: rect.1,
            r1: rect.2,
            c1: rect.3,
        });
    }
    out
}

/// One region's rectangle and how to read it.
enum Source {
    Table { id: String },
    Pivot { index: usize },
}

impl Workbook {
    /// Whether any sheet has a table or pivot (otherwise the mirror costs nothing).
    fn has_regions(&self) -> bool {
        let m = self.tables.manifest();
        !m.tables.is_empty() || !m.pivots.is_empty()
    }

    /// Every rectangle referenced by a formula, deduplicated.
    fn demand(&self) -> Vec<Rect> {
        let model = self.um.get_model();
        let names: Vec<String> = model
            .workbook
            .worksheets
            .iter()
            .map(|w| w.name.clone())
            .collect();
        let mut out = Vec::new();
        for (s, ws) in model.workbook.worksheets.iter().enumerate() {
            let s = s as u32;
            for (r, c, cell) in ws.sheet_data.cells() {
                if cell.get_formula().is_none() {
                    continue;
                }
                if let Ok(Some(f)) = model.get_cell_formula(s, r, c) {
                    out.extend(references(&f, s, &names));
                }
            }
        }
        // Defined names reach cells too, including the hidden `sales[units]` ones.
        for (_, _, f) in model.get_defined_name_list() {
            out.extend(references(&f, 0, &names));
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Region rectangles per sheet: (sheet, r0, c0, r1, c1) 0-based inclusive.
    fn mirror_regions(&self) -> Vec<(Rect, Source)> {
        let mut out = Vec::new();
        for sheet in 0..self.um.get_model().workbook.worksheets.len() as u32 {
            for t in self.tables.regions(sheet) {
                if t.visible.is_empty() {
                    continue;
                }
                out.push((
                    Rect {
                        sheet,
                        r0: t.row,
                        c0: t.col,
                        r1: (t.row as u64 + t.rows).min(MAX_ROWS as u64 - 1) as u32,
                        c1: t.col + t.visible.len() as u32 - 1,
                    },
                    Source::Table {
                        id: t.id.to_string(),
                    },
                ));
            }
        }
        for (index, p) in self.tables.manifest().pivots.iter().enumerate() {
            let grid = self.pivot_result(p);
            let Ok(g) = &*grid else { continue };
            if g.height() == 0 || g.width == 0 {
                continue;
            }
            out.push((
                Rect {
                    sheet: p.sheet,
                    r0: p.row,
                    c0: p.col,
                    r1: (p.row as u64 + g.height() as u64 - 1).min(MAX_ROWS as u64 - 1) as u32,
                    c1: (p.col + g.width as u32 - 1).min(MAX_COLS - 1),
                },
                Source::Pivot { index },
            ));
        }
        out
    }

    /// What the mirror depends on besides the demand: region geometry and data versions.
    fn mirror_key(&self, demand: &[Rect]) -> String {
        let m = self.tables.manifest();
        let mut key = format!(
            "{demand:?}|{}|",
            self.um.get_model().workbook.worksheets.len()
        );
        for t in &m.tables {
            key.push_str(&serde_json::to_string(t).unwrap_or_default());
        }
        for p in &m.pivots {
            key.push_str(&self.pivot_cache_key(p));
        }
        key
    }

    /// Clear every mirrored cell (no evaluation).
    pub(crate) fn clear_mirror(&mut self) {
        let cells = std::mem::take(&mut self.mirror.cells);
        self.mirror.key.clear();
        let model = self.um.get_model_mut();
        for (sheet, r, c) in cells.into_keys() {
            if let Ok(ws) = model.workbook.worksheet_mut(sheet) {
                ws.sheet_data.remove_cell(r, c);
            }
        }
    }

    /// Before a mutation: drop the mirror if the action can move cells.
    pub(crate) fn mirror_before(&mut self, action: &Action) {
        if !self.mirror.cells.is_empty() && moves_cells(action) {
            self.clear_mirror();
        }
    }

    /// Bring the mirrored cells up to date; true when any changed (re-evaluate then).
    pub(crate) fn sync_mirror(&mut self) -> bool {
        let renamed = self.sync_structured();
        self.sync_mirror_cells() || renamed
    }

    fn sync_mirror_cells(&mut self) -> bool {
        if !self.has_regions() {
            let changed = !self.mirror.cells.is_empty();
            self.clear_mirror();
            return changed;
        }
        let demand = self.demand();
        let key = self.mirror_key(&demand);
        if key == self.mirror.key {
            return false;
        }
        let limit = mirror_limit();
        let mut desired: HashMap<Key, CellVal> = HashMap::new();
        'regions: for (region, source) in self.mirror_regions() {
            for d in demand.iter().filter(|d| d.sheet == region.sheet) {
                let (r0, r1) = (d.r0.max(region.r0), d.r1.min(region.r1));
                let (c0, c1) = (d.c0.max(region.c0), d.c1.min(region.c1));
                if r0 > r1 || c0 > c1 {
                    continue;
                }
                for c in c0..=c1 {
                    if desired.len() >= limit {
                        break 'regions;
                    }
                    let room = (limit - desired.len()) as u32;
                    let r1 = r1.min(r0 + room - 1);
                    let values: Vec<(u32, CellVal)> = match &source {
                        Source::Table { id } => {
                            let vis = c - region.c0;
                            let mut v = Vec::new();
                            let mut from = r0;
                            if r0 == region.r0 {
                                if let Some(name) = self.tables.column_name(id, vis) {
                                    v.push((r0, CellVal::Text(name)));
                                }
                                from += 1;
                            }
                            if from <= r1 {
                                let rows = self.tables.column_values(
                                    id,
                                    vis,
                                    (from - region.r0 - 1) as u64,
                                    (r1 - region.r0) as u64,
                                );
                                v.extend(
                                    rows.into_iter()
                                        .enumerate()
                                        .map(|(i, x)| (from + i as u32, x)),
                                );
                            }
                            v
                        }
                        Source::Pivot { index } => {
                            let p = &self.tables.manifest().pivots[*index];
                            let grid = self.pivot_result(p);
                            let Ok(g) = &*grid else { continue };
                            (r0..=r1)
                                .map(|r| {
                                    let v = match g.get((r - p.row) as usize, (c - p.col) as usize)
                                    {
                                        Some(cell) => match cell.num {
                                            Some(n) => CellVal::Num(n),
                                            None if cell.text.is_empty() => CellVal::Blank,
                                            None => CellVal::Text(cell.text.clone()),
                                        },
                                        None => CellVal::Blank,
                                    };
                                    (r, v)
                                })
                                .collect()
                        }
                    };
                    for (r, v) in values {
                        if v != CellVal::Blank {
                            desired.insert((region.sheet, r as i32 + 1, c as i32 + 1), v);
                        }
                    }
                }
            }
        }
        let old = std::mem::take(&mut self.mirror.cells);
        let mut changed = false;
        let model = self.um.get_model_mut();
        for k in old.keys() {
            if !desired.contains_key(k) {
                if let Ok(ws) = model.workbook.worksheet_mut(k.0) {
                    ws.sheet_data.remove_cell(k.1, k.2);
                }
                changed = true;
            }
        }
        for (k, v) in &desired {
            if old.get(k) == Some(v) {
                continue;
            }
            changed = true;
            let (s, r, c) = *k;
            let _ = match v {
                CellVal::Num(n) => model.update_cell_with_number(s, r, c, *n),
                CellVal::Text(t) => model.update_cell_with_text(s, r, c, t),
                CellVal::Bool(b) => model.update_cell_with_bool(s, r, c, *b),
                CellVal::Blank => Ok(()),
            };
        }
        self.mirror.cells = desired;
        self.mirror.key = key;
        changed
    }

    /// Run `f` with the mirrored cells taken out of the model (for snapshots).
    pub(crate) fn without_mirror<T>(&mut self, f: impl FnOnce(&Self) -> T) -> T {
        if self.mirror.cells.is_empty() {
            return f(self);
        }
        let model = self.um.get_model_mut();
        let mut saved = Vec::with_capacity(self.mirror.cells.len());
        for &(s, r, c) in self.mirror.cells.keys() {
            if let Ok(ws) = model.workbook.worksheet_mut(s) {
                if let Some(cell) = ws.sheet_data.remove_cell(r, c) {
                    saved.push(((s, r, c), cell));
                }
            }
        }
        let out = f(self);
        let model = self.um.get_model_mut();
        for ((s, r, c), cell) in saved {
            if let Ok(ws) = model.workbook.worksheet_mut(s) {
                ws.sheet_data.set_cell(r, c, cell);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["Sheet1".into(), "My data".into()]
    }

    #[test]
    fn finds_references() {
        let r = references(
            "=SUM(B2:C4)+$D$5*'My data'!A1-LOG10(2)+\"A1\"&F:F",
            0,
            &names(),
        );
        assert_eq!(
            r,
            vec![
                Rect {
                    sheet: 0,
                    r0: 1,
                    c0: 1,
                    r1: 3,
                    c1: 2
                },
                Rect {
                    sheet: 0,
                    r0: 4,
                    c0: 3,
                    r1: 4,
                    c1: 3
                },
                Rect {
                    sheet: 1,
                    r0: 0,
                    c0: 0,
                    r1: 0,
                    c1: 0
                },
                Rect {
                    sheet: 0,
                    r0: 0,
                    c0: 5,
                    r1: MAX_ROWS - 1,
                    c1: 5
                },
            ]
        );
        assert_eq!(
            references("=Sheet1!3:4", 1, &names())[0],
            Rect {
                sheet: 0,
                r0: 2,
                c0: 0,
                r1: 3,
                c1: MAX_COLS - 1
            }
        );
        assert!(references("=Nope!A1", 0, &names()).is_empty());
    }
}
