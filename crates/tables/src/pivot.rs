//! Pivot tables (PRD FR-12): group a source frame by row and column fields and
//! aggregate value fields, producing a small grid of display cells. Laid out like
//! Excel's tabular form: a header row, one row per row-key combination (sorted),
//! one column per column-key combination x value, and optional grand totals.

use std::collections::HashMap;

use polars::prelude::*;
use protocol::{kind, Agg, DateGroup, PivotField, PivotSpec, PivotValue};

use crate::{display, filter_expr, Result};

/// Most distinct column-key combinations a pivot will spread across columns.
pub const MAX_COLUMN_KEYS: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct PCell {
    pub text: String,
    /// Numeric value, for charts and stats.
    pub num: Option<f64>,
    pub kind: u8,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PivotGrid {
    pub cells: Vec<Vec<Option<PCell>>>,
    pub width: usize,
    /// Index of the grand-total row, if any (the header is row 0).
    pub total_row: Option<usize>,
    /// Columns holding row-field labels (the rest are values).
    pub label_cols: usize,
}

impl PivotGrid {
    pub fn height(&self) -> usize {
        self.cells.len()
    }

    pub fn get(&self, r: usize, c: usize) -> Option<&PCell> {
        self.cells.get(r)?.get(c)?.as_ref()
    }
}

fn text(s: impl Into<String>) -> Option<PCell> {
    Some(PCell {
        text: s.into(),
        num: None,
        kind: 0,
    })
}

fn cell(v: &AnyValue) -> Option<PCell> {
    if matches!(v, AnyValue::Null) {
        return None;
    }
    let num = v
        .dtype()
        .is_primitive_numeric()
        .then(|| v.extract::<f64>())
        .flatten();
    Some(PCell {
        text: display(v),
        num,
        kind: if num.is_some() { kind::NUMBER } else { 0 },
    })
}

pub fn agg_label(v: &PivotValue) -> String {
    let what = match v.agg {
        Agg::Sum => "Sum".to_string(),
        Agg::Count => "Count".into(),
        Agg::CountUnique => "Unique".into(),
        Agg::Avg => "Average".into(),
        Agg::Min => "Min".into(),
        Agg::Max => "Max".into(),
        Agg::Median => "Median".into(),
        Agg::Percentile => format!("P{}", (v.percentile.unwrap_or(0.9) * 100.0).round()),
    };
    format!("{what} of {}", v.field)
}

fn find_col(df: &DataFrame, name: &str) -> Result<(String, DataType)> {
    let schema = df.schema();
    let hit = schema
        .iter()
        .find(|(n, _)| n.as_str() == name)
        .or_else(|| schema.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)))
        .ok_or_else(|| format!("the source has no column \"{name}\""))?;
    Ok((hit.0.to_string(), hit.1.clone()))
}

fn key_expr(df: &DataFrame, f: &PivotField, alias: &str) -> Result<Expr> {
    let (name, dtype) = find_col(df, &f.field)?;
    let c = col(name.as_str());
    let e = match f.group {
        None => c,
        Some(g) => {
            if !matches!(dtype, DataType::Date | DataType::Datetime(..)) {
                return Err(format!(
                    "{} is not a date column, so it cannot be grouped by {g:?}",
                    f.field
                ));
            }
            match g {
                DateGroup::Year => c.dt().year(),
                DateGroup::Quarter => concat_str(
                    [
                        c.clone().dt().year().cast(DataType::String),
                        lit("-Q"),
                        c.dt().quarter().cast(DataType::String),
                    ],
                    "",
                    true,
                ),
                DateGroup::Month => c.dt().strftime("%Y-%m"),
                DateGroup::Day => c.cast(DataType::Date),
            }
        }
    };
    Ok(e.alias(alias))
}

