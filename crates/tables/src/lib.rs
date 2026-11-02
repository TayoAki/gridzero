//! Data Tables (PRD FR-6/FR-7, BUILD-SPEC D2): a dataset anchored at a sheet cell and
//! shown without writing values into cells. The source rows live in an immutable
//! Parquet file per version; computed columns, filters and the sort are applied
//! with Polars to produce the *view* the grid pages through.
//!
//! All of a store's state that must persist is its [`Manifest`] (small JSON). The
//! workbook op-logs the manifest after every table change and snapshots it, so
//! replay and undo only ever swap manifests; the Parquet files never change.

pub mod expr;
pub mod pivot;
pub mod shift;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use polars::prelude::*;
use protocol::{
    kind, CellStyle, ChartSpec, ColumnFilter, FilterOp, PivotSpec, RangeFilterInfo, SlicerSpec,
    SortKey, TableColumnInfo, TableInfo, ValidationSpec,
};
use serde::{Deserialize, Serialize};

pub use importer::{display, dtype_name};

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub next_id: u64,
    pub tables: Vec<TableSpec>,
    /// Filtered ranges on ordinary cells (rows are hidden in the cell engine).
    #[serde(default)]
    pub range_filters: Vec<RangeFilterInfo>,
    /// Earlier "import into cells" extents, so re-importing to the same anchor clears
    /// what the old file wrote.
    #[serde(default)]
    pub cell_imports: Vec<CellImport>,
    /// Analysis objects (M3).
    #[serde(default)]
    pub pivots: Vec<PivotSpec>,
    #[serde(default)]
    pub charts: Vec<ChartSpec>,
    #[serde(default)]
    pub slicers: Vec<SlicerSpec>,
    #[serde(default)]
    pub validations: Vec<ValidationSpec>,
}

