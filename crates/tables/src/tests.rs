use super::*;

fn orders() -> DataFrame {
    df!(
        "id" => [1i64, 2, 3, 4, 5],
        "region" => ["North", "South", "North", "East", "South"],
        "units" => [10i64, 30, 5, 30, 1],
        "price" => [2.0, 1.5, 4.0, 1.0, 9.5],
        "note" => [Some("a"), None, Some("b"), Some(""), Some("c")],
    )
    .unwrap()
}

fn store() -> (tempfile::TempDir, TableStore, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut s = TableStore::new(dir.path().join("tables"));
    let id = s
        .import(orders(), "orders", "orders.csv", 0, 0, 0, None)
        .unwrap();
    (dir, s, id)
}

fn column_values(s: &TableStore, id: &str, name: &str) -> Vec<String> {
    let live = s.live(id).unwrap();
    let c = live.view.column(name).unwrap();
    (0..c.len()).map(|i| display(&c.get(i).unwrap())).collect()
}

#[test]
fn sort_filter_and_view_geometry() {
    let (_d, mut s, id) = store();
    s.update(&id, |t| {
        t.sort = vec![
            SortKey { col: 2, desc: true },
            SortKey {
                col: 0,
                desc: false,
            },
        ];
        Ok(())
    })
    .unwrap();
    assert_eq!(column_values(&s, &id, "id"), ["2", "4", "1", "3", "5"]);

    s.update(&id, |t| {
        t.columns[1].filter = Some(ColumnFilter::Values {
            values: vec!["South".into(), "East".into()],
        });
        Ok(())
    })
    .unwrap();
    assert_eq!(column_values(&s, &id, "id"), ["2", "4", "5"]);
    assert_eq!(s.row_extent(0), 4);
    let info = &s.info(0)[0];
    assert_eq!((info.rows, info.total_rows), (3, 5));
    assert_eq!(info.columns[2].sort, Some(true));

    s.update(&id, |t| {
        t.columns[3].filter = Some(ColumnFilter::Condition {
            op: FilterOp::Gt,
            value: "1.2".into(),
        });
        Ok(())
    })
    .unwrap();
    assert_eq!(column_values(&s, &id, "id"), ["2", "5"]);

    // Blank matches null and empty text.
    s.update(&id, |t| {
        t.columns[1].filter = None;
        t.columns[3].filter = None;
        t.columns[4].filter = Some(ColumnFilter::Condition {
            op: FilterOp::Blank,
            value: String::new(),
        });
        Ok(())
    })
    .unwrap();
    assert_eq!(column_values(&s, &id, "id"), ["2", "4"]);
}

#[test]
fn computed_columns_chain_and_errors_roll_back() {
    let (_d, mut s, id) = store();
    s.update(&id, |t| {
        t.columns.push(ColumnSpec {
            name: "total".into(),
            expr: Some("=[units] * [price]".into()),
            hidden: false,
            filter: None,
        });
        t.columns.push(ColumnSpec {
            name: "big".into(),
            expr: Some("=IF(total >= 30, \"yes\", \"no\")".into()),
            hidden: false,
            filter: None,
        });
        Ok(())
    })
    .unwrap();
    assert_eq!(
        column_values(&s, &id, "total"),
        ["20", "45", "20", "30", "9.5"]
    );
    assert_eq!(
        column_values(&s, &id, "big"),
        ["no", "yes", "no", "yes", "no"]
    );

    let bad = s.update(&id, |t| {
        t.columns[5].expr = Some("=[nope] + 1".into());
        Ok(())
    });
    assert!(bad.unwrap_err().contains("nope"));
    // The failed edit left the previous state in place.
    assert_eq!(
        column_values(&s, &id, "total"),
        ["20", "45", "20", "30", "9.5"]
    );
    assert_eq!(
        s.manifest().tables[0].columns[5].expr.as_deref(),
        Some("=[units] * [price]")
    );
}

