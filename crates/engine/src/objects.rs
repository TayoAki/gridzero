//! M3 analysis objects: pivots, charts, slicers, data validation and conditional
//! formats (BUILD-SPEC §5.1 Objects group).
//!
//! Pivots, charts, slicers and validation rules live in the table manifest, so they
//! are op-logged, snapshotted and undone like Data Tables. Pivot output is read-only
//! and drawn over the sheet like a table; it is recomputed lazily when its source
//! changes (any cell edit for a range source, the table's view for a table source).
//! Conditional formats are IronCalc's own, so they shift with inserted rows.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use ironcalc_base::cell::CellValue;
use ironcalc_base::cf_types::{
    CfRuleInput, Cfvo, ColorScaleThreshold, Icon, IconThreshold, TextOperator, ValueOperator,
};
use ironcalc_base::types::{Color, Dxf, DxfFont, Fill};
use polars::prelude::*;
use protocol::{
    Action, ChartData, ChartKind, ChartSpec, ColumnFilter, Comment, CommentReply, CondFormatInfo,
    CondOp, CondRule, CondStyle, DataTarget, IconSetKind, PivotInfo, PivotSpec, Range, Reply,
    SeriesData, ValidationSpec,
};
use tables::pivot::{self, PivotGrid};
use tables::shift::{self, Dim, Shift};

use crate::{bad, cell, Result, Workbook, MAX_COLS, MAX_ROWS};

/// Longest comment or reply.
const MAX_COMMENT: usize = 10_000;

fn comment_text(text: &str) -> Result<String> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_COMMENT {
        return Err(bad(format!(
            "a comment must be 1 to {MAX_COMMENT} characters"
        )));
    }
    Ok(text.to_string())
}

fn comment_mut<'a>(m: &'a mut tables::Manifest, id: &str) -> Result<&'a mut Comment> {
    m.comments
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| bad("that comment no longer exists".into()))
}

/// Points per chart series sent to the client.
pub const MAX_CHART_POINTS: usize = 10_000;
/// Largest range a pivot or chart reads from ordinary cells.
const MAX_SOURCE_CELLS: u64 = 5_000_000;

pub(crate) type PivotResult = Rc<std::result::Result<PivotGrid, String>>;

/// Cached pivot outputs: pivot id -> (cache key, result).
#[derive(Default)]
pub(crate) struct PivotCache(RefCell<HashMap<String, (String, PivotResult)>>);

/// Where a pivot's output sits.
pub(crate) struct PivotRegion {
    pub spec: PivotSpec,
    pub grid: PivotResult,
}

impl PivotRegion {
    fn size(&self) -> (u64, u32) {
        match &*self.grid {
            Ok(g) if g.height() > 0 => (g.height() as u64, g.width as u32),
            // An empty or failed pivot still holds its anchor cell.
            _ => (1, 1),
        }
    }

    pub fn contains(&self, row: u64, col: u32) -> bool {
        let (h, w) = self.size();
        row >= self.spec.row as u64
            && row < self.spec.row as u64 + h
            && col >= self.spec.col
            && col < self.spec.col + w
    }

    /// The display cell at a sheet position inside the region.
    pub fn cell(&self, row: u64, col: u32) -> Option<&pivot::PCell> {
        match &*self.grid {
            Ok(g) => g.get(
                (row - self.spec.row as u64) as usize,
                (col - self.spec.col) as usize,
            ),
            Err(_) => None,
        }
    }
}

