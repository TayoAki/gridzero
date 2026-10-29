//! M3: pivots, charts, slicers, validation, conditional formats, reference shifting.

use super::*;
use protocol::{
    Agg, Axis, ChartKind, ChartSeries, ChartSpec, ColumnFilter, CondOp, CondRule, CondStyle,
    DataTarget, ImportDest, ImportMode, ImportOptions, PivotField, PivotSpec, PivotValue,
    SlicerSpec, ValidationSpec,
};

fn r(sheet: u32, r0: u32, c0: u32, r1: u32, c1: u32) -> Range {
    Range {
        sheet,
        r0,
        c0,
        r1,
        c1,
    }
}

/// region | product | units in A1:C7.
fn sales(wb: &mut Workbook) {
    run(
        wb,
        Action::PasteText {
            sheet: S,
            row: 0,
            col: 0,
            text: "region\tproduct\tunits\nNorth\tA\t1\nSouth\tA\t2\nNorth\tB\t3\nEast\tA\t4\nSouth\tB\t5\nNorth\tA\t6".into(),
        },
    );
}

fn pivot_spec(source: DataTarget) -> PivotSpec {
    PivotSpec {
        id: String::new(),
        sheet: S,
        row: 0,
        col: 0,
        source,
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
    }
}

fn created(o: Outcome) -> (String, u32) {
    match reply(o) {
        Reply::Created { id, sheet } => (id, sheet),
        other => panic!("{other:?}"),
    }
}

fn grid(wb: &Workbook, sheet: u32, row0: u32, col0: u32, rows: u32, cols: u32) -> Vec<Vec<String>> {
    (row0..row0 + rows)
        .map(|r| {
            (col0..col0 + cols)
                .map(|c| wb.value_at(sheet, r as u64, c).0)
                .collect()
        })
        .collect()
}

fn chart(wb: &mut Workbook, id: &str) -> protocol::ChartData {
    match reply(run(wb, Action::GetChart { id: id.into() })) {
        Reply::Chart { data } => data,
        other => panic!("{other:?}"),
    }
}

#[test]
fn pivot_over_cells_recomputes_on_edit_and_undoes_with_its_sheet() {
    let mut wb = Workbook::new_empty();
    sales(&mut wb);
    let (id, sheet) = created(run(
        &mut wb,
        Action::CreatePivot {
            spec: pivot_spec(DataTarget::Range {
                range: r(S, 0, 0, 6, 2),
            }),
            new_sheet: true,
        },
    ));
    assert_eq!(sheet, 1);
    assert_eq!(wb.sheets()[1].name, "Pivot");
    assert_eq!(
        grid(&wb, 1, 0, 0, 5, 2),
        [
            ["region", "Sum of units"],
            ["East", "4"],
            ["North", "10"],
            ["South", "7"],
            ["Grand Total", "21"]
        ]
    );
    let meta = wb.sheet_meta(1).unwrap();
    assert_eq!((meta.pivots[0].rows, meta.pivots[0].cols), (5, 2));
    assert_eq!(meta.pivots[0].fields.len(), 3);
    // Header styling and pivot cells come through tiles.
    let tile = wb.tile(1, 0, 0).unwrap();
    assert!(tile.cells.iter().any(|c| c.1 == "Grand Total"));

    // Editing the source updates the pivot on the next read.
    set(&mut wb, 1, 2, "100");
    assert_eq!(wb.value_at(1, 2, 1).0, "109");
    // Pivot cells are read-only.
    let mut clip = None;
    assert!(wb
        .execute(
            &Action::UpdateCell {
                sheet: 1,
                row: 1,
                col: 1,
                raw: "x".into()
            },
            &mut clip
        )
        .is_err());

    // Undo the edit, then the pivot (and its sheet) in one step.
    run(&mut wb, Action::Undo);
    run(&mut wb, Action::Undo);
    assert_eq!(wb.sheets().len(), 1);
    assert!(wb.tables().manifest().pivots.is_empty());
    let _ = id;
}

