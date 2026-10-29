//! M2: import, Data Tables, range data tools, unified undo.

use super::*;
use protocol::{
    ColumnFilter, DataTarget, FilterOp, ImportDest, ImportMode, ImportOptions, SortKey,
};

const CSV: &str = "id,region,units,price,code\n1,North,10,2.5,00123\n2,South,30,1.5,A-1\n3,North,5,4,=bad\n4,East,30,1,TRUE\n";

fn stage(wb: &Workbook, id: &str, name: &str, body: &str) {
    let dir = wb.dir().join("staging");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{id}.{name}")), body).unwrap();
}

fn import(wb: &mut Workbook, id: &str, dest: ImportDest, mode: ImportMode) -> Reply {
    reply(run(
        wb,
        Action::FinalizeImport {
            import_id: id.into(),
            options: ImportOptions::default(),
            dest,
            mode,
            name: "orders.csv".into(),
        },
    ))
}

fn texts(
    wb: &Workbook,
    sheet: u32,
    rows: std::ops::Range<u32>,
    cols: std::ops::Range<u32>,
) -> Vec<Vec<String>> {
    let tile = wb.tile(sheet, 0, 0).unwrap();
    rows.map(|r| {
        cols.clone()
            .map(|c| {
                tile.cells
                    .iter()
                    .find(|x| x.0 == r * TILE_COLS + c)
                    .map(|x| x.1.clone())
                    .unwrap_or_default()
            })
            .collect()
    })
    .collect()
}

fn table_id(wb: &Workbook, sheet: u32) -> String {
    wb.sheet_meta(sheet).unwrap().tables[0].id.clone()
}

#[test]
fn import_preview_then_table_on_new_sheet_with_undo() {
    let mut wb = Workbook::new_empty();
    stage(&wb, "imp1", "orders.csv", CSV);
    let preview = match reply(run(
        &mut wb,
        Action::ImportPreview {
            import_id: "imp1".into(),
            options: ImportOptions::default(),
        },
    )) {
        Reply::ImportPreview { preview } => preview,
        r => panic!("{r:?}"),
    };
    assert_eq!(preview.total_rows, Some(4));
    assert_eq!(preview.columns[2].dtype, "integer");

    let r = import(&mut wb, "imp1", ImportDest::NewSheet, ImportMode::Table);
    let Reply::Imported {
        sheet, rows, table, ..
    } = r
    else {
        panic!("{r:?}")
    };
    assert_eq!((sheet, rows), (1, 5));
    assert!(table.is_some());
    assert_eq!(wb.sheets()[1].name, "orders");
    let meta = wb.sheet_meta(1).unwrap();
    assert_eq!(meta.tables.len(), 1);
    assert_eq!(meta.tables[0].rows, 4);
    assert_eq!(
        texts(&wb, 1, 0..2, 0..5),
        [
            ["id", "region", "units", "price", "code"],
            ["1", "North", "10", "2.5", "00123"]
        ]
    );
    let header = wb
        .tile(1, 0, 0)
        .unwrap()
        .cells
        .into_iter()
        .find(|c| c.0 == 0)
        .unwrap();
    assert_eq!(header.2 & kind::HEADER_BUTTON, kind::HEADER_BUTTON);
    // The staged upload is consumed.
    assert!(wb.staged("imp1").is_err());

    // Cells of the table are read-only through cell edits.
    let mut clip = None;
    let err = wb.execute(
        &Action::UpdateCell {
            sheet: 1,
            row: 2,
            col: 1,
            raw: "x".into(),
        },
        &mut clip,
    );
    assert!(err.is_err());

    // One undo removes the sheet and the table together.
    run(&mut wb, Action::Undo);
    assert_eq!(wb.sheets().len(), 1);
    assert!(wb.tables().manifest().tables.is_empty());
    run(&mut wb, Action::Redo);
    assert_eq!(wb.sheets().len(), 2);
    assert_eq!(wb.sheet_meta(1).unwrap().tables.len(), 1);
}