impl Manifest {
    /// A fresh object id with a kind prefix ("p", "c", "s", "v").
    pub fn new_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CellImport {
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    pub rows: u32,
    pub cols: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableSpec {
    pub id: String,
    pub name: String,
    pub sheet: u32,
    pub row: u32,
    pub col: u32,
    /// Parquet file name under the workbook's `tables/` directory.
    pub file: String,
    pub source: String,
    pub columns: Vec<ColumnSpec>,
    #[serde(default)]
    pub sort: Vec<SortKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ColumnSpec {
    pub name: String,
    #[serde(default)]
    pub expr: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub filter: Option<ColumnFilter>,
}

/// A loaded table: its spec, the source frame, source + computed columns, and the view.
struct Live {
    spec: TableSpec,
    base: DataFrame,
    full: DataFrame,
    view: DataFrame,
}

pub struct TableStore {
    dir: PathBuf,
    manifest: Manifest,
    live: HashMap<String, Live>,
}

/// Header styles: source columns, computed columns.
fn header_style(computed: bool) -> CellStyle {
    CellStyle {
        font: protocol::font::BOLD,
        fill: Some(if computed { "#E6F4EA" } else { "#E8EEF7" }.into()),
        bottom: Some(("thin".into(), "#9AA5B1".into())),
        ..CellStyle::default()
    }
}

pub fn value_kind(dtype: &DataType) -> u8 {
    if dtype.is_primitive_numeric() {
        kind::NUMBER
    } else if *dtype == DataType::Boolean {
        kind::BOOLEAN
    } else {
        0
    }
}

impl TableStore {
    /// An empty store whose Parquet files live in `dir` (created on first write).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        TableStore {
            dir: dir.into(),
            manifest: Manifest::default(),
            live: HashMap::new(),
        }
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn manifest_json(&self) -> String {
        serde_json::to_string(&self.manifest).expect("manifest serializes")
    }

    pub fn file_path(&self, file: &str) -> PathBuf {
        self.dir.join(file)
    }

    /// Replace the whole state (rehydrate, replay, undo). Unchanged tables keep their
    /// loaded frames; changed ones recompute only what changed.
    pub fn set_manifest(&mut self, manifest: Manifest) -> Result<()> {
        let mut live = std::mem::take(&mut self.live);
        let mut next = HashMap::new();
        let mut first_err = None;
        for spec in &manifest.tables {
            let old = live.remove(&spec.id);
            match self.realize(spec.clone(), old) {
                Ok(l) => {
                    next.insert(spec.id.clone(), l);
                }
                Err(e) => {
                    first_err.get_or_insert(format!("table {}: {e}", spec.name));
                }
            }
        }
        self.live = next;
        self.manifest = manifest;
        first_err.map_or(Ok(()), Err)
    }

    pub fn set_manifest_json(&mut self, json: &str) -> Result<()> {
        self.set_manifest(serde_json::from_str(json).map_err(err)?)
    }

    /// Build a table's frames from its spec, reusing what `old` already computed.
    fn realize(&self, spec: TableSpec, old: Option<Live>) -> Result<Live> {
        let base = match &old {
            Some(o) if o.spec.file == spec.file => o.base.clone(),
            _ => ParquetReader::new(std::fs::File::open(self.file_path(&spec.file)).map_err(err)?)
                .finish()
                .map_err(err)?,
        };
        let computed_same = old.as_ref().is_some_and(|o| {
            o.spec.file == spec.file
                && o.spec
                    .columns
                    .iter()
                    .map(|c| (&c.name, &c.expr))
                    .eq(spec.columns.iter().map(|c| (&c.name, &c.expr)))
        });
        let full = match &old {
            Some(o) if computed_same => o.full.clone(),
            _ => compute_full(&base, &spec)?,
        };
        let view_same = computed_same
            && old.as_ref().is_some_and(|o| {
                o.spec.sort == spec.sort
                    && o.spec
                        .columns
                        .iter()
                        .map(|c| &c.filter)
                        .eq(spec.columns.iter().map(|c| &c.filter))
            });
        let view = match &old {
            Some(o) if view_same => o.view.clone(),
            _ => compute_view(&full, &spec)?,
        };
        Ok(Live {
            spec,
            base,
            full,
            view,
        })
    }

    fn live(&self, id: &str) -> Result<&Live> {
        self.live.get(id).ok_or_else(|| format!("no table {id}"))
    }

    /// Apply `edit` to a copy of table `id`'s spec, recompute, and commit only on success.
    pub fn update(
        &mut self,
        id: &str,
        edit: impl FnOnce(&mut TableSpec) -> Result<()>,
    ) -> Result<()> {
        let mut spec = self.live(id)?.spec.clone();
        edit(&mut spec)?;
        let old = self.live.remove(id);
        let realized = self.realize(spec.clone(), old);
        match realized {
            Ok(l) => {
                self.live.insert(id.to_string(), l);
                if let Some(s) = self.manifest.tables.iter_mut().find(|t| t.id == id) {
                    *s = spec;
                }
                Ok(())
            }
            Err(e) => {
                // Restore the previous state from the manifest (still the old spec).
                let prev = self
                    .manifest
                    .tables
                    .iter()
                    .find(|t| t.id == id)
                    .cloned()
                    .unwrap();
                if let Ok(l) = self.realize(prev, None) {
                    self.live.insert(id.to_string(), l);
                }
                Err(e)
            }
        }
    }

    pub fn manifest_mut(&mut self) -> &mut Manifest {
        &mut self.manifest
    }

    /// Persist `df` as a new Parquet version and return its file name.
    pub fn write_version(&mut self, id: &str, df: &mut DataFrame) -> Result<String> {
        std::fs::create_dir_all(&self.dir).map_err(err)?;
        let version = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or(0);
        let file = format!("{id}-{version}.parquet");
        let path = self.file_path(&file);
        let tmp = path.with_extension("tmp");
        let f = std::fs::File::create(&tmp).map_err(err)?;
        ParquetWriter::new(&f)
            .with_compression(ParquetCompression::Zstd(None))
            .with_row_group_size(Some(512 * 1024))
            .finish(df)
            .map_err(err)?;
        f.sync_all().map_err(err)?;
        drop(f);
        std::fs::rename(&tmp, &path).map_err(err)?;
        Ok(file)
    }

    /// Add a table (or, when `replace` names one, give it new source data). Computed
    /// columns, filters and the sort survive a replace when their columns still exist.
    pub fn import(
        &mut self,
        mut df: DataFrame,
        name: &str,
        source: &str,
        sheet: u32,
        row: u32,
        col: u32,
        replace: Option<&str>,
    ) -> Result<String> {
        let id = match replace {
            Some(id) => id.to_string(),
            None => {
                self.manifest.next_id += 1;
                format!("t{}", self.manifest.next_id)
            }
        };
        let file = self.write_version(&id, &mut df)?;
        let source_cols: Vec<ColumnSpec> = df
            .get_column_names()
            .iter()
            .map(|n| ColumnSpec {
                name: n.to_string(),
                expr: None,
                hidden: false,
                filter: None,
            })
            .collect();
        match replace {
            Some(id) => {
                let id = id.to_string();
                let base_names: Vec<String> = source_cols.iter().map(|c| c.name.clone()).collect();
                self.update(&id, |spec| {
                    let mut cols = source_cols;
                    // Keep settings of source columns that still exist, then computed columns.
                    for c in cols.iter_mut() {
                        if let Some(old) = spec
                            .columns
                            .iter()
                            .find(|o| o.expr.is_none() && o.name == c.name)
                        {
                            c.hidden = old.hidden;
                            c.filter = old.filter.clone();
                        }
                    }
                    let computed = spec.columns.iter().filter(|c| c.expr.is_some()).cloned();
                    let old_names: Vec<String> =
                        spec.columns.iter().map(|c| c.name.clone()).collect();
                    cols.extend(computed);
                    spec.sort = spec
                        .sort
                        .iter()
                        .filter_map(|k| {
                            let name = old_names.get(k.col as usize)?;
                            let at = cols.iter().position(|c| &c.name == name)?;
                            Some(SortKey {
                                col: at as u32,
                                desc: k.desc,
                            })
                        })
                        .collect();
                    let _ = base_names;
                    spec.columns = cols;
                    spec.file = file;
                    spec.source = source.to_string();
                    Ok(())
                })?;
            }
            None => {
                let spec = TableSpec {
                    id: id.clone(),
                    name: name.to_string(),
                    sheet,
                    row,
                    col,
                    file,
                    source: source.to_string(),
                    columns: source_cols,
                    sort: Vec::new(),
                };
                let live = self.realize(spec.clone(), None)?;
                self.live.insert(id.clone(), live);
                self.manifest.tables.push(spec);
            }
        }
        Ok(id)
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.live(id)?;
        self.live.remove(id);
        self.manifest.tables.retain(|t| t.id != id);
        Ok(())
    }

    /// The table whose anchor is exactly (sheet, row, col).
    pub fn at_anchor(&self, sheet: u32, row: u32, col: u32) -> Option<&str> {
        self.manifest
            .tables
            .iter()
            .find(|t| t.sheet == sheet && t.row == row && t.col == col)
            .map(|t| t.id.as_str())
    }

    /// The table covering a cell, with its geometry.
    pub fn table_at(&self, sheet: u32, row: u64, col: u32) -> Option<Region<'_>> {
        self.regions(sheet)
            .into_iter()
            .find(|r| r.contains(row, col))
    }

    pub fn regions(&self, sheet: u32) -> Vec<Region<'_>> {
        self.manifest
            .tables
            .iter()
            .filter(|t| t.sheet == sheet)
            .filter_map(|t| {
                let live = self.live.get(&t.id)?;
                Some(Region {
                    id: &t.id,
                    row: t.row,
                    col: t.col,
                    rows: live.view.height() as u64,
                    visible: t
                        .columns
                        .iter()
                        .enumerate()
                        .filter(|(_, c)| !c.hidden)
                        .map(|(i, _)| i as u32)
                        .collect(),
                })
            })
            .collect()
    }

