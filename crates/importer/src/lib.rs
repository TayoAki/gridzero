//! File import (BUILD-SPEC §3 ImportService, PRD FR-16): reads an uploaded file that
//! the workbook host has already staged (and decompressed) on local disk.
//!
//! Formats: delimited text (CSV/TSV/TXT, separator autodetected), JSON Lines,
//! Parquet and XLSX. `preview` parses only the start of a file so the import
//! dialog opens quickly (spike S3 finding 3); `load` reads all of it into a
//! Polars DataFrame, which becomes a Data Table or is written into cells.

use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

use calamine::{open_workbook_auto, Data, DataType as _, Reader};
use polars::prelude::*;
use protocol::{ColumnInfo, ImportOptions, ImportPreview};

/// How much of a text file the preview parses.
const PREVIEW_BYTES: usize = 4 << 20;
pub const PREVIEW_ROWS: usize = 100;
const INFER_ROWS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Jsonl,
    Parquet,
    Xlsx,
}

impl Format {
    /// From a file name; a trailing `.gz` must already have been stripped by the uploader.
    pub fn from_name(name: &str) -> Option<Format> {
        let ext = name.rsplit('.').next()?.to_ascii_lowercase();
        Some(match ext.as_str() {
            "csv" | "tsv" | "txt" | "tab" => Format::Csv,
            "jsonl" | "ndjson" | "json" => Format::Jsonl,
            "parquet" | "pq" => Format::Parquet,
            "xlsx" | "xlsm" | "xls" | "ods" => Format::Xlsx,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Jsonl => "jsonl",
            Format::Parquet => "parquet",
            Format::Xlsx => "xlsx",
        }
    }
}

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Parse the start of `path` for the import dialog.
pub fn preview(path: &Path, name: &str, opts: &ImportOptions) -> Result<ImportPreview> {
    let format = Format::from_name(name).ok_or_else(|| format!("unsupported file type: {name}"))?;
    let bytes = std::fs::metadata(path).map_err(err)?.len();
    let (df, separator, total_rows) = match format {
        Format::Csv => {
            let mut prefix = Vec::with_capacity(PREVIEW_BYTES.min(bytes as usize));
            File::open(path)
                .map_err(err)?
                .take(PREVIEW_BYTES as u64)
                .read_to_end(&mut prefix)
                .map_err(err)?;
            let whole = prefix.len() as u64 == bytes;
            if !whole {
                // Cut at a line end so the sample does not end in half a record.
                if let Some(end) = prefix.iter().rposition(|&b| b == b'\n') {
                    prefix.truncate(end + 1);
                }
            }
            let sep = separator(opts, name, &prefix)?;
            let lines = prefix.iter().filter(|&&b| b == b'\n').count() as u64;
            let sample_len = prefix.len() as u64;
            let df = read_csv(Cursor::new(prefix), opts, sep, Some(PREVIEW_ROWS))?;
            let total = if whole {
                // Small file: count records exactly.
                Some(read_csv(File::open(path).map_err(err)?, opts, sep, None)?.height() as u64)
            } else {
                // Estimate from line density, minus the header.
                Some((lines * bytes / sample_len.max(1)).saturating_sub(opts.header as u64))
            };
            (df, Some((sep as char).to_string()), total)
        }
        Format::Jsonl => {
            let mut prefix = Vec::new();
            File::open(path)
                .map_err(err)?
                .take(PREVIEW_BYTES as u64)
                .read_to_end(&mut prefix)
                .map_err(err)?;
            let whole = prefix.len() as u64 == bytes;
            let lines: Vec<&[u8]> = prefix
                .split(|&b| b == b'\n')
                .filter(|l| !l.iter().all(u8::is_ascii_whitespace))
                .collect();
            let keep = if whole {
                lines.len()
            } else {
                lines.len().saturating_sub(1)
            };
            let sample = lines[..keep.min(PREVIEW_ROWS)].join(&b'\n');
            let df = JsonReader::new(Cursor::new(sample))
                .with_json_format(JsonFormat::JsonLines)
                .infer_schema_len(None)
                .finish()
                .map_err(err)?;
            let total = if whole {
                keep as u64
            } else {
                keep as u64 * bytes / prefix.len().max(1) as u64
            };
            (df, None, Some(total))
        }
        Format::Parquet => {
            let total = ParquetReader::new(File::open(path).map_err(err)?)
                .num_rows()
                .map_err(err)? as u64;
            let df = ParquetReader::new(File::open(path).map_err(err)?)
                .with_slice(Some((0, PREVIEW_ROWS)))
                .finish()
                .map_err(err)?;
            (df, None, Some(total))
        }
        Format::Xlsx => {
            let (df, total) = read_xlsx(path, opts, Some(PREVIEW_ROWS))?;
            (df, None, Some(total))
        }
    };
    Ok(ImportPreview {
        format: format.as_str().into(),
        separator,
        columns: columns(&df),
        rows: sample_rows(&df, PREVIEW_ROWS),
        total_rows,
        bytes,
    })
}

/// Read all of `path`.
pub fn load(path: &Path, name: &str, opts: &ImportOptions) -> Result<DataFrame> {
    let format = Format::from_name(name).ok_or_else(|| format!("unsupported file type: {name}"))?;
    let df = match format {
        Format::Csv => {
            let mut prefix = Vec::new();
            File::open(path)
                .map_err(err)?
                .take(64 << 10)
                .read_to_end(&mut prefix)
                .map_err(err)?;
            let sep = separator(opts, name, &prefix)?;
            read_csv_file(path, opts, sep)?
        }
        Format::Jsonl => JsonReader::new(File::open(path).map_err(err)?)
            .with_json_format(JsonFormat::JsonLines)
            .infer_schema_len(std::num::NonZeroUsize::new(INFER_ROWS))
            .finish()
            .map_err(err)?,
        Format::Parquet => ParquetReader::new(File::open(path).map_err(err)?)
            .finish()
            .map_err(err)?,
        Format::Xlsx => read_xlsx(path, opts, None)?.0,
    };
    Ok(unique_names(df))
}

fn separator(opts: &ImportOptions, name: &str, sample: &[u8]) -> Result<u8> {
    if let Some(s) = opts.separator.as_deref().filter(|s| !s.is_empty()) {
        let s = if s == "\\t" { "\t" } else { s };
        return match s.as_bytes() {
            [b] => Ok(*b),
            _ => Err("separator must be one character".into()),
        };
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".tsv") || lower.ends_with(".tab") {
        return Ok(b'\t');
    }
    Ok(sniff_separator(sample))
}

/// The candidate that appears the same, non-zero number of times on the most lines
/// (counting only outside double quotes).
pub fn sniff_separator(sample: &[u8]) -> u8 {
    const CANDIDATES: [u8; 4] = [b',', b'\t', b';', b'|'];
    let mut counts: Vec<[u32; 4]> = Vec::new();
    let mut line = [0u32; 4];
    let mut in_quotes = false;
    for &b in sample.iter().take(256 << 10) {
        match b {
            b'"' => in_quotes = !in_quotes,
            b'\n' if !in_quotes => {
                counts.push(line);
                line = [0; 4];
                if counts.len() >= 50 {
                    break;
                }
            }
            _ if !in_quotes => {
                if let Some(i) = CANDIDATES.iter().position(|&c| c == b) {
                    line[i] += 1;
                }
            }
            _ => {}
        }
    }
    if counts.is_empty() {
        counts.push(line);
    }
    let mut best = (b',', 0usize);
    for (i, &c) in CANDIDATES.iter().enumerate() {
        let first = counts[0][i];
        if first == 0 {
            continue;
        }
        let consistent = counts.iter().filter(|l| l[i] == first).count();
        if consistent > best.1 {
            best = (c, consistent);
        }
    }
    best.0
}

fn csv_options(
    opts: &ImportOptions,
    sep: u8,
    n_rows: Option<usize>,
    infer: Option<usize>,
) -> CsvReadOptions {
    let quote = opts
        .quote
        .as_deref()
        .and_then(|q| q.bytes().next())
        .unwrap_or(b'"');
    CsvReadOptions::default()
        .with_has_header(opts.header)
        .with_skip_rows(opts.skip_rows as usize)
        .with_infer_schema_length(infer)
        .with_n_rows(n_rows)
        .map_parse_options(|p| {
            p.with_separator(sep)
                .with_quote_char(Some(quote))
                .with_try_parse_dates(true)
                .with_truncate_ragged_lines(true)
        })
}

fn read_csv<R: std::io::Read + std::io::Seek + Send + Sync + 'static>(
    reader: R,
    opts: &ImportOptions,
    sep: u8,
    n_rows: Option<usize>,
) -> Result<DataFrame>
where
    R: polars::io::mmap::MmapBytesReader,
{
    csv_options(opts, sep, n_rows, Some(INFER_ROWS))
        .into_reader_with_file_handle(reader)
        .finish()
        .map_err(err)
}

