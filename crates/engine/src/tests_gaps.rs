//! Closing M3 gaps: cell formulas over Data Table and pivot cells.

use super::*;
use protocol::{
    Agg, ColumnFilter, DataTarget, ImportDest, ImportMode, ImportOptions, PivotField, PivotSpec,
    PivotValue, SortKey,
};

fn import_sales(wb: &mut Workbook) -> (String, u32) {
    let dir = wb.dir().join("staging");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("g1.sales.csv"),
        "region,units,day\nNorth,1,2024-01-02\nSouth,2,2024-01-03\nNorth,3,2024-01-04\nEast,4,2024-01-05\n",
    )
    .unwrap();
    match reply(run(
        wb,
        Action::FinalizeImport {
            import_id: "g1".into(),
            options: ImportOptions::default(),
            dest: ImportDest::NewSheet,
            mode: ImportMode::Table,
            name: "sales".into(),
        },
    )) {
        Reply::Imported { table, sheet, .. } => (table.unwrap(), sheet),
        other => panic!("{other:?}"),
    }
}

fn text(wb: &Workbook, row: u32, col: u32) -> String {
    match wb.value(S, row, col) {
        CellValue::String(s) => s,
        other => panic!("({row},{col}) is {other:?}"),
    }
}

#[test]
fn formulas_read_table_and_pivot_cells_and_follow_their_changes() {
    let mut wb = Workbook::new_empty();
    let (t, ts) = import_sales(&mut wb);
    let name = wb.sheets()[ts as usize].name.clone();
    // A1: header cell, A2: first value, A3: sum of the units column, A4: a date.
    set(&mut wb, 0, 0, &format!("='{name}'!A1"));
    set(&mut wb, 1, 0, &format!("='{name}'!A2"));
    set(&mut wb, 2, 0, &format!("=SUM('{name}'!B:B)"));
    set(&mut wb, 3, 0, &format!("=YEAR('{name}'!C2)"));
    assert_eq!(text(&wb, 0, 0), "region");
    assert_eq!(text(&wb, 1, 0), "North");
    assert_eq!(num(&wb, 2, 0), 10.0);
    assert_eq!(num(&wb, 3, 0), 2024.0);

    // Sorting and filtering the table change what the formulas see.
    run(
        &mut wb,
        Action::SortTable {
            table: t.clone(),
            keys: vec![SortKey { col: 1, desc: true }],
        },
    );
    assert_eq!(text(&wb, 1, 0), "East");
    run(
        &mut wb,
        Action::SetFilter {
            target: DataTarget::Table { table: t.clone() },
            col: 0,
            filter: Some(ColumnFilter::Values {
                values: vec!["North".into()],
            }),
        },
    );
    assert_eq!(num(&wb, 2, 0), 4.0);
    assert_eq!(text(&wb, 1, 0), "North");
    run(&mut wb, Action::Undo);
    assert_eq!(num(&wb, 2, 0), 10.0);

    // A pivot on this sheet at E1: region | Sum of units, with a grand total.
    run(
        &mut wb,
        Action::CreatePivot {
            spec: PivotSpec {
                id: String::new(),
                sheet: S,
                row: 0,
                col: 4,
                source: DataTarget::Table { table: t.clone() },
                rows: vec![PivotField {
                    field: "region".into(),
                    group: None,
                }],
                columns: vec![],
                values: vec![PivotValue {
                    field: "units".into(),
                    agg: Agg::Sum,
                    percentile: None,
                }],
                filters: vec![],
                totals: true,
            },
            new_sheet: false,
        },
    );
    set(&mut wb, 5, 0, "=SUM(F2:F4)");
    set(&mut wb, 6, 0, "=VLOOKUP(\"North\",E2:F4,2,FALSE)");
    assert_eq!(num(&wb, 5, 0), 10.0);
    assert_eq!(num(&wb, 6, 0), 4.0);

    // Rows inserted above everything move formulas, the pivot and the mirror together.
    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 0,
            count: 2,
        },
    );
    assert_eq!(num(&wb, 8, 0), 4.0);
    assert_eq!(num(&wb, 7, 0), 10.0);
    // Mirrored cells are not ordinary cells: they never show up in find.
    assert!(matches!(
        reply(run(
            &mut wb,
            Action::Find {
                sheet: S,
                row: 0,
                col: 0,
                text: "South".into()
            }
        )),
        Reply::NotFound
    ));
    run(&mut wb, Action::Undo);
    assert_eq!(num(&wb, 6, 0), 4.0);

    // Snapshots leave mirrored cells out; loading rebuilds them.
    let snap = wb.to_snapshot();
    let bare = ironcalc_base::UserModel::from_bytes(&snap.data, "en").unwrap();
    assert_eq!(bare.get_cell_content(S, 2, 6).unwrap(), "");
    assert_eq!(num(&wb, 6, 0), 4.0);
    let restored = Workbook::from_snapshot(
        &snap.data,
        Some(&snap.tables),
        wb.seq,
        wb.dir().to_path_buf(),
    )
    .unwrap();
    assert_eq!(num(&restored, 6, 0), 4.0);
    assert_eq!(num(&restored, 2, 0), 10.0);
    assert_eq!(restored.tile(S, 0, 0).unwrap(), wb.tile(S, 0, 0).unwrap());

    // Deleting the pivot turns its references blank again.
    let pid = wb.tables().manifest().pivots[0].id.clone();
    run(&mut wb, Action::DeleteObject { id: pid });
    assert_eq!(num(&wb, 5, 0), 0.0);
}