    /// Rows the grid needs for this sheet (beyond Excel's limit when a table is longer).
    pub fn row_extent(&self, sheet: u32) -> u64 {
        self.regions(sheet)
            .iter()
            .map(|r| r.row as u64 + 1 + r.rows)
            .max()
            .unwrap_or(0)
    }

    pub fn info(&self, sheet: u32) -> Vec<TableInfo> {
        self.manifest
            .tables
            .iter()
            .filter(|t| t.sheet == sheet)
            .filter_map(|t| {
                let live = self.live.get(&t.id)?;
                Some(TableInfo {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    sheet: t.sheet,
                    row: t.row,
                    col: t.col,
                    rows: live.view.height() as u64,
                    total_rows: live.base.height() as u64,
                    columns: t
                        .columns
                        .iter()
                        .enumerate()
                        .map(|(i, c)| TableColumnInfo {
                            name: c.name.clone(),
                            dtype: live
                                .full
                                .column(&c.name)
                                .map(|s| dtype_name(s.dtype()))
                                .unwrap_or("text")
                                .into(),
                            expr: c.expr.clone(),
                            hidden: c.hidden,
                            filter: c.filter.clone(),
                            sort: t.sort.iter().find(|k| k.col == i as u32).map(|k| k.desc),
                        })
                        .collect(),
                    source: t.source.clone(),
                })
            })
            .collect()
    }