fn read_csv_file(path: &Path, opts: &ImportOptions, sep: u8) -> Result<DataFrame> {
    let read = |infer| {
        csv_options(opts, sep, None, infer)
            .try_into_reader_with_file_path(Some(path.to_path_buf()))
            .and_then(|r| r.finish())
    };
    match read(Some(INFER_ROWS)) {
        Ok(df) => Ok(df),
        // A column that looked numeric in the first rows but is not: read everything as text.
        Err(_) => read(Some(0)).map_err(err),
    }
}

/// First sheet of a workbook. Columns are typed by their cells: all integers, all
/// numbers, all booleans or all dates; anything mixed becomes text.
fn read_xlsx(path: &Path, opts: &ImportOptions, limit: Option<usize>) -> Result<(DataFrame, u64)> {
    let mut wb = open_workbook_auto(path).map_err(err)?;
    let first = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or("the workbook has no sheets")?;
    let range = wb.worksheet_range(&first).map_err(err)?;
    let mut rows = range.rows().skip(opts.skip_rows as usize);
    let width = range.width();
    let names: Vec<String> = if opts.header {
        let header = rows.next().unwrap_or(&[]);
        (0..width)
            .map(|i| match header.get(i) {
                Some(Data::Empty) | None => format!("column_{}", i + 1),
                Some(d) => d.to_string(),
            })
            .collect()
    } else {
        (0..width).map(|i| format!("column_{}", i + 1)).collect()
    };
    let total = (range.height() as u64).saturating_sub(opts.skip_rows as u64 + opts.header as u64);
    let body: Vec<&[Data]> = match limit {
        Some(n) => rows.take(n).collect(),
        None => rows.collect(),
    };
    let mut cols = Vec::with_capacity(width);
    for (i, name) in names.iter().enumerate() {
        let cells = body.iter().map(|r| r.get(i).unwrap_or(&Data::Empty));
        cols.push(xlsx_column(name, cells, body.len()).into_column());
    }
    let df = DataFrame::new_infer_height(cols).map_err(err)?;
    Ok((unique_names(df), total))
}

