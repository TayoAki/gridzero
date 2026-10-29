use super::*;
use std::io::Write;

fn write(dir: &tempfile::TempDir, name: &str, body: &[u8]) -> std::path::PathBuf {
    let path = dir.path().join(name);
    std::fs::File::create(&path)
        .unwrap()
        .write_all(body)
        .unwrap();
    path
}

fn opts() -> ImportOptions {
    ImportOptions::default()
}

#[test]
fn sniffs_separators() {
    assert_eq!(sniff_separator(b"a,b,c\n1,2,3\n"), b',');
    assert_eq!(sniff_separator(b"a;b;c\n1;2,5;3\n4;5;6\n"), b';');
    assert_eq!(sniff_separator(b"a\tb\n1\t2\n"), b'\t');
    assert_eq!(sniff_separator(b"a|b\n\"x,y\"|2\n"), b'|');
}

#[test]
fn csv_preview_types_and_load() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        &dir,
        "orders.csv",
        b"id,date,region,amount,flag,note\n1,2025-01-02,North,10.5,true,\"a, b\"\n2,2025-01-03,South,,false,\"he said \"\"hi\"\"\"\n3,2025-02-01,East,7,true,\"two\nlines\"\n",
    );
    let p = preview(&path, "orders.csv", &opts()).unwrap();
    assert_eq!(p.format, "csv");
    assert_eq!(p.separator.as_deref(), Some(","));
    assert_eq!(p.total_rows, Some(3));
    let types: Vec<&str> = p.columns.iter().map(|c| c.dtype.as_str()).collect();
    assert_eq!(
        types,
        ["integer", "date", "text", "number", "boolean", "text"]
    );
    assert_eq!(
        p.rows[0],
        ["1", "2025-01-02", "North", "10.5", "TRUE", "a, b"]
    );
    assert_eq!(p.rows[1][3], "");
    assert_eq!(p.rows[1][5], "he said \"hi\"");
    assert_eq!(p.rows[2][5], "two\nlines");

    let df = load(&path, "orders.csv", &opts()).unwrap();
    assert_eq!(df.shape(), (3, 6));
}

#[test]
fn csv_options_header_skip_and_separator() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(&dir, "x.txt", b"report generated today\n1;2\n3;4\n");
    let p = preview(
        &path,
        "x.txt",
        &ImportOptions {
            header: false,
            skip_rows: 1,
            separator: Some(";".into()),
            quote: None,
        },
    )
    .unwrap();
    assert_eq!(p.columns.len(), 2);
    assert_eq!(p.rows, vec![vec!["1", "2"], vec!["3", "4"]]);
}

#[test]
fn mixed_column_falls_back_to_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut body = String::from("v\n");
    for i in 0..12_000 {
        body.push_str(&format!("{i}\n"));
    }
    body.push_str("not a number\n");
    let path = write(&dir, "m.csv", body.as_bytes());
    let df = load(&path, "m.csv", &opts()).unwrap();
    assert_eq!(df.height(), 12_001);
    assert_eq!(dtype_name(df.column("v").unwrap().dtype()), "text");
}

#[test]
fn duplicate_and_blank_header_names_are_made_unique() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(&dir, "d.csv", b"a,a,\n1,2,3\n");
    let df = load(&path, "d.csv", &opts()).unwrap();
    let names: Vec<String> = df
        .get_column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(names[0], "a");
    let unique: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(unique.len(), 3);
    assert!(names.iter().all(|n| !n.is_empty()));
}

#[test]
fn jsonl_and_parquet() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        &dir,
        "e.jsonl",
        b"{\"a\":1,\"b\":\"x\"}\n{\"a\":2,\"b\":\"y\"}\n",
    );
    let p = preview(&path, "e.jsonl", &opts()).unwrap();
    assert_eq!(p.total_rows, Some(2));
    assert_eq!(p.rows[1], ["2", "y"]);
    let mut df = load(&path, "e.jsonl", &opts()).unwrap();

    let pq = dir.path().join("e.parquet");
    ParquetWriter::new(File::create(&pq).unwrap())
        .finish(&mut df)
        .unwrap();
    let p = preview(&pq, "e.parquet", &opts()).unwrap();
    assert_eq!(p.total_rows, Some(2));
    assert_eq!(load(&pq, "e.parquet", &opts()).unwrap().shape(), (2, 2));
}

#[test]
fn xlsx_typed_columns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("w.xlsx");
    let mut wb = rust_xlsxwriter::Workbook::new();
    let date = rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd");
    let ws = wb.add_worksheet();
    for (c, h) in ["n", "f", "when", "ok", "mixed"].iter().enumerate() {
        ws.write_string(0, c as u16, *h).unwrap();
    }
    for r in 1..=3u32 {
        ws.write_number(r, 0, r as f64).unwrap();
        ws.write_number(r, 1, r as f64 + 0.5).unwrap();
        ws.write_number_with_format(r, 2, 45658.0 + r as f64, &date)
            .unwrap();
        ws.write_boolean(r, 3, r % 2 == 0).unwrap();
        if r == 2 {
            ws.write_string(r, 4, "x").unwrap();
        } else {
            ws.write_number(r, 4, 1.0).unwrap();
        }
    }
    wb.save(&path).unwrap();

    let p = preview(&path, "w.xlsx", &opts()).unwrap();
    assert_eq!(p.total_rows, Some(3));
    let types: Vec<&str> = p.columns.iter().map(|c| c.dtype.as_str()).collect();
    assert_eq!(types, ["number", "number", "date", "boolean", "text"]);
    assert_eq!(p.rows[0][2], "2025-01-02");
    assert_eq!(p.rows[0][1], "1.5");
    assert_eq!(load(&path, "w.xlsx", &opts()).unwrap().shape(), (3, 5));
}

#[test]
fn formats_by_name() {
    assert_eq!(Format::from_name("a.TSV"), Some(Format::Csv));
    assert_eq!(Format::from_name("a.ndjson"), Some(Format::Jsonl));
    assert_eq!(Format::from_name("a.xlsx"), Some(Format::Xlsx));
    assert_eq!(Format::from_name("a.exe"), None);
    assert_eq!(fmt_float(2.50), "2.5");
    assert_eq!(fmt_float(3.0), "3");
}