    /// The table's filtered view (sort included), e.g. as a pivot source.
    pub fn view_frame(&self, id: &str) -> Result<&DataFrame> {
        Ok(&self.live(id)?.view)
    }

    /// Changes whenever the table's view could have changed (for caches of derived objects).
    pub fn view_key(&self, id: &str) -> String {
        self.manifest
            .tables
            .iter()
            .find(|t| t.id == id)
            .map(|t| serde_json::to_string(&(&t.file, &t.columns)).unwrap_or_default())
            .unwrap_or_default()
    }

    pub fn spec(&self, id: &str) -> Result<&TableSpec> {
        Ok(&self.live(id)?.spec)
    }

    /// Cells of one grid tile that fall inside tables: (row in tile, col in tile, text, kind, style).
    pub fn tile_cells(
        &self,
        sheet: u32,
        r0: u64,
        r1: u64,
        c0: u32,
        c1: u32,
    ) -> Vec<(u64, u32, String, u8, CellStyle)> {
        let mut out = Vec::new();
        for region in self.regions(sheet) {
            let Ok(live) = self.live(region.id) else {
                continue;
            };
            let spec = &live.spec;
            let first_col = region.col.max(c0);
            let last_col = (region.col + region.visible.len() as u32)
                .saturating_sub(1)
                .min(c1);
            if region.visible.is_empty() || first_col > last_col {
                continue;
            }
            let top = region.row as u64;
            let bottom = top + region.rows;
            if r1 < top || r0 > bottom {
                continue;
            }
            // Header row.
            if (r0..=r1).contains(&top) {
                for c in first_col..=last_col {
                    let ci = region.visible[(c - region.col) as usize] as usize;
                    let column = &spec.columns[ci];
                    let mut k = kind::HEADER_BUTTON;
                    if column.filter.is_some() {
                        k |= kind::FILTERED;
                    }
                    if let Some(key) = spec.sort.iter().find(|s| s.col == ci as u32) {
                        k |= kind::SORTED | if key.desc { kind::SORT_DESC } else { 0 };
                    }
                    out.push((
                        top,
                        c,
                        column.name.clone(),
                        k,
                        header_style(column.expr.is_some()),
                    ));
                }
            }
            // Data rows: view rows [first, last].
            let first = r0.max(top + 1);
            let last = r1.min(bottom);
            if first > last {
                continue;
            }
            let slice = live
                .view
                .slice((first - top - 1) as i64, (last - first + 1) as usize);
            for c in first_col..=last_col {
                let ci = region.visible[(c - region.col) as usize] as usize;
                let Ok(series) = slice.column(&spec.columns[ci].name) else {
                    continue;
                };
                let k = value_kind(series.dtype());
                for i in 0..slice.height() {
                    let v = series.get(i).unwrap_or(AnyValue::Null);
                    if matches!(v, AnyValue::Null) {
                        continue;
                    }
                    out.push((first + i as u64, c, display(&v), k, CellStyle::default()));
                }
            }
        }
        out
    }