#[test]
fn tiles_show_header_and_visible_columns() {
    let (_d, mut s, id) = store();
    s.update(&id, |t| {
        t.columns[1].hidden = true;
        t.sort = vec![SortKey { col: 0, desc: true }];
        Ok(())
    })
    .unwrap();
    let cells = s.tile_cells(0, 0, 63, 0, 15);
    let header: Vec<&str> = cells
        .iter()
        .filter(|c| c.0 == 0)
        .map(|c| c.2.as_str())
        .collect();
    assert_eq!(header, ["id", "units", "price", "note"]);
    let sorted_header = cells.iter().find(|c| c.0 == 0 && c.1 == 0).unwrap();
    assert_eq!(
        sorted_header.3,
        kind::HEADER_BUTTON | kind::SORTED | kind::SORT_DESC
    );
    // First data row is the highest id; nulls are skipped.
    let row1: Vec<&str> = cells
        .iter()
        .filter(|c| c.0 == 1)
        .map(|c| c.2.as_str())
        .collect();
    assert_eq!(row1, ["5", "1", "9.5", "c"]);
    assert_eq!(s.cell_text(0, 1, 2).as_deref(), Some("9.5"));
    assert!(s.table_at(0, 5, 3).is_some());
    assert!(s.table_at(0, 6, 0).is_none());
    assert!(s.table_at(0, 1, 4).is_none());

    let st = s.stats(0, 1, 5, 1, 1);
    assert_eq!(
        (st.count, st.numbers, st.sum, st.min, st.max),
        (5, 5, 76.0, Some(1.0), Some(30.0))
    );
}

#[test]
fn distinct_values_sorted_with_counts() {
    let (_d, s, id) = store();
    let (vals, total) = s.distinct(&id, 1, None, 100).unwrap();
    assert_eq!(total, 3);
    assert_eq!(
        vals,
        [
            ("East".to_string(), 1),
            ("North".into(), 2),
            ("South".into(), 2)
        ]
    );
    let (vals, _) = s.distinct(&id, 2, None, 100).unwrap();
    assert_eq!(
        vals.iter().map(|v| v.0.as_str()).collect::<Vec<_>>(),
        ["1", "5", "10", "30"]
    );
    let (vals, _) = s.distinct(&id, 1, Some("th"), 100).unwrap();
    assert_eq!(vals.len(), 2);
}

#[test]
fn manifest_round_trip_and_reimport() {
    let (d, mut s, id) = store();
    s.update(&id, |t| {
        t.columns.push(ColumnSpec {
            name: "total".into(),
            expr: Some("=[units] * [price]".into()),
            hidden: false,
            filter: None,
        });
        t.columns[1].filter = Some(ColumnFilter::Values {
            values: vec!["North".into()],
        });
        Ok(())
    })
    .unwrap();
    let json = s.manifest_json();
    let mut again = TableStore::new(d.path().join("tables"));
    again.set_manifest_json(&json).unwrap();
    assert_eq!(column_values(&again, &id, "total"), ["20", "20"]);

    // New source data at the same table: computed column and filter apply to it.
    let newer = df!(
        "id" => [7i64, 8],
        "region" => ["North", "West"],
        "units" => [3i64, 4],
        "price" => [10.0, 1.0],
        "note" => ["x", "y"],
    )
    .unwrap();
    s.import(newer, "orders", "orders2.csv", 0, 0, 0, Some(&id))
        .unwrap();
    assert_eq!(column_values(&s, &id, "total"), ["30"]);
    assert_eq!(s.info(0)[0].total_rows, 2);

    // Restoring the old manifest (undo) brings back the old file.
    s.set_manifest_json(&json).unwrap();
    assert_eq!(column_values(&s, &id, "id"), ["1", "3"]);
}

#[test]
fn remove_duplicates_writes_new_version() {
    let (_d, mut s, id) = store();
    let file = s.spec(&id).unwrap().file.clone();
    assert_eq!(s.remove_duplicates(&id, &[1]).unwrap(), 2);
    assert_eq!(column_values(&s, &id, "region"), ["North", "South", "East"]);
    assert_ne!(s.spec(&id).unwrap().file, file);
    assert_eq!(s.remove_duplicates(&id, &[]).unwrap(), 0);
    let rows = s.view_rows(&id, 100).unwrap();
    assert_eq!(rows[0], ["id", "region", "units", "price", "note"]);
    assert_eq!(rows.len(), 4);
    assert!(s.view_rows(&id, 10).is_err());
}