#[test]
fn icon_sets_mark_high_middle_and_low_values() {
    use protocol::{CondRule, CondStyle, IconSetKind};
    let mut wb = Workbook::new_empty();
    for v in 0..10 {
        set(&mut wb, v, 0, &(v * 10).to_string());
        set(&mut wb, v, 1, &(v * 10).to_string());
    }
    for (col, reverse) in [(0, false), (1, true)] {
        run(
            &mut wb,
            Action::AddCondFormat {
                range: Range {
                    sheet: S,
                    r0: 0,
                    c0: col,
                    r1: 9,
                    c1: col,
                },
                rule: CondRule::IconSet {
                    set: IconSetKind::Arrows,
                    reverse,
                },
                style: CondStyle::default(),
            },
        );
    }
    let tile = wb.tile(S, 0, 0).unwrap();
    let icon = |row: u32, col: u32| {
        let c = tile
            .cells
            .iter()
            .find(|c| c.0 == row * TILE_COLS + col)
            .unwrap();
        tile.styles[c.3 as usize].icon.clone().map(|(name, _)| name)
    };
    assert_eq!(icon(9, 0).as_deref(), Some("up"));
    assert_eq!(icon(5, 0).as_deref(), Some("right"));
    assert_eq!(icon(0, 0).as_deref(), Some("down"));
    assert_eq!(icon(9, 1).as_deref(), Some("down"));
    assert_eq!(icon(0, 1).as_deref(), Some("up"));
    assert_eq!(
        tile.styles[tile.cells.iter().find(|c| c.0 == 9 * TILE_COLS).unwrap().3 as usize]
            .icon
            .as_ref()
            .unwrap()
            .1,
        "#1E8E3E"
    );
}

#[test]
fn pivot_drill_down_lists_the_rows_behind_a_cell() {
    let mut wb = Workbook::new_empty();
    run(
        &mut wb,
        Action::PasteText {
            sheet: S,
            row: 0,
            col: 0,
            text: "region\tproduct\tunits\nNorth\tA\t1\nSouth\tA\t2\nNorth\tB\t3\nEast\tA\t4\nSouth\tB\t5\nNorth\tA\t6".into(),
        },
    );
    let source = DataTarget::Range {
        range: Range {
            sheet: S,
            r0: 0,
            c0: 0,
            r1: 6,
            c1: 2,
        },
    };
    // Pivot at E1: region down, product across. Rows: header, East, North, South, Grand Total.
    run(
        &mut wb,
        Action::CreatePivot {
            spec: PivotSpec {
                id: String::new(),
                sheet: S,
                row: 0,
                col: 4,
                source,
                rows: vec![PivotField {
                    field: "region".into(),
                    group: None,
                }],
                columns: vec![PivotField {
                    field: "product".into(),
                    group: None,
                }],
                values: vec![PivotValue {
                    field: "units".into(),
                    agg: Agg::Sum,
                    percentile: None,
                }],
                filters: vec![],
                totals: true,
            },
            new_sheet: false,
        },
    );
    assert_eq!(wb.value_at(S, 2, 5).0, "7"); // North x A
    let drill = |wb: &mut Workbook, row: u32, col: u32| -> (u32, Vec<Vec<String>>) {
        let sheet = match reply(run(wb, Action::DrillDown { sheet: S, row, col })) {
            Reply::Created { sheet, .. } => sheet,
            other => panic!("{other:?}"),
        };
        let rows = wb.sheet_meta(sheet).unwrap().tables[0].rows;
        let grid = (0..=rows as u32)
            .map(|r| (0..3).map(|c| wb.value_at(sheet, r as u64, c).0).collect())
            .collect();
        (sheet, grid)
    };
    let (sheet, north_a) = drill(&mut wb, 2, 5);
    assert_eq!(wb.sheets()[sheet as usize].name, "Details");
    assert_eq!(
        north_a,
        vec![
            vec!["region", "product", "units"],
            vec!["North", "A", "1"],
            vec!["North", "A", "6"],
        ]
    );
    // The North row total ignores the product; the grand total takes every row.
    assert_eq!(drill(&mut wb, 2, 7).1.len(), 4);
    assert_eq!(drill(&mut wb, 4, 7).1.len(), 7);
    assert!(wb
        .execute(
            &Action::DrillDown {
                sheet: S,
                row: 0,
                col: 4
            },
            &mut None
        )
        .is_err());
    // Undo removes the details sheet and its table.
    let sheets = wb.sheets().len();
    run(&mut wb, Action::Undo);
    assert_eq!(wb.sheets().len(), sheets - 1);
    assert_eq!(wb.tables().manifest().tables.len(), 2);
}