pub fn a1_col(c: u32) -> String {
    let mut n = c + 1;
    let mut s = String::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        s.insert(0, (b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    s
}

pub fn a1(r: &Range) -> String {
    let start = format!("{}{}", a1_col(r.c0), r.r0 + 1);
    if r.r0 == r.r1 && r.c0 == r.c1 {
        start
    } else {
        format!("{start}:{}{}", a1_col(r.c1), r.r1 + 1)
    }
}

fn rgb(s: &str) -> Color {
    Color::Rgb(s.to_uppercase())
}

fn dxf(style: &CondStyle) -> Dxf {
    Dxf {
        font: (style.bold || style.color.is_some()).then(|| DxfFont {
            b: style.bold.then_some(true),
            color: style.color.as_deref().map(rgb).unwrap_or_default(),
            ..Default::default()
        }),
        fill: style.fill.as_deref().map(|f| Fill { color: rgb(f) }),
        ..Default::default()
    }
}

/// A literal for a CF formula: numbers as-is, text quoted.
fn literal(v: &str) -> String {
    let t = v.trim();
    if t.starts_with('=') {
        t.trim_start_matches('=').to_string()
    } else if t.parse::<f64>().is_ok() {
        t.to_string()
    } else {
        format!("\"{}\"", t.replace('"', "\"\""))
    }
}

fn cf_input(rule: &CondRule, style: &CondStyle) -> Result<CfRuleInput> {
    let format = dxf(style);
    Ok(match rule {
        CondRule::CellIs { op, value, value2 } => {
            let operator = match op {
                CondOp::Eq => ValueOperator::Equal,
                CondOp::Ne => ValueOperator::NotEqual,
                CondOp::Gt => ValueOperator::GreaterThan,
                CondOp::Ge => ValueOperator::GreaterThanOrEqual,
                CondOp::Lt => ValueOperator::LessThan,
                CondOp::Le => ValueOperator::LessThanOrEqual,
                CondOp::Between => ValueOperator::Between,
                CondOp::NotBetween => ValueOperator::NotBetween,
            };
            let between = matches!(op, CondOp::Between | CondOp::NotBetween);
            if between && value2.as_deref().is_none_or(|v| v.trim().is_empty()) {
                return Err(bad("between needs two values".into()));
            }
            CfRuleInput::CellIs {
                operator,
                formula: literal(value),
                formula2: if between {
                    value2.as_deref().map(literal)
                } else {
                    None
                },
                format,
                stop_if_true: false,
            }
        }
        CondRule::TextContains { value } => CfRuleInput::Text {
            operator: TextOperator::Contains,
            value: value.clone(),
            format,
            stop_if_true: false,
        },
        CondRule::Blanks => CfRuleInput::Blanks {
            format,
            stop_if_true: false,
        },
        CondRule::NotBlanks => CfRuleInput::NotBlanks {
            format,
            stop_if_true: false,
        },
        CondRule::Duplicates => CfRuleInput::DuplicateValues {
            format,
            stop_if_true: false,
        },
        CondRule::Top {
            rank,
            bottom,
            percent,
        } => {
            if *bottom {
                CfRuleInput::Bottom10 {
                    rank: *rank,
                    percent: *percent,
                    format,
                    stop_if_true: false,
                }
            } else {
                CfRuleInput::Top10 {
                    rank: *rank,
                    percent: *percent,
                    format,
                    stop_if_true: false,
                }
            }
        }
        CondRule::Average { below } => {
            if *below {
                CfRuleInput::BelowAverage {
                    format,
                    stop_if_true: false,
                }
            } else {
                CfRuleInput::AboveAverage {
                    format,
                    stop_if_true: false,
                }
            }
        }
        CondRule::Formula { formula } => CfRuleInput::Formula {
            formula: formula.trim_start_matches('=').to_string(),
            format,
            stop_if_true: false,
        },
        CondRule::ColorScale { min, mid, max } => {
            let mut thresholds = vec![ColorScaleThreshold {
                cfvo: Cfvo::Min,
                color: rgb(min),
            }];
            if let Some(m) = mid {
                thresholds.push(ColorScaleThreshold {
                    cfvo: Cfvo::Percentile(50.0),
                    color: rgb(m),
                });
            }
            thresholds.push(ColorScaleThreshold {
                cfvo: Cfvo::Max,
                color: rgb(max),
            });
            CfRuleInput::ColorScale { thresholds }
        }
        CondRule::DataBar { color } => CfRuleInput::DataBar {
            min: None,
            max: None,
            positive_color: rgb(color),
            negative_color: rgb("#C5221F"),
            is_gradient: false,
            show_value: true,
        },
        CondRule::IconSet { set, reverse } => {
            let (top, mid, low) = match set {
                IconSetKind::Arrows => (Icon::ArrowUp, Icon::ArrowRight, Icon::ArrowDown),
                IconSetKind::TrafficLights => (Icon::Circle, Icon::Circle, Icon::Circle),
                IconSetKind::Flags => (Icon::Flag, Icon::Flag, Icon::Flag),
                IconSetKind::Symbols => (Icon::Check, Icon::Exclamation, Icon::Cross),
            };
            // Reversed: the low-value icon and color go to the top values.
            let (mut top, mut low) = (top, low);
            let (mut hi, mut lo) = ("#1E8E3E", "#C5221F");
            if *reverse {
                std::mem::swap(&mut top, &mut low);
                std::mem::swap(&mut hi, &mut lo);
            }
            let step = |icon: Icon, color: &str, cfvo: Cfvo| IconThreshold {
                icon,
                cfvo,
                color: rgb(color),
                is_strict: false,
            };
            CfRuleInput::IconSet {
                // IronCalc takes the thresholds lowest first.
                thresholds: vec![
                    step(low, lo, Cfvo::Min),
                    step(mid, "#F9AB00", Cfvo::Percent(33.0)),
                    step(top, hi, Cfvo::Percent(67.0)),
                ],
                show_value: true,
            }
        }
    })
}

/// The grid's name for an IronCalc icon.
pub(crate) fn icon_name(icon: &Icon) -> &'static str {
    match icon {
        Icon::ArrowUp | Icon::ArrowAngleUp | Icon::TriangleUp | Icon::TriangleUpFilled => "up",
        Icon::ArrowDown | Icon::ArrowAngleDown | Icon::TriangleDown | Icon::TriangleDownFilled => {
            "down"
        }
        Icon::ArrowRight | Icon::FlatRectangle => "right",
        Icon::Flag => "flag",
        Icon::Check | Icon::ThumbsUp => "check",
        Icon::Cross | Icon::ThumbsDown => "cross",
        Icon::Exclamation => "exclamation",
        _ => "circle",
    }
}

impl Workbook {
    // ------------------------------------------------------------- sources

    /// Hidden rows of a sheet (filtered ranges, manual hides).
    pub(crate) fn hidden_set(&self, sheet: u32) -> HashSet<u32> {
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

    /// Columns of `source` that a slicer drives.
    fn slicer_columns(&self, source: &DataTarget) -> Vec<u32> {
        let mut cols: Vec<u32> = self
            .tables
            .manifest()
            .slicers
            .iter()
            .filter(|s| s.target == *source)
            .map(|s| s.column)
            .collect();
        cols.sort_unstable();
        cols.dedup();
        cols
    }

    /// A range of cells (first row = header) as a typed frame, for a pivot. As in
    /// Excel, the range's own filters and hidden rows are ignored; only filters on
    /// `slicer_cols` apply, so a slicer still drives every pivot built on the range.
    pub(crate) fn range_frame(&self, range: &Range, slicer_cols: &[u32]) -> Result<DataFrame> {
        if range.r0 >= range.r1 || range.c0 > range.c1 {
            return Err(bad(
                "a source range needs a header row and at least one data row".into(),
            ));
        }
        cell(range.r1, range.c1)?;
        let cells = (range.r1 - range.r0) as u64 * (range.c1 - range.c0 + 1) as u64;
        if cells > MAX_SOURCE_CELLS {
            return Err(bad(
                "the source range is too large; import it as a Data Table".into(),
            ));
        }
        let manifest = self.tables.manifest();
        let slicer_filters: Vec<&(u32, ColumnFilter)> = manifest
            .range_filters
            .iter()
            .find(|f| f.range == *range)
            .map(|f| {
                f.filters
                    .iter()
                    .filter(|(c, _)| slicer_cols.contains(c))
                    .collect()
            })
            .unwrap_or_default();
        let rows: Vec<u32> = (range.r0 + 1..=range.r1)
            .filter(|&r| {
                slicer_filters.iter().all(|(c, f)| {
                    let (text, number) = self.source_value(range.sheet, r as u64, *c);
                    tables::cell_matches(f, &text, number)
                })
            })
            .collect();
        let mut used = HashSet::new();
        let mut columns = Vec::new();
        for c in range.c0..=range.c1 {
            let (head, _) = self.source_value(range.sheet, range.r0 as u64, c);
            let mut name = if head.trim().is_empty() {
                a1_col(c)
            } else {
                head.trim().to_string()
            };
            let base = name.clone();
            let mut k = 2;
            while !used.insert(name.to_lowercase()) {
                name = format!("{base}_{k}");
                k += 1;
            }
            let vals: Vec<(String, Option<f64>)> = rows
                .iter()
                .map(|&r| self.source_value(range.sheet, r as u64, c))
                .collect();
            let present = vals.iter().filter(|(t, _)| !t.is_empty());
            let series = if present.clone().count() > 0 && present.clone().all(|(_, n)| n.is_some())
            {
                Series::new(
                    name.as_str().into(),
                    vals.iter().map(|(_, n)| *n).collect::<Vec<_>>(),
                )
            } else {
                Series::new(
                    name.as_str().into(),
                    vals.into_iter()
                        .map(|(t, _)| (!t.is_empty()).then_some(t))
                        .collect::<Vec<_>>(),
                )
            };
            columns.push(series.into_column());
        }
        DataFrame::new_infer_height(columns).map_err(|e| bad(e.to_string()))
    }

    /// The rows a pivot reads: all of the source, narrowed only by slicers on it.
    fn source_frame(&self, source: &DataTarget) -> Result<DataFrame> {
        let slicer_cols = self.slicer_columns(source);
        match source {
            DataTarget::Table { table } => {
                self.tables.filtered_frame(table, &slicer_cols).map_err(bad)
            }
            DataTarget::Range { range } => self.range_frame(range, &slicer_cols),
        }
    }

    fn source_key(&self, source: &DataTarget) -> String {
        let slicers = self.slicer_columns(source);
        match source {
            DataTarget::Table { table } => format!("{}|{slicers:?}", self.tables.view_key(table)),
            DataTarget::Range { range } => {
                let filters = self
                    .tables
                    .manifest()
                    .range_filters
                    .iter()
                    .find(|f| f.range == *range)
                    .map(|f| serde_json::to_string(&f.filters).unwrap_or_default())
                    .unwrap_or_default();
                format!("cells@{}|{slicers:?}|{filters}", self.cells_version)
            }
        }
    }

    // ------------------------------------------------------------- pivots

    /// Changes whenever the pivot's output could have changed.
    pub(crate) fn pivot_cache_key(&self, spec: &PivotSpec) -> String {
        format!(
            "{}|{}",
            serde_json::to_string(spec).unwrap_or_default(),
            self.source_key(&spec.source)
        )
    }

    pub(crate) fn pivot_result(&self, spec: &PivotSpec) -> PivotResult {
        let key = self.pivot_cache_key(spec);
        if let Some((k, r)) = self.pivot_cache.0.borrow().get(&spec.id) {
            if *k == key {
                return r.clone();
            }
        }
        let result = Rc::new(
            self.source_frame(&spec.source)
                .map_err(|e| e.to_string())
                .and_then(|df| pivot::compute(&df, spec)),
        );
        self.pivot_cache
            .0
            .borrow_mut()
            .insert(spec.id.clone(), (key, result.clone()));
        result
    }

    pub(crate) fn pivot_regions(&self, sheet: u32) -> Vec<PivotRegion> {
        self.tables
            .manifest()
            .pivots
            .iter()
            .filter(|p| p.sheet == sheet)
            .map(|p| PivotRegion {
                spec: p.clone(),
                grid: self.pivot_result(p),
            })
            .collect()
    }

    pub(crate) fn pivot_at(&self, sheet: u32, row: u64, col: u32) -> Option<PivotRegion> {
        self.pivot_regions(sheet)
            .into_iter()
            .find(|p| p.contains(row, col))
    }

    pub(crate) fn pivot_infos(&self, sheet: u32) -> Vec<PivotInfo> {
        self.pivot_regions(sheet)
            .into_iter()
            .map(|p| {
                let (rows, cols) = p.size();
                let fields = self
                    .source_frame(&p.spec.source)
                    .map(|df| importer::columns(&df.head(Some(0))))
                    .unwrap_or_default();
                PivotInfo {
                    rows,
                    cols,
                    error: p.grid.as_ref().as_ref().err().cloned(),
                    fields,
                    spec: p.spec,
                }
            })
            .collect()
    }

    /// Display text and numeric value of any cell: table, pivot output or ordinary cell.
    pub(crate) fn value_at(&self, sheet: u32, row: u64, col: u32) -> (String, Option<f64>) {
        if self
            .tables
            .manifest()
            .pivots
            .iter()
            .any(|p| p.sheet == sheet)
        {
            if let Some(p) = self.pivot_at(sheet, row, col) {
                return p
                    .cell(row, col)
                    .map(|c| (c.text.clone(), c.num))
                    .unwrap_or_default();
            }
        }
        self.source_value(sheet, row, col)
    }

    /// Like `value_at` but ignoring pivot output: what a pivot may read as its source
    /// (reading pivots there would let a pivot depend on itself).
    fn source_value(&self, sheet: u32, row: u64, col: u32) -> (String, Option<f64>) {
        if let Some(t) = self.tables.table_at(sheet, row, col) {
            let text = self.tables.cell_text(sheet, row, col).unwrap_or_default();
            if row == t.row as u64 {
                return (
                    text.split(" = ").next().unwrap_or_default().to_string(),
                    None,
                );
            }
            let num = text.parse::<f64>().ok();
            return (text, num);
        }
        if row >= MAX_ROWS as u64 || col >= MAX_COLS {
            return (String::new(), None);
        }
        let model = self.um.get_model();
        let (r, c) = (row as i32 + 1, col as i32 + 1);
        let text = model
            .get_formatted_cell_value(sheet, r, c)
            .unwrap_or_default();
        let num = match model.get_cell_value_by_index(sheet, r, c) {
            Ok(CellValue::Number(n)) => Some(n),
            _ => None,
        };
        (text, num)
    }

    pub(crate) fn slicer_infos(&self, sheet: u32) -> Vec<protocol::SlicerInfo> {
        let m = self.tables.manifest();
        m.slicers
            .iter()
            .filter(|s| s.sheet == sheet)
            .map(|s| {
                let (column_name, filter) = match &s.target {
                    DataTarget::Table { table } => self
                        .tables
                        .spec(table)
                        .ok()
                        .and_then(|t| t.columns.get(s.column as usize))
                        .map(|c| (c.name.clone(), c.filter.clone()))
                        .unwrap_or_default(),
                    DataTarget::Range { range } => (
                        self.source_value(range.sheet, range.r0 as u64, s.column).0,
                        m.range_filters
                            .iter()
                            .find(|f| f.range == *range)
                            .and_then(|f| {
                                f.filters
                                    .iter()
                                    .find(|(c, _)| *c == s.column)
                                    .map(|(_, f)| f.clone())
                            }),
                    ),
                };
                protocol::SlicerInfo {
                    spec: s.clone(),
                    column_name,
                    filter,
                }
            })
            .collect()
    }

    // ------------------------------------------------------------- charts

    /// Cells of a one-row or one-column range (2-D ranges read row by row), skipping hidden rows.
    fn series_cells(&self, r: &Range, hidden: &HashSet<u32>) -> Vec<(String, Option<f64>)> {
        let mut out = Vec::new();
        for row in r.r0..=r.r1 {
            if hidden.contains(&row) {
                continue;
            }
            for c in r.c0..=r.c1 {
                out.push(self.value_at(r.sheet, row as u64, c));
                if out.len() > MAX_CHART_POINTS * 10 {
                    return out;
                }
            }
        }
        out
    }

    fn ref_text(&self, r: &Option<Range>) -> String {
        match r {
            None => "#REF!".into(),
            Some(r) => {
                let name = self
                    .sheets()
                    .get(r.sheet as usize)
                    .map(|s| s.name.clone())
                    .unwrap_or_default();
                format!("='{}'!{}", name.replace('\'', "''"), a1(r))
            }
        }
    }

    pub(crate) fn chart_data(&self, spec: &ChartSpec) -> ChartData {
        let mut errors = Vec::new();
        let mut refs = vec![spec.x.map(|_| self.ref_text(&spec.x)).unwrap_or_default()];
        let mut hidden_by_sheet: HashMap<u32, HashSet<u32>> = HashMap::new();
        let mut hidden = |sheet: u32| {
            hidden_by_sheet
                .entry(sheet)
                .or_insert_with(|| self.hidden_set(sheet))
                .clone()
        };
        let mut series = Vec::new();
        for (i, s) in spec.series.iter().enumerate() {
            refs.push(self.ref_text(&s.range));
            let name = s
                .name
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| format!("Series {}", i + 1));
            let values: Vec<Option<f64>> = match &s.range {
                None => {
                    errors.push(format!("{name}: its cells were deleted (#REF!)"));
                    Vec::new()
                }
                Some(r) => self
                    .series_cells(r, &hidden(r.sheet))
                    .into_iter()
                    .map(|(_, n)| n)
                    .collect(),
            };
            series.push(SeriesData {
                name,
                kind: s.kind.unwrap_or(spec.kind),
                axis: s.axis,
                values,
            });
        }
        let mut x: Vec<String> = match &spec.x {
            Some(r) => self
                .series_cells(r, &hidden(r.sheet))
                .into_iter()
                .map(|(t, _)| t)
                .collect(),
            None => Vec::new(),
        };
        if spec.kind == ChartKind::Histogram {
            let all: Vec<f64> = series
                .iter()
                .flat_map(|s| s.values.iter().flatten().copied())
                .filter(|v| v.is_finite())
                .collect();
            if all.is_empty() {
                errors.push("no numbers to bucket".into());
            } else {
                let (lo, hi) = all
                    .iter()
                    .fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
                let bins = spec
                    .bins
                    .unwrap_or_else(|| (all.len() as f64).log2().ceil() as u32 + 1)
                    .clamp(1, 200) as usize;
                let width = if hi > lo {
                    (hi - lo) / bins as f64
                } else {
                    1.0
                };
                x = (0..bins)
                    .map(|b| {
                        format!(
                            "{}–{}",
                            importer::fmt_float(round4(lo + b as f64 * width)),
                            importer::fmt_float(round4(lo + (b + 1) as f64 * width))
                        )
                    })
                    .collect();
                for s in &mut series {
                    let mut counts = vec![0u64; bins];
                    for v in s.values.iter().flatten().filter(|v| v.is_finite()) {
                        let b = (((v - lo) / width) as usize).min(bins - 1);
                        counts[b] += 1;
                    }
                    s.values = counts.into_iter().map(|c| Some(c as f64)).collect();
                    s.kind = ChartKind::Column;
                }
            }
        } else {
            let n = series
                .iter()
                .map(|s| s.values.len())
                .max()
                .unwrap_or(0)
                .max(x.len());
            if n > MAX_CHART_POINTS {
                errors.push(format!(
                    "showing the first {MAX_CHART_POINTS} of {n} points"
                ));
            }
            for s in &mut series {
                s.values.truncate(MAX_CHART_POINTS);
            }
            x.truncate(MAX_CHART_POINTS);
            if x.is_empty() {
                x = (1..=n.min(MAX_CHART_POINTS))
                    .map(|i| i.to_string())
                    .collect();
            }
        }
        ChartData {
            x,
            series,
            refs,
            errors,
        }
    }

    // ------------------------------------------------------------- validation

    pub(crate) fn validation_at(&self, sheet: u32, row: u32, col: u32) -> Option<&ValidationSpec> {
        self.tables.manifest().validations.iter().rev().find(|v| {
            v.range.sheet == sheet
                && (v.range.r0..=v.range.r1).contains(&row)
                && (v.range.c0..=v.range.c1).contains(&col)
        })
    }

    pub(crate) fn choices(&self, v: &ValidationSpec) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        let mut add = |s: String| {
            let t = s.trim().to_string();
            if !t.is_empty() && seen.insert(t.to_lowercase()) {
                out.push(t);
            }
        };
        v.values.iter().cloned().for_each(&mut add);
        if let Some(src) = &v.source {
            let hidden = HashSet::new();
            for (t, _) in self.series_cells(src, &hidden).into_iter().take(10_000) {
                add(t);
            }
        }
        out
    }

    /// Reject a typed value that is not in a strict dropdown list.
    pub(crate) fn check_validation(&self, sheet: u32, row: u32, col: u32, raw: &str) -> Result<()> {
        let t = raw.trim();
        if t.is_empty() || t.starts_with('=') {
            return Ok(());
        }
        let Some(v) = self.validation_at(sheet, row, col) else {
            return Ok(());
        };
        if !v.strict {
            return Ok(());
        }
        let choices = self.choices(v);
        if choices.iter().any(|c| c.eq_ignore_ascii_case(t)) {
            return Ok(());
        }
        let shown: Vec<&str> = choices.iter().take(8).map(String::as_str).collect();
        Err(bad(format!(
            "\"{t}\" is not allowed here; choose one of: {}{}",
            shown.join(", "),
            if choices.len() > shown.len() {
                ", …"
            } else {
                ""
            }
        )))
    }

    // ------------------------------------------------------------- shifting

    /// After IronCalc inserted or deleted rows/columns, move every manifest reference too.
    pub(crate) fn shift_objects(&mut self, action: &Action) -> Result<()> {
        let s = match action {
            Action::InsertRows { sheet, row, count } => Shift {
                sheet: *sheet,
                dim: Dim::Rows,
                at: *row,
                delta: *count as i64,
            },
            Action::DeleteRows { sheet, row, count } => Shift {
                sheet: *sheet,
                dim: Dim::Rows,
                at: *row,
                delta: -(*count as i64),
            },
            Action::InsertCols { sheet, col, count } => Shift {
                sheet: *sheet,
                dim: Dim::Cols,
                at: *col,
                delta: *count as i64,
            },
            Action::DeleteCols { sheet, col, count } => Shift {
                sheet: *sheet,
                dim: Dim::Cols,
                at: *col,
                delta: -(*count as i64),
            },
            _ => return Ok(()),
        };
        let mut m = self.tables.manifest().clone();
        shift::apply(&mut m, s);
        if &m != self.tables.manifest() {
            self.tables.set_manifest(m).map_err(bad)?;
        }
        Ok(())
    }

    /// Whether an insert/delete would cut through a table or pivot (those cannot be split).
    pub(crate) fn splits_object(&self, action: &Action) -> bool {
        let regions = |sheet: u32| -> Vec<(u64, u64, u32, u32)> {
            let mut v: Vec<(u64, u64, u32, u32)> = self
                .tables
                .regions(sheet)
                .iter()
                .map(|t| {
                    (
                        t.row as u64,
                        t.row as u64 + t.rows,
                        t.col,
                        t.col + t.visible.len() as u32 - 1,
                    )
                })
                .collect();
            v.extend(self.pivot_regions(sheet).iter().map(|p| {
                let (h, w) = p.size();
                (
                    p.spec.row as u64,
                    p.spec.row as u64 + h - 1,
                    p.spec.col,
                    p.spec.col + w - 1,
                )
            }));
            v
        };
        match action {
            Action::InsertRows { sheet, row, .. } => regions(*sheet)
                .iter()
                .any(|(t, b, _, _)| (*row as u64) > *t && (*row as u64) <= *b),
            Action::DeleteRows { sheet, row, count } => regions(*sheet)
                .iter()
                .any(|(t, b, _, _)| (*row as u64) <= *b && (*row as u64 + *count as u64) > *t),
            Action::InsertCols { sheet, col, .. } => regions(*sheet)
                .iter()
                .any(|(_, _, l, r)| col > l && col <= r),
            Action::DeleteCols { sheet, col, count } => regions(*sheet)
                .iter()
                .any(|(_, _, l, r)| col <= r && col + count > *l),
            _ => false,
        }
    }

    // ------------------------------------------------------------- export

    /// The sheet's displayed values as CSV, from A1 to the last used row and column:
    /// cells, Data Tables (their current view) and pivot output alike.
    pub(crate) fn export_csv(&self, sheet: u32) -> Result<String> {
        let model = self.um.get_model();
        let ws = model.workbook.worksheet(sheet).map_err(bad)?;
        let (mut rows, mut cols) = if ws.sheet_data.is_empty() {
            (0u64, 0u32)
        } else {
            let d = ws.dimension();
            (d.max_row as u64, d.max_column as u32)
        };
        for t in self.tables.info(sheet) {
            let visible = t.columns.iter().filter(|c| !c.hidden).count() as u32;
            rows = rows.max(t.row as u64 + 1 + t.rows);
            cols = cols.max(t.col + visible);
        }
        for p in self.pivot_infos(sheet) {
            rows = rows.max(p.spec.row as u64 + p.rows);
            cols = cols.max(p.spec.col + p.cols);
        }
        let mut out = String::new();
        for r in 0..rows {
            for c in 0..cols {
                if c > 0 {
                    out.push(',');
                }
                let (text, _) = self.value_at(sheet, r, c);
                if text.contains([',', '"', '\n', '\r']) {
                    out.push('"');
                    out.push_str(&text.replace('"', "\"\""));
                    out.push('"');
                } else {
                    out.push_str(&text);
                }
            }
            out.push('\n');
        }
        Ok(out)
    }

    // ------------------------------------------------------------- actions

    pub(crate) fn query_objects(&self, action: &Action) -> Result<Option<Reply>> {
        Ok(Some(match action {
            Action::GetFields { source } => Reply::Fields {
                columns: importer::columns(&self.source_frame(source)?.head(Some(0))),
            },
            Action::GetChart { id } => {
                let spec = self
                    .tables
                    .manifest()
                    .charts
                    .iter()
                    .find(|c| c.id == *id)
                    .ok_or_else(|| bad(format!("no chart {id}")))?;
                Reply::Chart {
                    data: self.chart_data(spec),
                }
            }
            Action::ExportCsv { sheet } => Reply::Text {
                text: self.export_csv(*sheet)?,
            },
            Action::GetChoices { sheet, row, col } => {
                match self.validation_at(*sheet, *row, *col) {
                    Some(v) => Reply::Choices {
                        values: self.choices(v),
                        strict: v.strict,
                    },
                    None => Reply::Choices {
                        values: Vec::new(),
                        strict: false,
                    },
                }
            }
            Action::ListCondFormats { sheet } => Reply::CondFormats {
                list: self
                    .um
                    .get_conditional_formatting_list(*sheet)
                    .map_err(bad)?
                    .into_iter()
                    .map(|cf| CondFormatInfo {
                        index: cf.index as u32,
                        range: cf.range,
                        summary: serde_json::to_value(&cf.cf_rule)
                            .ok()
                            .and_then(|v| {
                                v.get("type").and_then(|t| t.as_str()).map(str::to_string)
                            })
                            .unwrap_or_default(),
                    })
                    .collect(),
            },
            _ => return Ok(None),
        }))
    }

    fn check_anchor(&self, sheet: u32, row: u32, col: u32, except: &str) -> Result<()> {
        cell(row, col)?;
        if self.tables.table_at(sheet, row as u64, col).is_some()
            || self
                .pivot_at(sheet, row as u64, col)
                .is_some_and(|p| p.spec.id != except)
        {
            return Err(bad(
                "that cell is inside a Data Table or another pivot".into()
            ));
        }
        Ok(())
    }

    fn check_source(&self, source: &DataTarget) -> Result<()> {
        match source {
            DataTarget::Table { table } => self.tables.spec(table).map(|_| ()).map_err(bad),
            DataTarget::Range { range } => self.range_frame(range, &[]).map(|_| ()),
        }
    }

    /// A Data Table of the source rows behind a pivot cell, on a new sheet.
    fn drill_down(&mut self, sheet: u32, row: u32, col: u32) -> Result<Reply> {
        let p = self
            .pivot_at(sheet, row as u64, col)
            .ok_or_else(|| bad("that cell is not in a pivot".into()))?;
        let grid = match &*p.grid {
            Ok(g) => g,
            Err(e) => return Err(bad(e.clone())),
        };
        let df = self.source_frame(&p.spec.source)?;
        let rows = pivot::drill(
            &df,
            &p.spec,
            grid,
            (row - p.spec.row) as usize,
            (col - p.spec.col) as usize,
        )
        .map_err(bad)?;
        self.um.new_sheet().map_err(bad)?;
        let target = self.um.get_worksheets_properties().len() as u32 - 1;
        self.engine_steps = Some(if self.rename_unique(target, "Details") {
            2
        } else {
            1
        });
        let id = self
            .tables
            .import(rows, "Details", "pivot drill-down", target, 0, 0, None)
            .map_err(bad)?;
        Ok(Reply::Created { id, sheet: target })
    }

    pub(crate) fn mutate_objects(&mut self, action: &Action) -> Result<Option<Reply>> {
        if let Action::DrillDown { sheet, row, col } = action {
            return self.drill_down(*sheet, *row, *col).map(Some);
        }
        let mut m = self.tables.manifest().clone();
        let reply = match action {
            Action::SaveCode { source } => {
                m.code.source = source.clone();
                Reply::Ok
            }
            Action::SetExecuteOnWake { on } => {
                m.code.execute_on_wake = *on;
                Reply::Ok
            }
            Action::TogglePivotGroup { id, key } => {
                let p = m
                    .pivots
                    .iter_mut()
                    .find(|p| p.id == *id)
                    .ok_or_else(|| bad("no such pivot".into()))?;
                match p.collapsed.iter().position(|k| k == key) {
                    Some(i) => {
                        p.collapsed.remove(i);
                    }
                    None => p.collapsed.push(key.clone()),
                }
                Reply::Ok
            }
            Action::AddComment {
                sheet,
                row,
                col,
                text,
                author,
                at,
            } => {
                let text = comment_text(text)?;
                let id = m.new_id("m");
                m.comments.push(Comment {
                    id: id.clone(),
                    sheet: *sheet,
                    row: *row,
                    col: *col,
                    author: author.clone(),
                    at: *at,
                    text,
                    resolved: false,
                    replies: Vec::new(),
                });
                Reply::Created { id, sheet: *sheet }
            }
            Action::ReplyComment {
                id,
                text,
                author,
                at,
            } => {
                let text = comment_text(text)?;
                comment_mut(&mut m, id)?.replies.push(CommentReply {
                    author: author.clone(),
                    at: *at,
                    text,
                });
                Reply::Ok
            }
            Action::ResolveComment { id, resolved } => {
                comment_mut(&mut m, id)?.resolved = *resolved;
                Reply::Ok
            }
            Action::DeleteComment { id } => {
                comment_mut(&mut m, id)?;
                m.comments.retain(|c| c.id != *id);
                Reply::Ok
            }
            Action::CreatePivot { spec, new_sheet } => {
                self.check_source(&spec.source)?;
                let mut spec = spec.clone();
                if *new_sheet {
                    self.um.new_sheet().map_err(bad)?;
                    spec.sheet = self.um.get_worksheets_properties().len() as u32 - 1;
                    (spec.row, spec.col) = (0, 0);
                    let steps = if self.rename_unique(spec.sheet, "Pivot") {
                        2
                    } else {
                        1
                    };
                    self.engine_steps = Some(steps);
                } else {
                    self.check_anchor(spec.sheet, spec.row, spec.col, "")?;
                }
                spec.id = m.new_id("p");
                let reply = Reply::Created {
                    id: spec.id.clone(),
                    sheet: spec.sheet,
                };
                m.pivots.push(spec);
                reply
            }
            Action::UpdatePivot { spec } => {
                self.check_source(&spec.source)?;
                self.check_anchor(spec.sheet, spec.row, spec.col, &spec.id)?;
                let slot = m
                    .pivots
                    .iter_mut()
                    .find(|p| p.id == spec.id)
                    .ok_or_else(|| bad(format!("no pivot {}", spec.id)))?;
                *slot = spec.clone();
                Reply::Ok
            }
            Action::CreateChart { spec } | Action::UpdateChart { spec } => {
                cell(spec.row, spec.col)?;
                if spec.series.is_empty() {
                    return Err(bad("a chart needs at least one series".into()));
                }
                let mut spec = spec.clone();
                spec.w = spec.w.clamp(160, 3000);
                spec.h = spec.h.clamp(120, 2000);
                if matches!(action, Action::CreateChart { .. }) {
                    spec.id = m.new_id("c");
                    let reply = Reply::Created {
                        id: spec.id.clone(),
                        sheet: spec.sheet,
                    };
                    m.charts.push(spec);
                    reply
                } else {
                    let slot = m
                        .charts
                        .iter_mut()
                        .find(|c| c.id == spec.id)
                        .ok_or_else(|| bad(format!("no chart {}", spec.id)))?;
                    *slot = spec;
                    Reply::Ok
                }
            }
            Action::CreateSlicer { spec } | Action::UpdateSlicer { spec } => {
                cell(spec.row, spec.col)?;
                match &spec.target {
                    DataTarget::Table { table } => {
                        let t = self.tables.spec(table).map_err(bad)?;
                        if spec.column as usize >= t.columns.len() {
                            return Err(bad("no such column".into()));
                        }
                    }
                    DataTarget::Range { range } => {
                        if spec.column < range.c0 || spec.column > range.c1 {
                            return Err(bad("the slicer column must be inside the range".into()));
                        }
                    }
                }
                let mut spec = spec.clone();
                if matches!(action, Action::CreateSlicer { .. }) {
                    // A slicer on cells needs a filtered range to drive.
                    if let DataTarget::Range { range } = &spec.target {
                        if !m.range_filters.iter().any(|f| f.range == *range) {
                            return Err(bad(
                                "create a filter on the range first (Data → Create filter)".into(),
                            ));
                        }
                    }
                    spec.id = m.new_id("s");
                    let reply = Reply::Created {
                        id: spec.id.clone(),
                        sheet: spec.sheet,
                    };
                    m.slicers.push(spec);
                    reply
                } else {
                    let slot = m
                        .slicers
                        .iter_mut()
                        .find(|s| s.id == spec.id)
                        .ok_or_else(|| bad(format!("no slicer {}", spec.id)))?;
                    *slot = spec;
                    Reply::Ok
                }
            }
            Action::SetValidation { spec } => {
                let r = &spec.range;
                if r.r0 > r.r1 || r.c0 > r.c1 {
                    return Err(bad("range is inverted".into()));
                }
                cell(r.r1, r.c1)?;
                let mut spec = spec.clone();
                spec.values = spec
                    .values
                    .iter()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect();
                if spec.values.is_empty() && spec.source.is_none() {
                    return Err(bad(
                        "list at least one allowed value or a source range".into()
                    ));
                }
                if spec.id.is_empty() {
                    spec.id = m.new_id("v");
                    let reply = Reply::Created {
                        id: spec.id.clone(),
                        sheet: spec.range.sheet,
                    };
                    m.validations.push(spec);
                    reply
                } else {
                    let slot = m
                        .validations
                        .iter_mut()
                        .find(|v| v.id == spec.id)
                        .ok_or_else(|| bad(format!("no rule {}", spec.id)))?;
                    *slot = spec;
                    Reply::Ok
                }
            }
            Action::DeleteObject { id } => {
                let before = (
                    m.pivots.len(),
                    m.charts.len(),
                    m.slicers.len(),
                    m.validations.len(),
                );
                m.pivots.retain(|p| p.id != *id);
                m.charts.retain(|c| c.id != *id);
                m.slicers.retain(|s| s.id != *id);
                m.validations.retain(|v| v.id != *id);
                if before
                    == (
                        m.pivots.len(),
                        m.charts.len(),
                        m.slicers.len(),
                        m.validations.len(),
                    )
                {
                    return Err(bad(format!("no object {id}")));
                }
                Reply::Ok
            }
            Action::AddCondFormat { range, rule, style } => {
                if range.r0 > range.r1 || range.c0 > range.c1 {
                    return Err(bad("range is inverted".into()));
                }
                cell(range.r1, range.c1)?;
                self.um
                    .add_conditional_formatting(range.sheet, &a1(range), cf_input(rule, style)?)
                    .map_err(bad)?;
                return Ok(Some(Reply::Ok));
            }
            Action::DeleteCondFormat { sheet, index } => {
                self.um
                    .delete_conditional_formatting(*sheet, *index)
                    .map_err(bad)?;
                return Ok(Some(Reply::Ok));
            }
            _ => return Ok(None),
        };
        self.tables.set_manifest(m).map_err(bad)?;
        Ok(Some(reply))
    }
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}