mod pivots {
    use super::*;
    use crate::pivot::compute;
    use protocol::{Agg, DataTarget, DateGroup, PivotField, PivotSpec, PivotValue};

    fn sales() -> DataFrame {
        df!(
            "region" => ["North", "South", "North", "East", "South", "North"],
            "product" => ["A", "A", "B", "A", "B", "A"],
            "units" => [1i64, 2, 3, 4, 5, 6],
            "price" => [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
            "day" => ["2025-01-05", "2025-01-20", "2025-02-01", "2025-02-11", "2025-03-03", "2025-03-30"],
        )
        .unwrap()
        .lazy()
        .with_column(col("day").str().to_date(StrptimeOptions::default()))
        .collect()
        .unwrap()
    }

    fn field(f: &str) -> PivotField {
        PivotField {
            field: f.into(),
            group: None,
        }
    }

    fn value(f: &str, agg: Agg) -> PivotValue {
        PivotValue {
            field: f.into(),
            agg,
            percentile: None,
        }
    }

    fn spec(rows: Vec<PivotField>, columns: Vec<PivotField>, values: Vec<PivotValue>) -> PivotSpec {
        PivotSpec {
            id: "p1".into(),
            sheet: 0,
            row: 0,
            col: 0,
            source: DataTarget::Table { table: "t".into() },
            rows,
            columns,
            values,
            filters: vec![],
            totals: true,
            collapsed: vec![],
        }
    }

    fn grid_text(g: &crate::pivot::PivotGrid) -> Vec<Vec<String>> {
        g.cells
            .iter()
            .map(|r| {
                r.iter()
                    .map(|c| c.as_ref().map(|c| c.text.clone()).unwrap_or_default())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn rows_with_sum_and_grand_total() {
        let g = compute(
            &sales(),
            &spec(
                vec![field("region")],
                vec![],
                vec![value("units", Agg::Sum), value("price", Agg::Avg)],
            ),
        )
        .unwrap();
        assert_eq!(
            grid_text(&g),
            [
                vec!["region", "Sum of units", "Average of price"],
                vec!["East", "4", "40"],
                vec!["North", "10", "33.3333333333"],
                vec!["South", "7", "35"],
                vec!["Grand Total", "21", "35"],
            ]
        );
        assert_eq!(g.total_row, Some(4));
        assert_eq!(g.get(1, 1).unwrap().num, Some(4.0));
    }

    #[test]
    fn columns_spread_with_row_totals() {
        let g = compute(
            &sales(),
            &spec(
                vec![field("region")],
                vec![field("product")],
                vec![value("units", Agg::Sum)],
            ),
        )
        .unwrap();
        assert_eq!(
            grid_text(&g),
            [
                vec!["region", "A", "B", "Total"],
                vec!["East", "4", "", "4"],
                vec!["North", "7", "3", "10"],
                vec!["South", "2", "5", "7"],
                vec!["Grand Total", "13", "8", "21"],
            ]
        );
    }

    #[test]
    fn date_groups_unique_percentile_and_filters() {
        let mut s = spec(
            vec![PivotField {
                field: "day".into(),
                group: Some(DateGroup::Month),
            }],
            vec![],
            vec![value("region", Agg::CountUnique)],
        );
        let g = compute(&sales(), &s).unwrap();
        assert_eq!(grid_text(&g)[0], ["day (month)", "Unique of region"]);
        assert_eq!(grid_text(&g)[1], ["2025-01", "2"]);
        s.values = vec![PivotValue {
            field: "price".into(),
            agg: Agg::Percentile,
            percentile: Some(0.5),
        }];
        s.filters = vec![(
            "region".into(),
            ColumnFilter::Values {
                values: vec!["North".into()],
            },
        )];
        s.rows = vec![];
        let g = compute(&sales(), &s).unwrap();
        assert_eq!(grid_text(&g), [vec!["P50 of price"], vec!["30"]]);

        let bad = compute(
            &sales(),
            &spec(
                vec![field("region")],
                vec![],
                vec![value("product", Agg::Sum)],
            ),
        );
        assert!(bad.unwrap_err().contains("not numeric"));
        let missing = compute(&sales(), &spec(vec![field("nope")], vec![], vec![]));
        assert!(missing.unwrap_err().contains("nope"));
    }
}