fn xlsx_column<'a>(
    name: &str,
    cells: impl Iterator<Item = &'a Data> + Clone,
    len: usize,
) -> Series {
    let name = PlSmallStr::from(name);
    let present = cells.clone().filter(|d| !matches!(d, Data::Empty));
    let all = |f: fn(&Data) -> bool| present.clone().all(f);
    if all(|d| matches!(d, Data::Int(_))) {
        let v: Vec<Option<i64>> = cells.map(|d| d.get_int()).collect();
        Series::new(name, v)
    } else if all(|d| matches!(d, Data::Int(_) | Data::Float(_))) {
        let v: Vec<Option<f64>> = cells
            .map(|d| d.get_float().or(d.get_int().map(|i| i as f64)))
            .collect();
        Series::new(name, v)
    } else if all(|d| matches!(d, Data::Bool(_))) {
        let v: Vec<Option<bool>> = cells.map(|d| d.get_bool()).collect();
        Series::new(name, v)
    } else if present.clone().next().is_some() && all(|d| matches!(d, Data::DateTime(_))) {
        // Excel serial 25569 is 1970-01-01. Whole-day serials are dates; others carry a time.
        let serials: Vec<Option<f64>> = cells
            .map(|d| d.get_datetime().map(|t| t.as_f64()))
            .collect();
        if serials.iter().flatten().all(|s| s.fract() == 0.0) {
            let v: Vec<Option<i32>> = serials
                .iter()
                .map(|s| s.map(|s| (s - 25569.0) as i32))
                .collect();
            Series::new(name, v).cast(&DataType::Date)
        } else {
            let v: Vec<Option<i64>> = serials
                .iter()
                .map(|s| s.map(|s| ((s - 25569.0) * 86_400_000.0).round() as i64))
                .collect();
            Series::new(name, v).cast(&DataType::Datetime(TimeUnit::Milliseconds, None))
        }
        .unwrap_or_else(|_| Series::new_null(PlSmallStr::EMPTY, len))
    } else {
        let v: Vec<Option<String>> = cells
            .map(|d| match d {
                Data::Empty => None,
                d => Some(d.to_string()),
            })
            .collect();
        Series::new(name, v)
    }
}

