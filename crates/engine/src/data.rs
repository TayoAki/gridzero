//! M2 data actions (BUILD-SPEC §5.1 Data, Tables and Import groups): file import,
//! Data Table edits, and sort / filter / remove-duplicates / text-to-columns on
//! ranges of ordinary cells.
//!
//! Range rewrites go through `paste_csv_string`, so each is one IronCalc undo entry,
//! and formulas are re-anchored with `extend_to` so relative references follow
//! their rows as they would in Excel.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::path::PathBuf;

use ironcalc_base::cell::CellValue;
use ironcalc_base::expressions::types::Area;
use protocol::{
    Action, ColumnFilter, DataTarget, ImportDest, ImportMode, ImportOptions, Range,
    RangeFilterInfo, Reply, SortKey,
};
use tables::{CellImport, ColumnSpec, Manifest};

use crate::{bad, cell, EngineError, Result, Workbook, MAX_COLS, MAX_ROWS};

/// "Import into cells" limit (S1 obligation A2); larger files go into a Data Table.
pub const MAX_IMPORT_CELLS: u64 = 1_000_000;
/// Largest table view that can be exploded into cells.
pub const MAX_EXPLODE_CELLS: usize = 1_000_000;
/// Largest range read by sort / dedupe / text-to-columns / copy.
const MAX_RANGE_CELLS: u64 = 2_000_000;

/// Sort order of a cell value: numbers, text, booleans; blanks always last.
#[derive(Debug, Clone, PartialEq)]
enum SortVal {
    Num(f64),
    Text(String),
    Bool(bool),
    Blank,
}

impl SortVal {
    fn rank(&self) -> u8 {
        match self {
            SortVal::Num(_) => 0,
            SortVal::Text(_) => 1,
            SortVal::Bool(_) => 2,
            SortVal::Blank => 3,
        }
    }

    fn cmp(&self, other: &SortVal) -> Ordering {
        match (self, other) {
            (SortVal::Num(a), SortVal::Num(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
            (SortVal::Text(a), SortVal::Text(b)) => a.cmp(b),
            (SortVal::Bool(a), SortVal::Bool(b)) => a.cmp(b),
            (a, b) => a.rank().cmp(&b.rank()),
        }
    }
}

/// Excel's field quoting for the tab-separated text `paste_csv_string` reads.
fn tsv_field(s: &str) -> Cow<'_, str> {
    if s.contains(['\t', '\n', '\r', '"']) {
        Cow::Owned(format!("\"{}\"", s.replace('"', "\"\"")))
    } else {
        Cow::Borrowed(s)
    }
}

/// Rows must all be the same width: the TSV reader drops records that are not.
fn to_tsv(rows: &[Vec<String>]) -> String {
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        for c in 0..width {
            if c > 0 {
                out.push('\t');
            }
            out.push_str(&tsv_field(row.get(c).map(String::as_str).unwrap_or("")));
        }
    }
    out
}