fn agg_expr(df: &DataFrame, v: &PivotValue, alias: &str) -> Result<Expr> {
    let (name, dtype) = find_col(df, &v.field)?;
    let c = col(name.as_str());
    let numeric = dtype.is_primitive_numeric();
    if !numeric && matches!(v.agg, Agg::Sum | Agg::Avg | Agg::Median | Agg::Percentile) {
        return Err(format!(
            "{} is not numeric; use Count, Unique, Min or Max",
            v.field
        ));
    }
    let e = match v.agg {
        Agg::Sum => c.sum(),
        Agg::Count => c.count(),
        Agg::CountUnique => c.n_unique(),
        Agg::Avg => c.mean(),
        Agg::Min => c.min(),
        Agg::Max => c.max(),
        Agg::Median => c.median(),
        Agg::Percentile => c.quantile(
            lit(v.percentile.unwrap_or(0.9).clamp(0.0, 1.0)),
            QuantileMethod::Linear,
        ),
    };
    Ok(e.alias(alias))
}

/// Display key of the given columns in one row.
fn key_of(df: &DataFrame, cols: &[String], i: usize) -> Vec<String> {
    cols.iter()
        .map(|c| {
            df.column(c)
                .ok()
                .and_then(|s| s.get(i).ok())
                .map(|v| display(&v))
                .unwrap_or_default()
        })
        .collect()
}

fn values_of(df: &DataFrame, n: usize, i: usize) -> Vec<Option<PCell>> {
    (0..n)
        .map(|k| {
            df.column(&format!("__v{k}"))
                .ok()
                .and_then(|s| s.get(i).ok())
                .and_then(|v| cell(&v))
        })
        .collect()
}