/// Column names must be unique and non-empty for a Data Table.
fn unique_names(mut df: DataFrame) -> DataFrame {
    let mut seen = std::collections::HashSet::new();
    let names: Vec<String> = df
        .get_column_names()
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let base = if n.trim().is_empty() {
                format!("column_{}", i + 1)
            } else {
                n.to_string()
            };
            let mut name = base.clone();
            let mut k = 2;
            while !seen.insert(name.clone()) {
                name = format!("{base}_{k}");
                k += 1;
            }
            name
        })
        .collect();
    let _ = df.set_column_names(&names);
    df
}

pub fn dtype_name(dtype: &DataType) -> &'static str {
    match dtype {
        DataType::Boolean => "boolean",
        d if d.is_integer() => "integer",
        d if d.is_float() => "number",
        DataType::Date => "date",
        DataType::Datetime(..) => "datetime",
        _ => "text",
    }
}

pub fn columns(df: &DataFrame) -> Vec<ColumnInfo> {
    df.schema()
        .iter()
        .map(|(name, dtype)| ColumnInfo {
            name: name.to_string(),
            dtype: dtype_name(dtype).into(),
        })
        .collect()
}

fn sample_rows(df: &DataFrame, n: usize) -> Vec<Vec<String>> {
    let df = df.head(Some(n));
    (0..df.height())
        .map(|r| {
            df.columns()
                .iter()
                .map(|c| display(&c.get(r).unwrap_or(AnyValue::Null)))
                .collect()
        })
        .collect()
}

/// How a Data Table shows a value: integers plainly, floats with up to 10 significant
/// decimals, ISO dates, TRUE/FALSE, blanks for nulls.
pub fn display(v: &AnyValue) -> String {
    match v {
        AnyValue::Null => String::new(),
        AnyValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        AnyValue::String(s) => s.to_string(),
        AnyValue::StringOwned(s) => s.to_string(),
        AnyValue::Float64(f) => fmt_float(*f),
        AnyValue::Float32(f) => fmt_float(*f as f64),
        AnyValue::Datetime(..) | AnyValue::DatetimeOwned(..) => {
            let s = v.to_string();
            // "2025-01-02 03:04:05" without fractional zeros.
            let s = s.trim_matches('"');
            match s.split_once('.') {
                Some((head, frac)) if frac.chars().all(|c| c == '0') => head.to_string(),
                _ => s.to_string(),
            }
        }
        v => v.to_string().trim_matches('"').to_string(),
    }
}

pub fn fmt_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.fract() == 0.0 && f.abs() < 1e15 {
        return format!("{}", f as i64);
    }
    let s = format!("{:.10}", f);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

#[cfg(test)]
mod tests;