#[test]
fn one_slicer_filters_two_pivots_and_a_chart() {
    let mut wb = Workbook::new_empty();
    let dir = wb.dir().join("staging");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("i1.sales.csv"),
        "region,product,units\nNorth,A,1\nSouth,A,2\nNorth,B,3\nEast,A,4\nSouth,B,5\nNorth,A,6\n",
    )
    .unwrap();
    let t = match reply(run(
        &mut wb,
        Action::FinalizeImport {
            import_id: "i1".into(),
            options: ImportOptions::default(),
            dest: ImportDest::NewSheet,
            mode: ImportMode::Table,
            name: "sales".into(),
        },
    )) {
        Reply::Imported { table, .. } => table.unwrap(),
        other => panic!("{other:?}"),
    };
    let source = DataTarget::Table { table: t.clone() };
    let mut by_region = pivot_spec(source.clone());
    by_region.col = 1;
    created(run(
        &mut wb,
        Action::CreatePivot {
            spec: by_region,
            new_sheet: false,
        },
    ));
    let mut by_product = pivot_spec(source.clone());
    by_product.col = 5;
    by_product.rows = vec![PivotField {
        field: "product".into(),
        group: None,
    }];
    created(run(
        &mut wb,
        Action::CreatePivot {
            spec: by_product,
            new_sheet: false,
        },
    ));
    // Chart over the first pivot's values (B2:C4: region labels and sums, no total row).
    let (cid, _) = created(run(
        &mut wb,
        Action::CreateChart {
            spec: ChartSpec {
                id: String::new(),
                sheet: S,
                row: 10,
                col: 1,
                w: 400,
                h: 300,
                kind: ChartKind::Column,
                title: "Units by region".into(),
                x: Some(r(S, 1, 1, 3, 1)),
                series: vec![ChartSeries {
                    range: Some(r(S, 1, 2, 3, 2)),
                    name: Some("Units".into()),
                    kind: None,
                    axis: Axis::Left,
                }],
                bins: None,
                stacked: false,
            },
        },
    ));
    let data = chart(&mut wb, &cid);
    assert_eq!(data.x, ["East", "North", "South"]);
    assert_eq!(data.series[0].values, [Some(4.0), Some(10.0), Some(7.0)]);
    assert_eq!(data.refs[1], "='Sheet1'!C2:C4");

    let (sid, _) = created(run(
        &mut wb,
        Action::CreateSlicer {
            spec: SlicerSpec {
                id: String::new(),
                sheet: S,
                row: 20,
                col: 1,
                target: source.clone(),
                column: 1,
                title: "product".into(),
            },
        },
    ));
    // The slicer's selection is the table's column filter.
    run(
        &mut wb,
        Action::SetFilter {
            target: source.clone(),
            col: 1,
            filter: Some(ColumnFilter::Values {
                values: vec!["A".into()],
            }),
        },
    );
    assert_eq!(
        grid(&wb, S, 0, 1, 4, 2),
        [
            ["region", "Sum of units"],
            ["East", "4"],
            ["North", "7"],
            ["South", "2"]
        ]
    );
    assert_eq!(
        grid(&wb, S, 0, 5, 3, 2),
        [
            ["product", "Sum of units"],
            ["A", "13"],
            ["Grand Total", "13"]
        ]
    );
    let data = chart(&mut wb, &cid);
    assert_eq!(data.series[0].values, [Some(4.0), Some(7.0), Some(2.0)]);
    let info = &wb.sheet_meta(S).unwrap().slicers[0];
    assert_eq!(
        (info.spec.id.as_str(), info.column_name.as_str()),
        (sid.as_str(), "product")
    );
    assert_eq!(
        info.filter,
        Some(ColumnFilter::Values {
            values: vec!["A".into()]
        })
    );
    run(&mut wb, Action::DeleteObject { id: sid });
    assert!(wb.sheet_meta(S).unwrap().slicers.is_empty());
}