    /// Display text of one cell inside a table (header name or value).
    pub fn cell_text(&self, sheet: u32, row: u64, col: u32) -> Option<String> {
        let region = self.table_at(sheet, row, col)?;
        let live = self.live(region.id).ok()?;
        let column = &live.spec.columns[region.visible[(col - region.col) as usize] as usize];
        if row == region.row as u64 {
            return Some(match &column.expr {
                Some(e) => format!("{} = {}", column.name, e.trim_start_matches('=')),
                None => column.name.clone(),
            });
        }
        let v = live
            .view
            .column(&column.name)
            .ok()?
            .get((row - region.row as u64 - 1) as usize)
            .ok()?;
        Some(display(&v))
    }

    /// Sum/count/min/max of the table cells inside a sheet rectangle.
    pub fn stats(&self, sheet: u32, r0: u64, r1: u64, c0: u32, c1: u32) -> Stats {
        let mut s = Stats::default();
        for region in self.regions(sheet) {
            let Ok(live) = self.live(region.id) else {
                continue;
            };
            let top = region.row as u64;
            let first = r0.max(top + 1);
            let last = r1.min(top + region.rows);
            if r0 <= top && top <= r1 {
                // Header cells count as text values.
                let cols = (region.col..region.col + region.visible.len() as u32)
                    .filter(|c| (c0..=c1).contains(c))
                    .count();
                s.count += cols as u64;
            }
            if first > last {
                continue;
            }
            let slice = live
                .view
                .slice((first - top - 1) as i64, (last - first + 1) as usize);
            for (j, &ci) in region.visible.iter().enumerate() {
                let c = region.col + j as u32;
                if !(c0..=c1).contains(&c) {
                    continue;
                }
                let Ok(series) = slice.column(&live.spec.columns[ci as usize].name) else {
                    continue;
                };
                let present = (series.len() - series.null_count()) as u64;
                s.count += present;
                if series.dtype().is_primitive_numeric() {
                    let f = series
                        .cast(&DataType::Float64)
                        .unwrap_or_else(|_| series.clone());
                    let f = f.as_materialized_series();
                    s.numbers += present;
                    s.sum += f.sum::<f64>().unwrap_or(0.0);
                    if let Ok(Some(m)) = f.min::<f64>() {
                        s.min = Some(s.min.map_or(m, |x: f64| x.min(m)));
                    }
                    if let Ok(Some(m)) = f.max::<f64>() {
                        s.max = Some(s.max.map_or(m, |x: f64| x.max(m)));
                    }
                }
            }
        }
        s
    }

    /// Distinct display values of a table column with row counts, sorted by value.
    pub fn distinct(
        &self,
        id: &str,
        ci: u32,
        search: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<(String, u64)>, u64)> {
        let live = self.live(id)?;
        let name = &live
            .spec
            .columns
            .get(ci as usize)
            .ok_or("no such column")?
            .name;
        distinct_values(&live.full, name, search, limit)
    }