#[test]
fn table_sort_filter_computed_distinct_stats_and_replay() {
    let mut wb = Workbook::new_empty();
    let start = wb.to_snapshot();
    let mut log = Vec::new();
    let mut exec = |wb: &mut Workbook, a: Action| {
        let mut clip = None;
        let out = wb
            .execute(&a, &mut clip)
            .unwrap_or_else(|e| panic!("{a:?}: {e}"));
        if let Outcome::Mutated {
            seq,
            ref diffs,
            ref tables,
            ..
        } = out
        {
            log.push((seq, diffs.clone(), tables.clone()));
        }
        reply(out)
    };
    stage(&wb, "imp2", "orders.csv", CSV);
    exec(
        &mut wb,
        Action::FinalizeImport {
            import_id: "imp2".into(),
            options: ImportOptions::default(),
            dest: ImportDest::Cell {
                sheet: S,
                row: 2,
                col: 1,
            },
            mode: ImportMode::Table,
            name: "orders".into(),
        },
    );
    let t = table_id(&wb, S);
    exec(
        &mut wb,
        Action::AddComputedColumn {
            table: t.clone(),
            name: "total".into(),
            expr: "=[units]*[price]".into(),
        },
    );
    exec(
        &mut wb,
        Action::SortTable {
            table: t.clone(),
            keys: vec![SortKey { col: 5, desc: true }],
        },
    );
    exec(
        &mut wb,
        Action::SetFilter {
            target: DataTarget::Table { table: t.clone() },
            col: 1,
            filter: Some(ColumnFilter::Values {
                values: vec!["North".into(), "South".into()],
            }),
        },
    );
    // Header at row 2, col 1 (B3): sorted by total desc, East filtered out.
    let grid = texts(&wb, S, 2, 6);
    fn texts(wb: &Workbook, s: u32, r0: u32, c0: u32) -> Vec<Vec<String>> {
        (r0..r0 + 4)
            .map(|r| {
                (c0..c0 + 1)
                    .map(|c| wb.tables().cell_text(s, r as u64, c).unwrap_or_default())
                    .collect()
            })
            .collect()
    }
    assert_eq!(grid, [["total = [units]*[price]"], ["45"], ["25"], ["20"]]);

    let r = exec(
        &mut wb,
        Action::DistinctValues {
            target: DataTarget::Table { table: t.clone() },
            col: 1,
            search: None,
            limit: 10,
        },
    );
    assert_eq!(
        r,
        Reply::Distinct {
            values: vec![("East".into(), 1), ("North".into(), 2), ("South".into(), 1)],
            total: 3
        }
    );

    let r = exec(
        &mut wb,
        Action::SelectionStats {
            range: range(3, 3, 5, 3),
        },
    );
    assert_eq!(
        r,
        Reply::Stats {
            count: 3,
            numbers: 3,
            sum: 45.0,
            min: Some(5.0),
            max: Some(30.0)
        }
    );

    // A computed column with an error is refused and changes nothing.
    let mut clip = None;
    let seq = wb.seq;
    assert!(wb
        .execute(
            &Action::AddComputedColumn {
                table: t.clone(),
                name: "bad".into(),
                expr: "=[nope]".into()
            },
            &mut clip
        )
        .is_err());
    assert_eq!(wb.seq, seq);

    // Undo the filter, then replay the whole log onto the starting snapshot.
    exec(&mut wb, Action::Undo);
    assert_eq!(wb.sheet_meta(S).unwrap().tables[0].rows, 4);
    let mut restored =
        Workbook::from_snapshot(&start.data, Some(&start.tables), 0, wb.dir().to_path_buf())
            .unwrap();
    for (seq, diffs, tables) in &log {
        restored.replay(*seq, diffs, tables.as_deref()).unwrap();
    }
    assert_eq!(restored.sheet_meta(S).unwrap(), wb.sheet_meta(S).unwrap());
    assert_eq!(restored.tile(S, 0, 0).unwrap(), wb.tile(S, 0, 0).unwrap());
}