#[test]
fn chart_references_follow_inserted_and_deleted_rows() {
    let mut wb = Workbook::new_empty();
    sales(&mut wb);
    let (cid, _) = created(run(
        &mut wb,
        Action::CreateChart {
            spec: ChartSpec {
                id: String::new(),
                sheet: S,
                row: 1,
                col: 5,
                w: 400,
                h: 300,
                kind: ChartKind::Line,
                title: String::new(),
                x: Some(r(S, 1, 0, 6, 0)),
                series: vec![ChartSeries {
                    range: Some(r(S, 1, 2, 6, 2)),
                    name: None,
                    kind: None,
                    axis: Axis::Left,
                }],
                bins: None,
                stacked: false,
            },
        },
    ));
    let before = chart(&mut wb, &cid).series[0].values.clone();
    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 0,
            count: 2,
        },
    );
    let after = chart(&mut wb, &cid);
    assert_eq!(after.series[0].values, before);
    assert_eq!(after.refs[1], "='Sheet1'!C4:C9");
    // A row inserted inside the series makes it one longer.
    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 5,
            count: 1,
        },
    );
    assert_eq!(chart(&mut wb, &cid).series[0].values.len(), 7);
    run(
        &mut wb,
        Action::DeleteRows {
            sheet: S,
            row: 5,
            count: 1,
        },
    );
    assert_eq!(chart(&mut wb, &cid).series[0].values, before);
    // Deleting all of its rows leaves #REF!.
    run(
        &mut wb,
        Action::DeleteRows {
            sheet: S,
            row: 3,
            count: 6,
        },
    );
    let gone = chart(&mut wb, &cid);
    assert_eq!(gone.refs[1], "#REF!");
    assert!(!gone.errors.is_empty());
    // The chart anchor moved with the rows above it.
    assert_eq!(wb.sheet_meta(S).unwrap().charts[0].row, 3);
}

#[test]
fn histogram_buckets_and_hidden_rows_are_skipped() {
    let mut wb = Workbook::new_empty();
    let text: String = std::iter::once("v".to_string())
        .chain((1..=20).map(|i| i.to_string()))
        .collect::<Vec<_>>()
        .join("\n");
    run(
        &mut wb,
        Action::PasteText {
            sheet: S,
            row: 0,
            col: 0,
            text,
        },
    );
    let (cid, _) = created(run(
        &mut wb,
        Action::CreateChart {
            spec: ChartSpec {
                id: String::new(),
                sheet: S,
                row: 0,
                col: 3,
                w: 400,
                h: 300,
                kind: ChartKind::Histogram,
                title: String::new(),
                x: None,
                series: vec![ChartSeries {
                    range: Some(r(S, 1, 0, 20, 0)),
                    name: None,
                    kind: None,
                    axis: Axis::Left,
                }],
                bins: Some(4),
                stacked: false,
            },
        },
    ));
    let d = chart(&mut wb, &cid);
    assert_eq!(d.x.len(), 4);
    assert_eq!(d.series[0].values.iter().flatten().sum::<f64>(), 20.0);
    // Filtering the range hides rows; charts leave them out like Excel does.
    run(
        &mut wb,
        Action::SetFilter {
            target: DataTarget::Range {
                range: r(S, 0, 0, 20, 0),
            },
            col: 0,
            filter: Some(ColumnFilter::Condition {
                op: protocol::FilterOp::Le,
                value: "10".into(),
            }),
        },
    );
    assert_eq!(
        chart(&mut wb, &cid).series[0]
            .values
            .iter()
            .flatten()
            .sum::<f64>(),
        10.0
    );
}

#[test]
fn tables_and_pivots_move_with_rows_above_but_cannot_be_split() {
    let mut wb = Workbook::new_empty();
    sales(&mut wb);
    let mut spec = pivot_spec(DataTarget::Range {
        range: r(S, 0, 0, 6, 2),
    });
    spec.row = 10;
    created(run(
        &mut wb,
        Action::CreatePivot {
            spec,
            new_sheet: false,
        },
    ));
    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 8,
            count: 2,
        },
    );
    let p = &wb.sheet_meta(S).unwrap().pivots[0];
    assert_eq!(p.spec.row, 12);
    // The source range grew with an insert inside it.
    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 3,
            count: 1,
        },
    );
    let p = wb.sheet_meta(S).unwrap().pivots[0].clone();
    assert_eq!(
        p.spec.source,
        DataTarget::Range {
            range: r(S, 0, 0, 7, 2)
        }
    );
    let mut clip = None;
    let split = wb.execute(
        &Action::InsertRows {
            sheet: S,
            row: p.spec.row + 2,
            count: 1,
        },
        &mut clip,
    );
    assert!(split.is_err());
}