pub fn compute(df: &DataFrame, spec: &PivotSpec) -> Result<PivotGrid> {
    if spec.values.is_empty() && spec.rows.is_empty() && spec.columns.is_empty() {
        return Ok(PivotGrid::default());
    }
    let mut lf = df.clone().lazy();
    for (field, f) in &spec.filters {
        let (name, dtype) = find_col(df, field)?;
        lf = lf.filter(filter_expr(&name, &dtype, f)?);
    }
    let row_keys: Vec<String> = (0..spec.rows.len()).map(|i| format!("__r{i}")).collect();
    let col_keys: Vec<String> = (0..spec.columns.len()).map(|i| format!("__c{i}")).collect();
    let mut keys = Vec::new();
    for (f, a) in spec.rows.iter().zip(&row_keys) {
        keys.push(key_expr(df, f, a)?);
    }
    let row_exprs = keys.clone();
    let mut col_exprs = Vec::new();
    for (f, a) in spec.columns.iter().zip(&col_keys) {
        col_exprs.push(key_expr(df, f, a)?);
    }
    // With no values, count rows so the pivot still lists its keys.
    let values: Vec<PivotValue> = if spec.values.is_empty() {
        vec![PivotValue {
            field: spec
                .rows
                .first()
                .or(spec.columns.first())
                .map(|f| f.field.clone())
                .unwrap_or_default(),
            agg: Agg::Count,
            percentile: None,
        }]
    } else {
        spec.values.clone()
    };
    let aggs: Vec<Expr> = values
        .iter()
        .enumerate()
        .map(|(k, v)| agg_expr(df, v, &format!("__v{k}")))
        .collect::<Result<_>>()?;
    let nv = aggs.len();
    let sorted = |keys: &[String]| {
        SortMultipleOptions::default()
            .with_nulls_last(true)
            .with_order_descending_multi(vec![false; keys.len()])
    };
    let err = |e: PolarsError| format!("pivot: {e}");

    // Distinct column keys (sorted) become the value columns.
    let col_combos: Vec<Vec<String>> = if col_keys.is_empty() {
        vec![Vec::new()]
    } else {
        let combos = lf
            .clone()
            .select(col_exprs.clone())
            .unique(None, UniqueKeepStrategy::First)
            .sort(col_keys.clone(), sorted(&col_keys))
            .collect()
            .map_err(err)?;
        if combos.height() > MAX_COLUMN_KEYS {
            return Err(format!(
                "the column fields have {} combinations; at most {MAX_COLUMN_KEYS} fit across a pivot (filter or move a field to rows)",
                combos.height()
            ));
        }
        (0..combos.height())
            .map(|i| key_of(&combos, &col_keys, i))
            .collect()
    };
    let col_index: HashMap<Vec<String>, usize> = col_combos
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, k)| (k, i))
        .collect();
    let spread = !col_keys.is_empty();
    let show_row_totals = spec.totals && spread;
    let label_cols = row_keys
        .len()
        .max(if row_keys.is_empty() && spread { 1 } else { 0 });
    let width = label_cols + col_combos.len() * nv + if show_row_totals { nv } else { 0 };

    // Header.
    let mut header: Vec<Option<PCell>> = spec.rows.iter().map(|f| text(field_label(f))).collect();
    if row_keys.is_empty() && spread {
        header.push(text(""));
    }
    for combo in &col_combos {
        for v in &values {
            let label = if !spread {
                agg_label(v)
            } else if nv == 1 {
                combo.join(" · ")
            } else {
                format!("{} · {}", combo.join(" · "), agg_label(v))
            };
            header.push(text(label));
        }
    }
    if show_row_totals {
        for v in &values {
            header.push(text(if nv == 1 {
                "Total".to_string()
            } else {
                format!("Total {}", agg_label(v))
            }));
        }
    }
    let mut cells = vec![header];

    // Body: one row per row-key combination.
    let mut all_keys = keys;
    all_keys.extend(col_exprs.clone());
    let all_names: Vec<String> = row_keys.iter().chain(&col_keys).cloned().collect();
    let body = if all_keys.is_empty() {
        lf.clone().select(aggs.clone()).collect().map_err(err)?
    } else {
        lf.clone()
            .group_by(all_keys)
            .agg(aggs.clone())
            .sort(all_names.clone(), sorted(&all_names))
            .collect()
            .map_err(err)?
    };
    let mut row_index: HashMap<Vec<String>, usize> = HashMap::new();
    for i in 0..body.height() {
        let rk = key_of(&body, &row_keys, i);
        let r = *row_index.entry(rk.clone()).or_insert_with(|| {
            let mut row: Vec<Option<PCell>> = rk.iter().map(|k| text(k.clone())).collect();
            if row_keys.is_empty() && spread {
                row.push(text(""));
            }
            row.resize(width, None);
            cells.push(row);
            cells.len() - 1
        });
        let ci = if spread {
            col_index[&key_of(&body, &col_keys, i)]
        } else {
            0
        };
        for (k, v) in values_of(&body, nv, i).into_iter().enumerate() {
            cells[r][label_cols + ci * nv + k] = v;
        }
    }
    if show_row_totals && !row_keys.is_empty() {
        let totals = lf
            .clone()
            .group_by(row_exprs.clone())
            .agg(aggs.clone())
            .collect()
            .map_err(err)?;
        for i in 0..totals.height() {
            if let Some(&r) = row_index.get(&key_of(&totals, &row_keys, i)) {
                for (k, v) in values_of(&totals, nv, i).into_iter().enumerate() {
                    cells[r][label_cols + col_combos.len() * nv + k] = v;
                }
            }
        }
    }

    // Grand-total row (only meaningful when rows are grouped).
    let mut total_row = None;
    if spec.totals && !row_keys.is_empty() {
        let mut row: Vec<Option<PCell>> = vec![None; width];
        row[0] = text("Grand Total");
        if spread {
            let by_col = lf
                .clone()
                .group_by(col_exprs)
                .agg(aggs.clone())
                .collect()
                .map_err(err)?;
            for i in 0..by_col.height() {
                let ci = col_index[&key_of(&by_col, &col_keys, i)];
                for (k, v) in values_of(&by_col, nv, i).into_iter().enumerate() {
                    row[label_cols + ci * nv + k] = v;
                }
            }
        }
        let overall = lf.select(aggs).collect().map_err(err)?;
        let at = if spread {
            label_cols + col_combos.len() * nv
        } else {
            label_cols
        };
        if !spread || show_row_totals {
            for (k, v) in values_of(&overall, nv, 0).into_iter().enumerate() {
                row[at + k] = v;
            }
        }
        cells.push(row);
        total_row = Some(cells.len() - 1);
    }
    for row in cells.iter_mut() {
        row.resize(width, None);
    }
    Ok(PivotGrid {
        cells,
        width,
        total_row,
        label_cols,
    })
}

fn field_label(f: &PivotField) -> String {
    match f.group {
        None => f.field.clone(),
        Some(g) => format!("{} ({})", f.field, format!("{g:?}").to_lowercase()),
    }
}