#[test]
fn cell_import_keeps_text_and_reimport_recomputes_formulas() {
    let mut wb = Workbook::new_empty();
    stage(&wb, "c1", "orders.csv", CSV);
    import(
        &mut wb,
        "c1",
        ImportDest::Cell {
            sheet: S,
            row: 0,
            col: 0,
        },
        ImportMode::Cells,
    );
    set(&mut wb, 0, 7, "=SUM(C2:C5)");
    assert_eq!(num(&wb, 0, 7), 75.0);
    assert_eq!(wb.value(S, 1, 4), CellValue::String("00123".into()));
    assert_eq!(wb.value(S, 3, 4), CellValue::String("=bad".into()));
    assert_eq!(num(&wb, 1, 3), 2.5);

    // A shorter file at the same anchor replaces the old rows entirely.
    stage(&wb, "c2", "orders.csv", "id,region,units\n9,West,100\n");
    import(
        &mut wb,
        "c2",
        ImportDest::Cell {
            sheet: S,
            row: 0,
            col: 0,
        },
        ImportMode::Cells,
    );
    assert_eq!(num(&wb, 0, 7), 100.0);
    assert_eq!(wb.value(S, 2, 0), CellValue::None);
    assert_eq!(wb.value(S, 1, 3), CellValue::None);
    run(&mut wb, Action::Undo);
    assert_eq!(num(&wb, 0, 7), 75.0);
}

#[test]
fn range_sort_moves_formulas_and_dedupe_and_split() {
    let mut wb = Workbook::new_empty();
    for (r, (name, n)) in [("name", ""), ("b", "3"), ("a", "1"), ("c", ""), ("a", "1")]
        .iter()
        .enumerate()
    {
        set(&mut wb, r as u32, 0, name);
        set(&mut wb, r as u32, 1, n);
        if r > 0 {
            set(&mut wb, r as u32, 2, &format!("=B{}*10", r + 1));
        }
    }
    run(
        &mut wb,
        Action::SortRange {
            range: range(0, 0, 4, 2),
            keys: vec![SortKey { col: 1, desc: true }],
            header: true,
        },
    );
    let col = |wb: &Workbook, c: u32| -> Vec<String> {
        (1..5)
            .map(|r| match wb.value(S, r, c) {
                CellValue::String(s) => s,
                CellValue::Number(n) => n.to_string(),
                _ => String::new(),
            })
            .collect()
    };
    assert_eq!(col(&wb, 0), ["b", "a", "a", "c"]);
    // Formulas follow their rows: each still multiplies its own B cell.
    assert_eq!(col(&wb, 2), ["30", "10", "10", "0"]);
    // One undo restores the original order.
    run(&mut wb, Action::Undo);
    assert_eq!(col(&wb, 0), ["b", "a", "c", "a"]);
    run(&mut wb, Action::Redo);

    let r = reply(run(
        &mut wb,
        Action::RemoveDuplicates {
            target: DataTarget::Range {
                range: range(0, 0, 4, 1),
            },
            cols: vec![],
            header: true,
        },
    ));
    assert_eq!(r, Reply::Removed { removed: 1 });
    assert_eq!(col(&wb, 0), ["b", "a", "c", ""]);

    set(&mut wb, 10, 0, "x, y ,z");
    set(&mut wb, 11, 0, "p");
    run(
        &mut wb,
        Action::TextToColumns {
            range: range(10, 0, 11, 0),
            delimiter: ",".into(),
        },
    );
    assert_eq!(wb.value(S, 10, 1), CellValue::String("y".into()));
    assert_eq!(wb.value(S, 10, 2), CellValue::String("z".into()));
    assert_eq!(wb.value(S, 11, 0), CellValue::String("p".into()));
}