#[test]
fn dropdown_validation_rejects_other_values() {
    let mut wb = Workbook::new_empty();
    set(&mut wb, 0, 5, "Open");
    set(&mut wb, 1, 5, "Closed");
    created(run(
        &mut wb,
        Action::SetValidation {
            spec: ValidationSpec {
                id: String::new(),
                range: r(S, 0, 0, 9, 0),
                values: vec!["Pending".into()],
                source: Some(r(S, 0, 5, 3, 5)),
                strict: true,
            },
        },
    ));
    let choices = reply(run(
        &mut wb,
        Action::GetChoices {
            sheet: S,
            row: 3,
            col: 0,
        },
    ));
    assert_eq!(
        choices,
        Reply::Choices {
            values: vec!["Pending".into(), "Open".into(), "Closed".into()],
            strict: true
        }
    );
    set(&mut wb, 3, 0, "open");
    let mut clip = None;
    let err = wb
        .execute(
            &Action::UpdateCell {
                sheet: S,
                row: 3,
                col: 0,
                raw: "Maybe".into(),
            },
            &mut clip,
        )
        .err()
        .unwrap();
    assert!(err.to_string().contains("Pending"));
    let tile = wb.tile(S, 0, 0).unwrap();
    assert!(tile
        .cells
        .iter()
        .any(|c| c.0 == 5 * TILE_COLS && c.2 & kind::DROPDOWN != 0));
    // Outside the range anything goes.
    set(&mut wb, 3, 1, "Maybe");
}

#[test]
fn conditional_formats_color_cells_and_shift_with_rows() {
    let mut wb = Workbook::new_empty();
    for (i, v) in [5, 15, 25].iter().enumerate() {
        set(&mut wb, i as u32, 0, &v.to_string());
        set(&mut wb, i as u32, 1, &v.to_string());
    }
    run(
        &mut wb,
        Action::AddCondFormat {
            range: r(S, 0, 0, 2, 0),
            rule: CondRule::CellIs {
                op: CondOp::Gt,
                value: "10".into(),
                value2: None,
            },
            style: CondStyle {
                fill: Some("#FCE8E6".into()),
                color: None,
                bold: true,
            },
        },
    );
    run(
        &mut wb,
        Action::AddCondFormat {
            range: r(S, 0, 1, 2, 1),
            rule: CondRule::DataBar {
                color: "#638EC6".into(),
            },
            style: CondStyle::default(),
        },
    );
    let style_of = |wb: &Workbook, row: u32, col: u32| {
        let tile = wb.tile(S, 0, 0).unwrap();
        let c = tile
            .cells
            .iter()
            .find(|c| c.0 == row * TILE_COLS + col)
            .unwrap();
        tile.styles[c.3 as usize].clone()
    };
    assert_eq!(style_of(&wb, 0, 0).fill, None);
    assert_eq!(style_of(&wb, 1, 0).fill.as_deref(), Some("#FCE8E6"));
    assert_eq!(style_of(&wb, 1, 0).font & font::BOLD, font::BOLD);
    assert!(style_of(&wb, 2, 1).bar.unwrap().0 > style_of(&wb, 0, 1).bar.unwrap().0);
    let list = reply(run(&mut wb, Action::ListCondFormats { sheet: S }));
    let Reply::CondFormats { list } = list else {
        panic!()
    };
    assert_eq!(list.len(), 2);
    // IronCalc shifts the rule's range with inserted rows.
    run(
        &mut wb,
        Action::InsertRows {
            sheet: S,
            row: 0,
            count: 1,
        },
    );
    assert_eq!(style_of(&wb, 2, 0).fill.as_deref(), Some("#FCE8E6"));
    run(&mut wb, Action::Undo);
    run(
        &mut wb,
        Action::DeleteCondFormat {
            sheet: S,
            index: list.iter().find(|c| c.summary == "CellIs").unwrap().index,
        },
    );
    assert_eq!(style_of(&wb, 1, 0).fill, None);
}