/// Imported text that IronCalc would read as a number, boolean, percentage or formula
/// gets a leading apostrophe so it stays text.
fn literal_text(s: &str) -> String {
    let t = s.trim();
    let special = t.starts_with(['=', '+', '\'', '@'])
        || t.parse::<f64>().is_ok()
        || t.eq_ignore_ascii_case("true")
        || t.eq_ignore_ascii_case("false")
        || t.strip_suffix('%')
            .is_some_and(|n| n.trim().parse::<f64>().is_ok())
        || t.strip_prefix(['$', '€', '£'])
            .is_some_and(|n| n.replace(',', "").parse::<f64>().is_ok());
    if special && !t.is_empty() {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

fn valid_import_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Workbook {
    /// A staged upload: `staging/{import_id}.{original file name}`.
    pub(crate) fn staged(&self, import_id: &str) -> Result<(PathBuf, String)> {
        if !valid_import_id(import_id) {
            return Err(bad("invalid import id".into()));
        }
        let prefix = format!("{import_id}.");
        let dir = self.dir.join("staging");
        let entries = std::fs::read_dir(&dir).map_err(|_| bad("no such upload".into()))?;
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if let Some(name) = file.strip_prefix(&prefix) {
                if !name.ends_with(".part") {
                    return Ok((entry.path(), name.to_string()));
                }
            }
        }
        Err(bad("no such upload (it may have expired)".into()))
    }

    /// Queries for M2: import preview/cancel and distinct values.
    pub(crate) fn query_data(&mut self, action: &Action) -> Result<Option<Reply>> {
        Ok(Some(match action {
            Action::ImportPreview { import_id, options } => {
                let (path, name) = self.staged(import_id)?;
                Reply::ImportPreview {
                    preview: importer::preview(&path, &name, options).map_err(bad)?,
                }
            }
            Action::CancelImport { import_id } => {
                if let Ok((path, _)) = self.staged(import_id) {
                    let _ = std::fs::remove_file(path);
                }
                Reply::Ok
            }
            Action::DistinctValues {
                target,
                col,
                search,
                limit,
            } => {
                let limit = (*limit).clamp(1, 10_000) as usize;
                let (values, total) = match target {
                    DataTarget::Table { table } => self
                        .tables
                        .distinct(table, *col, search.as_deref(), limit)
                        .map_err(bad)?,
                    DataTarget::Range { range } => {
                        self.range_distinct(range, *col, search.as_deref(), limit)?
                    }
                };
                Reply::Distinct { values, total }
            }
            _ => return Ok(None),
        }))
    }

    /// M2 mutations; `None` when the action is an M1 cell action.
    pub(crate) fn mutate_data(&mut self, action: &Action) -> Result<Option<Reply>> {
        Ok(Some(match action {
            Action::FinalizeImport {
                import_id,
                options,
                dest,
                mode,
                name,
            } => self.finalize_import(import_id, options, dest, *mode, name)?,
            Action::SortRange {
                range,
                keys,
                header,
            } => {
                self.sort_range(range, keys, *header)?;
                Reply::Ok
            }
            Action::SetFilter {
                target,
                col,
                filter,
            } => {
                match target {
                    DataTarget::Table { table } => {
                        let ci = *col as usize;
                        let filter = filter.clone();
                        self.tables
                            .update(table, |t| {
                                let c = t.columns.get_mut(ci).ok_or("no such column")?;
                                c.filter = filter;
                                Ok(())
                            })
                            .map_err(bad)?;
                    }
                    DataTarget::Range { range } => {
                        self.set_range_filter(range, *col, filter.clone())?
                    }
                }
                Reply::Ok
            }
            Action::ClearFilters { target } => {
                match target {
                    DataTarget::Table { table } => self
                        .tables
                        .update(table, |t| {
                            t.columns.iter_mut().for_each(|c| c.filter = None);
                            Ok(())
                        })
                        .map_err(bad)?,
                    DataTarget::Range { range } => self.clear_range_filter(range)?,
                }
                Reply::Ok
            }
            Action::SortTable { table, keys } => {
                let keys = keys.clone();
                self.tables
                    .update(table, |t| {
                        if keys.iter().any(|k| k.col as usize >= t.columns.len()) {
                            return Err("no such column".into());
                        }
                        t.sort = keys;
                        Ok(())
                    })
                    .map_err(bad)?;
                Reply::Ok
            }
            Action::AddComputedColumn { table, name, expr } => {
                let (name, expr) = (name.trim().to_string(), expr.clone());
                self.tables
                    .update(table, |t| {
                        check_column_name(t, &name, None)?;
                        t.columns.push(ColumnSpec {
                            name,
                            expr: Some(expr),
                            hidden: false,
                            filter: None,
                        });
                        Ok(())
                    })
                    .map_err(bad)?;
                Reply::Ok
            }
            Action::UpdateComputedColumn {
                table,
                col,
                name,
                expr,
            } => {
                let (ci, name, expr) = (*col as usize, name.trim().to_string(), expr.clone());
                self.tables
                    .update(table, |t| {
                        check_column_name(t, &name, Some(ci))?;
                        let c = t.columns.get_mut(ci).ok_or("no such column")?;
                        if c.expr.is_none() {
                            return Err("only computed columns have a formula".into());
                        }
                        c.name = name;
                        c.expr = Some(expr);
                        Ok(())
                    })
                    .map_err(bad)?;
                Reply::Ok
            }
            Action::DeleteTableColumn { table, col } => {
                let ci = *col;
                self.tables
                    .update(table, |t| {
                        let c = t.columns.get(ci as usize).ok_or("no such column")?;
                        if c.expr.is_none() {
                            return Err("source columns can be hidden but not deleted".into());
                        }
                        t.columns.remove(ci as usize);
                        t.sort = t
                            .sort
                            .iter()
                            .filter(|k| k.col != ci)
                            .map(|k| SortKey {
                                col: if k.col > ci { k.col - 1 } else { k.col },
                                desc: k.desc,
                            })
                            .collect();
                        Ok(())
                    })
                    .map_err(bad)?;
                Reply::Ok
            }
            Action::SetTableColumnHidden { table, col, hidden } => {
                let (ci, hidden) = (*col as usize, *hidden);
                self.tables
                    .update(table, |t| {
                        t.columns.get_mut(ci).ok_or("no such column")?.hidden = hidden;
                        if t.columns.iter().all(|c| c.hidden) {
                            return Err("a table must show at least one column".into());
                        }
                        Ok(())
                    })
                    .map_err(bad)?;
                Reply::Ok
            }
            Action::RenameTable { table, name } => {
                let name = name.trim().to_string();
                if name.is_empty() {
                    return Err(bad("the name is empty".into()));
                }
                self.tables
                    .update(table, |t| {
                        t.name = name;
                        Ok(())
                    })
                    .map_err(bad)?;
                Reply::Ok
            }
            Action::DeleteTable { table } => {
                self.tables.remove(table).map_err(bad)?;
                Reply::Ok
            }
            Action::ExplodeTable { table } => {
                let spec = self.tables.spec(table).map_err(bad)?.clone();
                let rows = self
                    .tables
                    .view_rows(table, MAX_EXPLODE_CELLS)
                    .map_err(bad)?;
                if spec.row as u64 + rows.len() as u64 > MAX_ROWS as u64 {
                    return Err(bad(
                        "the table is longer than a sheet; filter it first".into()
                    ));
                }
                self.tables.remove(table).map_err(bad)?;
                self.paste_rows(spec.sheet, spec.row, spec.col, &rows)?;
                Reply::Ok
            }
            Action::RemoveDuplicates {
                target,
                cols,
                header,
            } => {
                let removed = match target {
                    DataTarget::Table { table } => {
                        self.tables.remove_duplicates(table, cols).map_err(bad)?
                    }
                    DataTarget::Range { range } => self.dedupe_range(range, cols, *header)?,
                };
                Reply::Removed { removed }
            }
            Action::TextToColumns { range, delimiter } => {
                self.text_to_columns(range, delimiter)?;
                Reply::Ok
            }
            Action::DeleteSheet { sheet } => {
                let deleted = *sheet;
                self.um.delete_sheet(deleted).map_err(bad)?;
                self.remap_sheets(|s| match s.cmp(&deleted) {
                    Ordering::Less => Some(s),
                    Ordering::Equal => None,
                    Ordering::Greater => Some(s - 1),
                })?;
                Reply::Ok
            }
            Action::MoveSheet { sheet, to } => {
                let (from, to) = (*sheet, *to);
                self.um.move_sheet(from, to).map_err(bad)?;
                self.remap_sheets(|s| {
                    Some(if s == from {
                        to
                    } else if from < to && s > from && s <= to {
                        s - 1
                    } else if from > to && s >= to && s < from {
                        s + 1
                    } else {
                        s
                    })
                })?;
                Reply::Ok
            }
            _ => return Ok(None),
        }))
    }

    /// Keep tables and range filters on the right sheets after sheets move or go away.
    fn remap_sheets(&mut self, f: impl Fn(u32) -> Option<u32>) -> Result<()> {
        let mut m: Manifest = self.tables.manifest().clone();
        m.tables
            .retain_mut(|t| f(t.sheet).map(|s| t.sheet = s).is_some());
        m.range_filters
            .retain_mut(|r| f(r.range.sheet).map(|s| r.range.sheet = s).is_some());
        m.cell_imports
            .retain_mut(|c| f(c.sheet).map(|s| c.sheet = s).is_some());
        let target = |t: &mut DataTarget| match t {
            DataTarget::Range { range } => f(range.sheet).map(|s| range.sheet = s).is_some(),
            DataTarget::Table { .. } => true,
        };
        m.pivots
            .retain_mut(|p| f(p.sheet).map(|s| p.sheet = s).is_some() && target(&mut p.source));
        m.slicers
            .retain_mut(|p| f(p.sheet).map(|s| p.sheet = s).is_some() && target(&mut p.target));
        m.charts.retain_mut(|c| {
            let keep = f(c.sheet).map(|s| c.sheet = s).is_some();
            let on = |r: &mut Option<Range>| {
                if let Some(x) = r {
                    match f(x.sheet) {
                        Some(s) => x.sheet = s,
                        None => *r = None,
                    }
                }
            };
            on(&mut c.x);
            c.series.iter_mut().for_each(|s| on(&mut s.range));
            keep
        });
        m.comments
            .retain_mut(|c| f(c.sheet).map(|s| c.sheet = s).is_some());
        m.validations.retain_mut(|v| {
            if let Some(src) = &mut v.source {
                if let Some(s) = f(src.sheet) {
                    src.sheet = s;
                }
            }
            f(v.range.sheet).map(|s| v.range.sheet = s).is_some()
        });
        if &m != self.tables.manifest() {
            self.tables.set_manifest(m).map_err(bad)?;
        }
        Ok(())
    }

    /// Reject cell edits that land inside a Data Table, and row/column inserts or
    /// deletes that would shift cells under one.
    pub(crate) fn guard_tables(&self, action: &Action) -> Result<()> {
        let inside = |sheet: u32, row: u32, col: u32| {
            self.tables.table_at(sheet, row as u64, col).is_some()
                || self.pivot_at(sheet, row as u64, col).is_some()
        };
        if let Action::UpdateCell {
            sheet,
            row,
            col,
            raw,
        } = action
        {
            self.check_validation(*sheet, *row, *col, raw)?;
        }
        let blocked = match action {
            Action::UpdateCell {
                sheet, row, col, ..
            }
            | Action::PasteText {
                sheet, row, col, ..
            }
            | Action::PasteInternal { sheet, row, col } => inside(*sheet, *row, *col),
            Action::Fill { source, .. } => inside(source.sheet, source.r0, source.c0),
            Action::InsertRows { .. }
            | Action::DeleteRows { .. }
            | Action::InsertCols { .. }
            | Action::DeleteCols { .. } => self.splits_object(action),
            _ => false,
        };
        if blocked {
            return Err(bad(
                "That would change the cells of a Data Table or pivot. Insert or delete outside it, or use its menus.".into(),
            ));
        }
        Ok(())
    }

    fn finalize_import(
        &mut self,
        import_id: &str,
        options: &ImportOptions,
        dest: &ImportDest,
        mode: ImportMode,
        name: &str,
    ) -> Result<Reply> {
        let (path, file_name) = self.staged(import_id)?;
        let df = importer::load(&path, &file_name, options).map_err(bad)?;
        let display_name = {
            let n = name.trim();
            if n.is_empty() {
                file_name.clone()
            } else {
                n.to_string()
            }
        };
        let rows = df.height() as u64;
        let cols = df.width() as u32;
        if mode == ImportMode::Cells && (rows + 1) * cols as u64 > MAX_IMPORT_CELLS {
            return Err(bad(format!(
                "{rows} rows x {cols} columns is more than {MAX_IMPORT_CELLS} cells; import it as a Data Table"
            )));
        }
        let mut steps = 0;
        let (sheet, row, col) = match dest {
            ImportDest::NewSheet => {
                self.um.new_sheet().map_err(bad)?;
                steps += 1;
                let sheet = self.um.get_worksheets_properties().len() as u32 - 1;
                let stem = display_name
                    .rsplit_once('.')
                    .map_or(display_name.as_str(), |(s, _)| s);
                if self.rename_unique(sheet, stem) {
                    steps += 1;
                }
                (sheet, 0, 0)
            }
            ImportDest::Cell { sheet, row, col } => {
                cell(*row, *col)?;
                (*sheet, *row, *col)
            }
        };
        let table = match mode {
            ImportMode::Table => {
                if self.tables.table_at(sheet, row as u64, col).is_some()
                    && self.tables.at_anchor(sheet, row, col).is_none()
                {
                    return Err(bad("that cell is inside another Data Table".into()));
                }
                let replace = self.tables.at_anchor(sheet, row, col).map(str::to_string);
                let id = self
                    .tables
                    .import(
                        df,
                        &display_name,
                        &file_name,
                        sheet,
                        row,
                        col,
                        replace.as_deref(),
                    )
                    .map_err(bad)?;
                Some(id)
            }
            ImportMode::Cells => {
                if row as u64 + rows + 1 > MAX_ROWS as u64 || col + cols > MAX_COLS {
                    return Err(bad(
                        "the data does not fit on the sheet from that cell".into()
                    ));
                }
                if self.tables.table_at(sheet, row as u64, col).is_some() {
                    return Err(bad("that cell is inside a Data Table".into()));
                }
                // Re-importing over an earlier import: clear what it wrote first.
                let mut m = self.tables.manifest().clone();
                if let Some(old) = m
                    .cell_imports
                    .iter()
                    .find(|c| c.sheet == sheet && c.row == row && c.col == col)
                {
                    let area = Area {
                        sheet,
                        row: old.row as i32 + 1,
                        column: old.col as i32 + 1,
                        width: old.cols as i32,
                        height: old.rows as i32,
                    };
                    self.um.range_clear_contents(&area).map_err(bad)?;
                    steps += 1;
                }
                let mut grid: Vec<Vec<String>> = Vec::with_capacity(rows as usize + 1);
                grid.push(
                    df.get_column_names()
                        .iter()
                        .map(|n| literal_text(n))
                        .collect(),
                );
                let columns = df.columns();
                let text: Vec<bool> = columns
                    .iter()
                    .map(|c| c.dtype() == &polars::prelude::DataType::String)
                    .collect();
                for i in 0..rows as usize {
                    grid.push(
                        columns
                            .iter()
                            .zip(&text)
                            .map(|(c, &is_text)| {
                                let v = importer::display(
                                    &c.get(i).unwrap_or(polars::prelude::AnyValue::Null),
                                );
                                if is_text {
                                    literal_text(&v)
                                } else {
                                    v
                                }
                            })
                            .collect(),
                    );
                }
                self.paste_rows(sheet, row, col, &grid)?;
                steps += 1;
                m.cell_imports
                    .retain(|c| !(c.sheet == sheet && c.row == row && c.col == col));
                m.cell_imports.push(CellImport {
                    sheet,
                    row,
                    col,
                    rows: rows as u32 + 1,
                    cols,
                });
                self.tables.set_manifest(m).map_err(bad)?;
                None
            }
        };
        self.engine_steps = Some(steps);
        let _ = std::fs::remove_file(&path);
        Ok(Reply::Imported {
            sheet,
            row,
            col,
            rows: rows + 1,
            cols,
            table,
        })
    }

    /// Rename a new sheet to `base` (or "base (2)" ...); false if no name was usable.
    pub(crate) fn rename_unique(&mut self, sheet: u32, base: &str) -> bool {
        let base: String = base
            .chars()
            .filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\' | '\''))
            .take(28)
            .collect();
        let base = base.trim();
        if base.is_empty() {
            return false;
        }
        let taken: Vec<String> = self
            .um
            .get_worksheets_properties()
            .into_iter()
            .map(|p| p.name.to_lowercase())
            .collect();
        let mut name = base.to_string();
        let mut k = 2;
        while taken.contains(&name.to_lowercase()) {
            name = format!("{base} ({k})");
            k += 1;
        }
        self.um.rename_sheet(sheet, &name).is_ok()
    }

    /// Write rows of raw inputs with their top-left at (row, col) as one undo entry.
    fn paste_rows(&mut self, sheet: u32, row: u32, col: u32, rows: &[Vec<String>]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let (r, c) = cell(row, col)?;
        self.um.set_selected_sheet(sheet).map_err(bad)?;
        self.um.set_selected_cell(r, c).map_err(bad)?;
        self.um
            .paste_csv_string(
                &Area {
                    sheet,
                    row: r,
                    column: c,
                    width: 1,
                    height: 1,
                },
                &to_tsv(rows),
            )
            .map_err(bad)
    }

    fn check_range(range: &Range) -> Result<()> {
        if range.r0 > range.r1 || range.c0 > range.c1 {
            return Err(bad("range is inverted".into()));
        }
        cell(range.r1, range.c1)?;
        let cells = (range.r1 - range.r0 + 1) as u64 * (range.c1 - range.c0 + 1) as u64;
        if cells > MAX_RANGE_CELLS {
            return Err(bad(format!(
                "the range has more than {MAX_RANGE_CELLS} cells"
            )));
        }
        Ok(())
    }

    fn sort_val(&self, sheet: u32, row: u32, col: u32) -> SortVal {
        match self.value(sheet, row, col) {
            CellValue::Number(n) => SortVal::Num(n),
            CellValue::String(s) if s.is_empty() => SortVal::Blank,
            CellValue::String(s) => SortVal::Text(s.to_lowercase()),
            CellValue::Boolean(b) => SortVal::Bool(b),
            CellValue::None => SortVal::Blank,
        }
    }

    /// Contents of `row` re-anchored to `to_row` (formulas shift like a move).
    fn moved_row(&self, sheet: u32, row: u32, to_row: u32, c0: u32, c1: u32) -> Vec<String> {
        let model = self.um.get_model();
        (c0..=c1)
            .map(|c| {
                let (r, cc) = (row as i32 + 1, c as i32 + 1);
                model
                    .extend_to(sheet, r, cc, to_row as i32 + 1, cc)
                    .unwrap_or_default()
            })
            .collect()
    }

    fn sort_range(&mut self, range: &Range, keys: &[SortKey], header: bool) -> Result<()> {
        Self::check_range(range)?;
        if keys.is_empty() || keys.iter().any(|k| k.col < range.c0 || k.col > range.c1) {
            return Err(bad("sort columns must be inside the range".into()));
        }
        let first = range.r0 + header as u32;
        if first >= range.r1 {
            return Ok(());
        }
        let sheet = range.sheet;
        let mut order: Vec<(u32, Vec<SortVal>)> = (first..=range.r1)
            .map(|r| {
                (
                    r,
                    keys.iter()
                        .map(|k| self.sort_val(sheet, r, k.col))
                        .collect(),
                )
            })
            .collect();
        order.sort_by(|(_, a), (_, b)| {
            for (k, (x, y)) in keys.iter().zip(a.iter().zip(b)) {
                let ord = match (x, y) {
                    (SortVal::Blank, SortVal::Blank) => Ordering::Equal,
                    (SortVal::Blank, _) => Ordering::Greater,
                    (_, SortVal::Blank) => Ordering::Less,
                    _ if k.desc => y.cmp(x),
                    _ => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            Ordering::Equal
        });
        if order
            .iter()
            .enumerate()
            .all(|(i, (r, _))| *r == first + i as u32)
        {
            return Ok(());
        }
        let rows: Vec<Vec<String>> = order
            .iter()
            .enumerate()
            .map(|(i, (r, _))| self.moved_row(sheet, *r, first + i as u32, range.c0, range.c1))
            .collect();
        self.paste_rows(sheet, first, range.c0, &rows)
    }

    fn dedupe_range(&mut self, range: &Range, cols: &[u32], header: bool) -> Result<u64> {
        Self::check_range(range)?;
        let cols: Vec<u32> = if cols.is_empty() {
            (range.c0..=range.c1).collect()
        } else {
            cols.to_vec()
        };
        if cols.iter().any(|c| *c < range.c0 || *c > range.c1) {
            return Err(bad("columns must be inside the range".into()));
        }
        let first = range.r0 + header as u32;
        if first > range.r1 {
            return Ok(0);
        }
        let sheet = range.sheet;
        let model = self.um.get_model();
        let mut seen = std::collections::HashSet::new();
        let mut keep = Vec::new();
        for r in first..=range.r1 {
            let key: Vec<String> = cols
                .iter()
                .map(|&c| {
                    model
                        .get_formatted_cell_value(sheet, r as i32 + 1, c as i32 + 1)
                        .unwrap_or_default()
                })
                .collect();
            if seen.insert(key) {
                keep.push(r);
            }
        }
        let removed = (range.r1 - first + 1) as u64 - keep.len() as u64;
        if removed == 0 {
            return Ok(0);
        }
        let rows: Vec<Vec<String>> = keep
            .iter()
            .enumerate()
            .map(|(i, r)| self.moved_row(sheet, *r, first + i as u32, range.c0, range.c1))
            .collect();
        self.paste_rows(sheet, first, range.c0, &rows)?;
        let tail = first + keep.len() as u32;
        self.um
            .range_clear_contents(&Area {
                sheet,
                row: tail as i32 + 1,
                column: range.c0 as i32 + 1,
                width: (range.c1 - range.c0 + 1) as i32,
                height: (range.r1 - tail + 1) as i32,
            })
            .map_err(bad)?;
        self.engine_steps = Some(2);
        Ok(removed)
    }

    fn text_to_columns(&mut self, range: &Range, delimiter: &str) -> Result<()> {
        Self::check_range(range)?;
        if range.c0 != range.c1 {
            return Err(bad("select a single column to split".into()));
        }
        let delimiter = match delimiter {
            "\\t" | "tab" => "\t",
            "" => return Err(bad("choose a delimiter".into())),
            d => d,
        };
        let sheet = range.sheet;
        let rows: Vec<Vec<String>> = (range.r0..=range.r1)
            .map(|r| {
                let raw = self
                    .um
                    .get_cell_content(sheet, r as i32 + 1, range.c0 as i32 + 1)
                    .unwrap_or_default();
                if raw.starts_with('=') {
                    vec![raw]
                } else {
                    raw.split(delimiter).map(|s| s.trim().to_string()).collect()
                }
            })
            .collect();
        let width = rows.iter().map(Vec::len).max().unwrap_or(1) as u32;
        if width <= 1 {
            return Ok(());
        }
        if range.c0 + width > MAX_COLS {
            return Err(bad("the split columns do not fit on the sheet".into()));
        }
        self.paste_rows(sheet, range.r0, range.c0, &rows)
    }

    fn range_distinct(
        &self,
        range: &Range,
        col: u32,
        search: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<(String, u64)>, u64)> {
        Self::check_range(range)?;
        if col < range.c0 || col > range.c1 {
            return Err(bad("column must be inside the range".into()));
        }
        let model = self.um.get_model();
        let mut counts: std::collections::HashMap<String, (u64, SortVal)> =
            std::collections::HashMap::new();
        for r in range.r0 + 1..=range.r1 {
            let text = model
                .get_formatted_cell_value(range.sheet, r as i32 + 1, col as i32 + 1)
                .unwrap_or_default();
            let val = self.sort_val(range.sheet, r, col);
            counts.entry(text).or_insert((0, val)).0 += 1;
        }
        let total = counts.len() as u64;
        let mut values: Vec<(String, u64, SortVal)> =
            counts.into_iter().map(|(t, (n, v))| (t, n, v)).collect();
        values.sort_by(|a, b| match (&a.2, &b.2) {
            (SortVal::Blank, SortVal::Blank) => Ordering::Equal,
            (SortVal::Blank, _) => Ordering::Greater,
            (_, SortVal::Blank) => Ordering::Less,
            (x, y) => x.cmp(y).then_with(|| a.0.cmp(&b.0)),
        });
        let needle = search.map(str::to_lowercase).filter(|s| !s.is_empty());
        Ok((
            values
                .into_iter()
                .filter(|(t, _, _)| needle.as_ref().is_none_or(|n| t.to_lowercase().contains(n)))
                .take(limit)
                .map(|(t, n, _)| (t, n))
                .collect(),
            total,
        ))
    }

    /// Set one column's filter on a filtered range (creating it), then re-hide rows.
    fn set_range_filter(
        &mut self,
        range: &Range,
        col: u32,
        filter: Option<ColumnFilter>,
    ) -> Result<()> {
        Self::check_range(range)?;
        if range.r1 <= range.r0 {
            return Err(bad(
                "a filtered range needs a header row and at least one data row".into(),
            ));
        }
        if col < range.c0 || col > range.c1 {
            return Err(bad("column must be inside the range".into()));
        }
        let mut m = self.tables.manifest().clone();
        // One filtered range per sheet, as in Excel: a new one replaces the old.
        let old: Vec<RangeFilterInfo> = m
            .range_filters
            .iter()
            .filter(|f| f.range.sheet == range.sheet && f.range != *range)
            .cloned()
            .collect();
        let mut steps = 0;
        for o in &old {
            steps += self.show_rows(&o.range)?;
        }
        m.range_filters
            .retain(|f| f.range.sheet != range.sheet || f.range == *range);
        let rf = match m.range_filters.iter_mut().find(|f| f.range == *range) {
            Some(rf) => rf,
            None => {
                m.range_filters.push(RangeFilterInfo {
                    range: *range,
                    filters: Vec::new(),
                });
                m.range_filters.last_mut().unwrap()
            }
        };
        rf.filters.retain(|(c, _)| *c != col);
        if let Some(f) = filter {
            rf.filters.push((col, f));
            rf.filters.sort_by_key(|(c, _)| *c);
        }
        let rf = rf.clone();
        steps += self.apply_range_filter(&rf)?;
        self.tables.set_manifest(m).map_err(bad)?;
        self.engine_steps = Some(steps);
        Ok(())
    }

    fn clear_range_filter(&mut self, range: &Range) -> Result<()> {
        let mut m = self.tables.manifest().clone();
        let found: Vec<Range> = m
            .range_filters
            .iter()
            .filter(|f| {
                f.range.sheet == range.sheet
                    && (f.range == *range
                        || (f.range.r0 <= range.r0
                            && range.r0 <= f.range.r1
                            && f.range.c0 <= range.c0
                            && range.c0 <= f.range.c1))
            })
            .map(|f| f.range)
            .collect();
        let mut steps = 0;
        for r in &found {
            steps += self.show_rows(r)?;
        }
        m.range_filters.retain(|f| !found.contains(&f.range));
        self.tables.set_manifest(m).map_err(bad)?;
        self.engine_steps = Some(steps);
        Ok(())
    }

    fn hidden_rows(&self, sheet: u32) -> std::collections::HashSet<u32> {
        self.um
            .get_model()
            .workbook
            .worksheet(sheet)
            .map(|ws| {
                ws.rows
                    .iter()
                    .filter(|r| r.hidden)
                    .map(|r| r.r as u32 - 1)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Hide/show data rows so exactly those passing every filter are visible.
    /// Returns the number of IronCalc calls (undo entries) made.
    fn apply_range_filter(&mut self, rf: &RangeFilterInfo) -> Result<u32> {
        let sheet = rf.range.sheet;
        let hidden = self.hidden_rows(sheet);
        let model = self.um.get_model();
        let mut wanted: Vec<(u32, bool)> = Vec::new();
        for r in rf.range.r0 + 1..=rf.range.r1 {
            let pass = rf.filters.iter().all(|(c, f)| {
                let text = model
                    .get_formatted_cell_value(sheet, r as i32 + 1, *c as i32 + 1)
                    .unwrap_or_default();
                let number = match model.get_cell_value_by_index(sheet, r as i32 + 1, *c as i32 + 1)
                {
                    Ok(CellValue::Number(n)) => Some(n),
                    _ => None,
                };
                tables::cell_matches(f, &text, number)
            });
            if pass == hidden.contains(&r) {
                wanted.push((r, !pass));
            }
        }
        self.set_hidden_runs(sheet, &wanted)
    }

    fn show_rows(&mut self, range: &Range) -> Result<u32> {
        let hidden = self.hidden_rows(range.sheet);
        let wanted: Vec<(u32, bool)> = (range.r0 + 1..=range.r1)
            .filter(|r| hidden.contains(r))
            .map(|r| (r, false))
            .collect();
        self.set_hidden_runs(range.sheet, &wanted)
    }

    /// Apply (row, hidden) changes in contiguous runs.
    fn set_hidden_runs(&mut self, sheet: u32, changes: &[(u32, bool)]) -> Result<u32> {
        let mut calls = 0;
        let mut i = 0;
        while i < changes.len() {
            let (start, hide) = changes[i];
            let mut end = start;
            while i + 1 < changes.len() && changes[i + 1].0 == end + 1 && changes[i + 1].1 == hide {
                i += 1;
                end += 1;
            }
            self.um
                .set_rows_hidden(sheet, start as i32 + 1, end as i32 + 1, hide)
                .map_err(bad)?;
            calls += 1;
            i += 1;
        }
        Ok(calls)
    }
}

fn check_column_name(
    t: &tables::TableSpec,
    name: &str,
    except: Option<usize>,
) -> std::result::Result<(), String> {
    if name.is_empty() {
        return Err("the column needs a name".into());
    }
    if t.columns
        .iter()
        .enumerate()
        .any(|(i, c)| Some(i) != except && c.name.eq_ignore_ascii_case(name))
    {
        return Err(format!("there is already a column named \"{name}\""));
    }
    Ok(())
}

impl From<String> for EngineError {
    fn from(e: String) -> Self {
        EngineError::BadInput(e)
    }
}
