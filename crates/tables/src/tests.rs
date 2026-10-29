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