    /// The current view as rows of display strings (header first), for explode/copy.
    pub fn view_rows(&self, id: &str, max_cells: usize) -> Result<Vec<Vec<String>>> {
        let live = self.live(id)?;
        let cols: Vec<&ColumnSpec> = live.spec.columns.iter().filter(|c| !c.hidden).collect();
        let cells = (live.view.height() + 1) * cols.len().max(1);
        if cells > max_cells {
            return Err(format!(
                "the table has {cells} cells; at most {max_cells} can be written into cells"
            ));
        }
        let mut rows = vec![cols.iter().map(|c| c.name.clone()).collect::<Vec<_>>()];
        let series: Vec<&Column> = cols
            .iter()
            .filter_map(|c| live.view.column(&c.name).ok())
            .collect();
        for i in 0..live.view.height() {
            rows.push(
                series
                    .iter()
                    .map(|s| display(&s.get(i).unwrap_or(AnyValue::Null)))
                    .collect(),
            );
        }
        Ok(rows)
    }

    /// Remove rows that repeat earlier ones in `cols` (all source columns when empty).
    /// Writes a new Parquet version; returns the number of rows removed.
    pub fn remove_duplicates(&mut self, id: &str, cols: &[u32]) -> Result<u64> {
        let live = self.live(id)?;
        let spec = live.spec.clone();
        let names: Vec<String> = if cols.is_empty() {
            spec.columns
                .iter()
                .filter(|c| c.expr.is_none())
                .map(|c| c.name.clone())
                .collect()
        } else {
            cols.iter()
                .map(|&c| {
                    spec.columns
                        .get(c as usize)
                        .map(|c| c.name.clone())
                        .ok_or("no such column".to_string())
                })
                .collect::<Result<_>>()?
        };
        let before = live.base.height() as u64;
        let source: Vec<String> = live
            .base
            .get_column_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut deduped = live
            .full
            .unique_stable(Some(&names), UniqueKeepStrategy::First, None)
            .map_err(err)?
            .select(source)
            .map_err(err)?;
        let removed = before - deduped.height() as u64;
        if removed == 0 {
            return Ok(0);
        }
        let file = self.write_version(id, &mut deduped)?;
        self.update(id, |s| {
            s.file = file;
            Ok(())
        })?;
        Ok(removed)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Stats {
    pub count: u64,
    pub numbers: u64,
    pub sum: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// Where a table sits on its sheet.
pub struct Region<'a> {
    pub id: &'a str,
    pub row: u32,
    pub col: u32,
    /// View rows (the header is extra).
    pub rows: u64,
    /// Indices into the spec's columns of the columns shown, left to right.
    pub visible: Vec<u32>,
}

impl Region<'_> {
    pub fn contains(&self, row: u64, col: u32) -> bool {
        row >= self.row as u64
            && row <= self.row as u64 + self.rows
            && col >= self.col
            && col < self.col + self.visible.len() as u32
    }
}

fn compute_full(base: &DataFrame, spec: &TableSpec) -> Result<DataFrame> {
    let mut lf = base.clone().lazy();
    let mut names: Vec<String> = base
        .get_column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut any = false;
    for c in &spec.columns {
        if let Some(src) = &c.expr {
            let e = expr::compile(src, &names).map_err(|e| format!("{}: {e}", c.name))?;
            // One column per step so later formulas can use earlier computed columns.
            lf = lf.with_column(e.alias(c.name.as_str()));
            names.push(c.name.clone());
            any = true;
        }
    }
    if !any {
        return Ok(base.clone());
    }
    lf.collect().map_err(|e| format!("computed column: {e}"))
}

fn compute_view(full: &DataFrame, spec: &TableSpec) -> Result<DataFrame> {
    let filters: Vec<Expr> = spec
        .columns
        .iter()
        .filter_map(|c| {
            let f = c.filter.as_ref()?;
            let dtype = full.column(&c.name).ok()?.dtype().clone();
            Some(filter_expr(&c.name, &dtype, f))
        })
        .collect::<Result<_>>()?;
    if filters.is_empty() && spec.sort.is_empty() {
        return Ok(full.clone());
    }
    let mut lf = full.clone().lazy();
    for f in filters {
        lf = lf.filter(f);
    }
    if !spec.sort.is_empty() {
        let by: Vec<PlSmallStr> = spec
            .sort
            .iter()
            .filter_map(|k| {
                spec.columns
                    .get(k.col as usize)
                    .map(|c| PlSmallStr::from(c.name.as_str()))
            })
            .collect();
        let desc: Vec<bool> = spec.sort.iter().map(|k| k.desc).collect();
        lf = lf.sort(
            by,
            SortMultipleOptions::default()
                .with_order_descending_multi(desc)
                .with_nulls_last(true)
                .with_maintain_order(true)
                .with_multithreaded(true),
        );
    }
    lf.collect().map_err(err)
}

/// The column as the text the grid shows, for value filters and distinct lists.
fn display_expr(name: &str, dtype: &DataType) -> Expr {
    let c = col(name);
    match dtype {
        DataType::Boolean => when(c.clone()).then(lit("TRUE")).otherwise(lit("FALSE")),
        DataType::Datetime(..) => c.dt().strftime("%Y-%m-%d %H:%M:%S"),
        DataType::String => c,
        _ => c.cast(DataType::String),
    }
}

/// A Polars predicate for one column filter.
pub fn filter_expr(name: &str, dtype: &DataType, f: &ColumnFilter) -> Result<Expr> {
    let c = col(name);
    let numeric = dtype.is_primitive_numeric();
    let blank = if *dtype == DataType::String {
        c.clone()
            .is_null()
            .or(c.clone().str().strip_chars(lit(NULL)).eq(lit("")))
    } else {
        c.clone().is_null()
    };
    Ok(match f {
        ColumnFilter::Values { values } => {
            let want_blank = values.iter().any(|v| v.is_empty());
            let present: Vec<&String> = values.iter().filter(|v| !v.is_empty()).collect();
            let hit = if present.is_empty() {
                lit(false)
            } else if numeric {
                let nums: Vec<f64> = present.iter().filter_map(|v| v.parse().ok()).collect();
                c.clone()
                    .cast(DataType::Float64)
                    .is_in(lit(Series::new("v".into(), nums)).implode(false), false)
            } else if *dtype == DataType::String {
                let strs: Vec<&str> = present.iter().map(|s| s.as_str()).collect();
                c.clone()
                    .is_in(lit(Series::new("v".into(), strs)).implode(false), false)
            } else {
                let strs: Vec<&str> = present.iter().map(|s| s.as_str()).collect();
                display_expr(name, dtype)
                    .is_in(lit(Series::new("v".into(), strs)).implode(false), false)
            };
            let hit = hit.fill_null(lit(false));
            if want_blank {
                hit.or(blank)
            } else {
                hit
            }
        }
        ColumnFilter::Condition { op, value } => {
            let v = value.trim();
            match op {
                FilterOp::Blank => blank,
                FilterOp::NotBlank => blank.not(),
                FilterOp::Contains
                | FilterOp::NotContains
                | FilterOp::StartsWith
                | FilterOp::EndsWith => {
                    let s = display_expr(name, dtype).str().to_lowercase();
                    let needle = lit(v.to_lowercase());
                    let e = match op {
                        FilterOp::StartsWith => s.str().starts_with(needle),
                        FilterOp::EndsWith => s.str().ends_with(needle),
                        _ => s.str().contains_literal(needle),
                    }
                    .fill_null(lit(false));
                    if *op == FilterOp::NotContains {
                        e.not()
                    } else {
                        e
                    }
                }
                _ => {
                    let (lhs, rhs) = if numeric {
                        let n: f64 = v.parse().map_err(|_| format!("\"{v}\" is not a number"))?;
                        (c.clone().cast(DataType::Float64), lit(n))
                    } else if *dtype == DataType::String {
                        (c.clone().str().to_lowercase(), lit(v.to_lowercase()))
                    } else {
                        // Dates, datetimes and booleans compare as their ISO / TRUE-FALSE text.
                        (
                            display_expr(name, dtype),
                            lit(v.to_uppercase().replace('T', " ")),
                        )
                    };
                    match op {
                        FilterOp::Eq => lhs.eq(rhs),
                        FilterOp::Ne => lhs.neq(rhs),
                        FilterOp::Gt => lhs.gt(rhs),
                        FilterOp::Ge => lhs.gt_eq(rhs),
                        FilterOp::Lt => lhs.lt(rhs),
                        FilterOp::Le => lhs.lt_eq(rhs),
                        _ => unreachable!(),
                    }
                    .fill_null(lit(false))
                }
            }
        }
    })
}

/// Whether one cell passes a filter, for filtered ranges on ordinary cells. Uses the
/// same rules as `filter_expr`: text compares case-insensitively, numbers numerically.
pub fn cell_matches(f: &ColumnFilter, text: &str, number: Option<f64>) -> bool {
    let blank = text.trim().is_empty();
    match f {
        ColumnFilter::Values { values } => {
            values
                .iter()
                .any(|v| if v.is_empty() { blank } else { v == text })
        }
        ColumnFilter::Condition { op, value } => {
            let v = value.trim();
            let lower = text.to_lowercase();
            let needle = v.to_lowercase();
            match op {
                FilterOp::Blank => blank,
                FilterOp::NotBlank => !blank,
                FilterOp::Contains => lower.contains(&needle),
                FilterOp::NotContains => !lower.contains(&needle),
                FilterOp::StartsWith => lower.starts_with(&needle),
                FilterOp::EndsWith => lower.ends_with(&needle),
                _ => {
                    let ord = match (number, v.parse::<f64>()) {
                        (Some(n), Ok(want)) => n.partial_cmp(&want),
                        (None, Ok(_)) if blank => return false,
                        _ => Some(lower.as_str().cmp(needle.as_str())),
                    };
                    let Some(ord) = ord else { return false };
                    match op {
                        FilterOp::Eq => ord.is_eq(),
                        FilterOp::Ne => ord.is_ne(),
                        FilterOp::Gt => ord.is_gt(),
                        FilterOp::Ge => ord.is_ge(),
                        FilterOp::Lt => ord.is_lt(),
                        FilterOp::Le => ord.is_le(),
                        _ => unreachable!(),
                    }
                }
            }
        }
    }
}

pub fn distinct_values(
    df: &DataFrame,
    name: &str,
    search: Option<&str>,
    limit: usize,
) -> Result<(Vec<(String, u64)>, u64)> {
    let dtype = df.column(name).map_err(err)?.dtype().clone();
    let grouped = df
        .clone()
        .lazy()
        .group_by([col(name)])
        .agg([len().alias("__n")])
        .sort([name], SortMultipleOptions::default().with_nulls_last(true))
        .with_column(display_expr(name, &dtype).alias("__text"))
        .collect()
        .map_err(err)?;
    let total = grouped.height() as u64;
    let texts = grouped.column("__text").map_err(err)?;
    let counts = grouped
        .column("__n")
        .map_err(err)?
        .cast(&DataType::UInt64)
        .map_err(err)?;
    let needle = search.map(str::to_lowercase).filter(|s| !s.is_empty());
    let mut out = Vec::new();
    for i in 0..grouped.height() {
        let text = match texts.get(i).map_err(err)? {
            AnyValue::Null => String::new(),
            v => {
                let s = display(&v);
                // Float columns cast to text keep trailing ".0"; show them like the grid does.
                match dtype {
                    DataType::Float32 | DataType::Float64 => {
                        s.parse::<f64>().map(importer::fmt_float).unwrap_or(s)
                    }
                    _ => s,
                }
            }
        };
        if needle
            .as_ref()
            .is_some_and(|n| !text.to_lowercase().contains(n))
        {
            continue;
        }
        let n = counts
            .get(i)
            .ok()
            .and_then(|v| v.extract::<u64>())
            .unwrap_or(0);
        out.push((text, n));
        if out.len() >= limit {
            break;
        }
    }
    Ok((out, total))
}

/// Default directory for a workbook's tables.
pub fn tables_dir(workbook_dir: &Path) -> PathBuf {
    workbook_dir.join("tables")
}

#[cfg(test)]
mod tests;