#[test]
fn range_filter_hides_rows_and_clears_in_one_undo_step() {
    let mut wb = Workbook::new_empty();
    for (r, (region, units)) in [
        ("region", "units"),
        ("North", "10"),
        ("South", "30"),
        ("North", "5"),
        ("East", "30"),
    ]
    .iter()
    .enumerate()
    {
        set(&mut wb, r as u32, 0, region);
        set(&mut wb, r as u32, 1, units);
    }
    let target = DataTarget::Range {
        range: range(0, 0, 4, 1),
    };
    run(
        &mut wb,
        Action::SetFilter {
            target: target.clone(),
            col: 1,
            filter: Some(ColumnFilter::Condition {
                op: FilterOp::Ge,
                value: "10".into(),
            }),
        },
    );
    run(
        &mut wb,
        Action::SetFilter {
            target: target.clone(),
            col: 0,
            filter: Some(ColumnFilter::Values {
                values: vec!["North".into()],
            }),
        },
    );
    let meta = wb.sheet_meta(S).unwrap();
    let mut hidden: Vec<u32> = meta
        .row_heights
        .iter()
        .filter(|(_, h)| *h == 0.0)
        .map(|(r, _)| *r)
        .collect();
    hidden.sort();
    assert_eq!(hidden, [2, 3, 4]);
    assert_eq!(meta.filters.len(), 1);
    let header = wb
        .tile(S, 0, 0)
        .unwrap()
        .cells
        .into_iter()
        .find(|c| c.0 == 0)
        .unwrap();
    assert_eq!(
        header.2 & (kind::HEADER_BUTTON | kind::FILTERED),
        kind::HEADER_BUTTON | kind::FILTERED
    );

    let r = reply(run(
        &mut wb,
        Action::DistinctValues {
            target: target.clone(),
            col: 0,
            search: None,
            limit: 10,
        },
    ));
    assert_eq!(
        r,
        Reply::Distinct {
            values: vec![("East".into(), 1), ("North".into(), 2), ("South".into(), 1)],
            total: 3
        }
    );

    // Undo the second filter only.
    run(&mut wb, Action::Undo);
    let hidden: Vec<u32> = wb
        .sheet_meta(S)
        .unwrap()
        .row_heights
        .iter()
        .filter(|(_, h)| *h == 0.0)
        .map(|(r, _)| *r)
        .collect();
    assert_eq!(hidden, [3]);
    run(&mut wb, Action::ClearFilters { target });
    let meta = wb.sheet_meta(S).unwrap();
    assert!(meta.row_heights.iter().all(|(_, h)| *h > 0.0));
    assert!(meta.filters.is_empty());
}

#[test]
fn multi_entry_actions_undo_as_one_step() {
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 0, "cat");
    set(&mut wb, 1, 0, "category");
    run(
        &mut wb,
        Action::ReplaceAll {
            sheet: S,
            find: "cat".into(),
            replace: "dog".into(),
        },
    );
    run(
        &mut wb,
        Action::Freeze {
            sheet: S,
            rows: 1,
            cols: 1,
        },
    );
    run(&mut wb, Action::Undo);
    run(&mut wb, Action::Undo);
    assert_eq!(wb.value(S, 0, 0), CellValue::String("cat".into()));
    assert_eq!(wb.value(S, 1, 0), CellValue::String("category".into()));
    assert_eq!(wb.sheet_meta(S).unwrap().frozen_rows, 0);
    run(&mut wb, Action::Undo);
    assert_eq!(wb.value(S, 1, 0), CellValue::None);
}

#[test]
fn deleting_a_sheet_moves_tables_on_later_sheets() {
    let mut wb = Workbook::new_empty();
    run(&mut wb, Action::AddSheet);
    stage(&wb, "d1", "orders.csv", CSV);
    import(&mut wb, "d1", ImportDest::NewSheet, ImportMode::Table);
    assert_eq!(wb.tables().manifest().tables[0].sheet, 2);
    run(&mut wb, Action::DeleteSheet { sheet: 1 });
    assert_eq!(wb.tables().manifest().tables[0].sheet, 1);
    assert_eq!(wb.sheet_meta(1).unwrap().tables.len(), 1);
    run(&mut wb, Action::Undo);
    assert_eq!(wb.tables().manifest().tables[0].sheet, 2);
}
