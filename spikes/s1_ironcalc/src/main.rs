//! Spike S1: decide whether IronCalc can be GridZero's cell engine (BUILD-SPEC §11, M0).
//!
//! Gates:
//!   golden  - >= 90% of tests/golden/s1_formulas.json match
//!   bench   - recalc of 1M formula cells <= 1.5 s
//!   serde   - workbook round-trips through a MessagePack snapshot envelope
//!
//! Usage: cargo run --release -p s1_ironcalc -- [golden|bench|serde|all]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ironcalc_base::cell::CellValue;
use ironcalc_base::types::CellType;
use ironcalc_base::Model;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const SHEET: u32 = 0;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn new_model() -> Model<'static> {
    Model::new_empty("s1", "en", "UTC", "en").expect("new_empty")
}

/// "Z1" -> (row 1, column 26). IronCalc rows and columns are 1-based.
fn parse_a1(cell: &str) -> (i32, i32) {
    let split = cell.find(|c: char| c.is_ascii_digit()).expect("row digits");
    let (letters, digits) = cell.split_at(split);
    let col = letters
        .bytes()
        .fold(0i32, |acc, b| acc * 26 + (b.to_ascii_uppercase() - b'A' + 1) as i32);
    (digits.parse().expect("row"), col)
}

fn fixture_input(v: &Value) -> String {
    match v {
        Value::Bool(true) => "TRUE".into(),
        Value::Bool(false) => "FALSE".into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => panic!("unsupported fixture value {other}"),
    }
}

// ---------------------------------------------------------------- golden

#[derive(Deserialize)]
struct GoldenDoc {
    fixture: BTreeMap<String, Value>,
    formula_cell: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    category: String,
    formula: String,
    expect: Expect,
    #[serde(default)]
    spill: Vec<SpillExpect>,
}

#[derive(Deserialize)]
struct SpillExpect {
    dr: i32,
    dc: i32,
    expect: Expect,
}

#[derive(Deserialize, Clone)]
struct Expect {
    #[serde(rename = "type")]
    kind: String,
    value: Value,
    #[serde(default)]
    tol: Option<f64>,
}

fn actual_at(model: &Model, row: i32, col: i32) -> Value {
    let kind = model.get_cell_type(SHEET, row, col).unwrap();
    if matches!(kind, CellType::ErrorValue) {
        return json!({"type": "error", "value": model.get_formatted_cell_value(SHEET, row, col).unwrap()});
    }
    match model.get_cell_value_by_index(SHEET, row, col).unwrap() {
        CellValue::Number(n) => json!({"type": "number", "value": n}),
        CellValue::String(s) => json!({"type": "string", "value": s}),
        CellValue::Boolean(b) => json!({"type": "bool", "value": b}),
        CellValue::None => json!({"type": "empty", "value": null}),
    }
}

fn matches(expect: &Expect, actual: &Value) -> bool {
    if actual["type"] != expect.kind.as_str() {
        // A formula returning "" is reported as an empty cell by some engines.
        return expect.kind == "string" && expect.value == "" && actual["type"] == "empty";
    }
    match expect.kind.as_str() {
        "number" => {
            let (e, a) = (expect.value.as_f64().unwrap(), actual["value"].as_f64().unwrap());
            let tol = expect.tol.unwrap_or(1e-9);
            (e - a).abs() <= tol.max(tol * e.abs())
        }
        _ => expect.value == actual["value"],
    }
}

fn run_golden() -> Value {
    let path = repo_root().join("tests/golden/s1_formulas.json");
    let doc: GoldenDoc = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let (frow, fcol) = parse_a1(&doc.formula_cell);
    let mut results = Vec::new();
    let mut by_cat: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    let mut passed = 0u32;

    for case in &doc.cases {
        let mut model = new_model();
        for (cell, v) in &doc.fixture {
            let (r, c) = parse_a1(cell);
            model.set_user_input(SHEET, r, c, fixture_input(v)).unwrap();
        }
        let input = model.set_user_input(SHEET, frow, fcol, case.formula.clone());
        model.evaluate();

        let mut ok = input.is_ok();
        let actual = actual_at(&model, frow, fcol);
        ok &= matches(&case.expect, &actual);
        let mut spill_actuals = Vec::new();
        for s in &case.spill {
            let a = actual_at(&model, frow + s.dr, fcol + s.dc);
            ok &= matches(&s.expect, &a);
            spill_actuals.push(a);
        }

        let entry = by_cat.entry(case.category.clone()).or_default();
        entry.1 += 1;
        if ok {
            passed += 1;
            entry.0 += 1;
        }
        results.push(json!({
            "id": case.id, "category": case.category, "formula": case.formula, "pass": ok,
            "expected": {"type": case.expect.kind, "value": case.expect.value},
            "actual": actual, "spill_actual": spill_actuals,
            "input_error": input.err(),
        }));
    }

    let total = doc.cases.len() as u32;
    let rate = passed as f64 / total as f64;
    println!("\n== golden: {passed}/{total} passed ({:.1}%)  gate >= 90%: {}", rate * 100.0, if rate >= 0.9 { "PASS" } else { "FAIL" });
    for (cat, (p, t)) in &by_cat {
        println!("   {cat:<10} {p:>3}/{t:<3}");
    }
    for r in results.iter().filter(|r| r["pass"] == false) {
        println!("   FAIL {} {:<48} expected {} got {}", r["id"].as_str().unwrap(), r["formula"].as_str().unwrap(), r["expected"], r["actual"]);
    }
    json!({"passed": passed, "total": total, "pass_rate": rate, "gate_pass": rate >= 0.9,
           "by_category": by_cat.iter().map(|(k, (p, t))| (k.clone(), json!({"passed": p, "total": t}))).collect::<serde_json::Map<_, _>>(),
           "cases": results})
}

// ---------------------------------------------------------------- bench

fn secs(t: Instant) -> f64 {
    t.elapsed().as_secs_f64()
}

/// Independent formulas: A{r} = r, B{r} = A{r}*2 for r in 1..=n.
fn bench_independent(n: i32) -> Value {
    let mut model = new_model();
    let t = Instant::now();
    for r in 1..=n {
        model.set_user_input(SHEET, r, 1, r.to_string()).unwrap();
        model.set_user_input(SHEET, r, 2, format!("=A{r}*2")).unwrap();
    }
    let populate = secs(t);
    let t = Instant::now();
    model.evaluate();
    let first_eval = secs(t);
    model.set_user_input(SHEET, 1, 1, "100".into()).unwrap();
    let t = Instant::now();
    model.evaluate();
    let recalc = secs(t);
    assert_eq!(model.get_cell_value_by_index(SHEET, 1, 2).unwrap(), CellValue::Number(200.0));
    assert_eq!(model.get_cell_value_by_index(SHEET, n, 2).unwrap(), CellValue::Number(2.0 * n as f64));
    println!("   independent n={n}: populate {populate:.2}s, first eval {first_eval:.3}s, recalc after edit {recalc:.3}s");
    json!({"scenario": "independent", "formula_cells": n, "populate_s": populate, "first_eval_s": first_eval, "recalc_s": recalc})
}

/// Fan-in: n numbers, n formulas B{r}=A{r}*2, one aggregate =SUM(B1:B{n}).
fn bench_fan_in(n: i32) -> Value {
    let mut model = new_model();
    for r in 1..=n {
        model.set_user_input(SHEET, r, 1, "1".into()).unwrap();
        model.set_user_input(SHEET, r, 2, format!("=A{r}*2")).unwrap();
    }
    model.set_user_input(SHEET, 1, 3, format!("=SUM(B1:B{n})")).unwrap();
    model.evaluate();
    model.set_user_input(SHEET, 1, 1, "2".into()).unwrap();
    let t = Instant::now();
    model.evaluate();
    let recalc = secs(t);
    let total = model.get_cell_value_by_index(SHEET, 1, 3).unwrap();
    assert_eq!(total, CellValue::Number(2.0 * n as f64 + 2.0));
    println!("   fan-in      n={n}: recalc after edit {recalc:.3}s");
    json!({"scenario": "fan_in", "formula_cells": n + 1, "recalc_s": recalc})
}

/// Dependency chain of depth n (D{r} = D{r-1}+1) on an ordinary 2 MiB thread stack,
/// which is what a tokio worker gets. A panic is reported as a failure, not a crash.
const CHAIN_STACK_BYTES: usize = 2 << 20;

fn bench_chain(n: i32) -> Value {
    let handle = std::thread::Builder::new()
        .stack_size(CHAIN_STACK_BYTES)
        .spawn(move || {
            let mut model = new_model();
            model.set_user_input(SHEET, 1, 4, "1".into()).unwrap();
            for r in 2..=n {
                model.set_user_input(SHEET, r, 4, format!("=D{}+1", r - 1)).unwrap();
            }
            let t = Instant::now();
            model.evaluate();
            let first = secs(t);
            let ok = model.get_cell_value_by_index(SHEET, n, 4).unwrap() == CellValue::Number(n as f64);
            (first, ok)
        })
        .unwrap();
    match handle.join() {
        Ok((first, ok)) => {
            println!("   chain       n={n}: eval {first:.3}s correct={ok}");
            json!({"scenario": "chain", "depth": n, "eval_s": first, "correct": ok, "stack_bytes": CHAIN_STACK_BYTES})
        }
        Err(_) => {
            println!("   chain       n={n}: PANICKED (likely stack overflow in recursive evaluation)");
            json!({"scenario": "chain", "depth": n, "panicked": true})
        }
    }
}

fn run_bench() -> Value {
    println!("\n== bench (release build expected)");
    let independent = bench_independent(1_000_000);
    let fan_in = bench_fan_in(1_000_000);
    let chains: Vec<Value> = [10_000, 100_000, 1_000_000].into_iter().map(bench_chain).collect();
    let recalc = independent["recalc_s"].as_f64().unwrap();
    let gate = recalc <= 1.5;
    println!("   gate recalc(1M) <= 1.5s: {}", if gate { "PASS" } else { "FAIL" });
    json!({"independent": independent, "fan_in": fan_in, "chains": chains, "gate_pass": gate})
}

// ---------------------------------------------------------------- serde

/// The snapshot envelope GridZero persists to S3 (BUILD-SPEC §4.3). IronCalc's
/// Workbook is bitcode-encoded, not serde, so the engine state travels as an
/// opaque binary field inside the MessagePack envelope.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    v: u32,
    seq: u64,
    #[serde(with = "serde_bytes")]
    ironcalc: Vec<u8>,
}

fn run_serde() -> Value {
    println!("\n== serde");
    let n = 1_000_000;
    let mut model = new_model();
    for r in 1..=n {
        model.set_user_input(SHEET, r, 1, r.to_string()).unwrap();
        model.set_user_input(SHEET, r, 2, format!("=A{r}*2")).unwrap();
    }
    model.set_user_input(SHEET, 1, 3, format!("=SUM(B1:B{n})")).unwrap();
    model.set_user_input(SHEET, 2, 3, "=XLOOKUP(500000,A:A,B:B)".into()).unwrap();
    model.evaluate();

    let t = Instant::now();
    let snapshot = Snapshot { v: 1, seq: 42, ironcalc: model.to_bytes() };
    let packed = rmp_serde::to_vec_named(&snapshot).unwrap();
    let encode_s = secs(t);

    let t = Instant::now();
    let decoded: Snapshot = rmp_serde::from_slice(&packed).unwrap();
    let mut restored = Model::from_bytes(&decoded.ironcalc, "en").unwrap();
    let decode_s = secs(t);
    restored.evaluate();

    let probes = [(1, 2), (n, 2), (1, 3), (2, 3)];
    let equal = probes.iter().all(|&(r, c)| {
        model.get_cell_value_by_index(SHEET, r, c).unwrap() == restored.get_cell_value_by_index(SHEET, r, c).unwrap()
    }) && decoded.seq == 42;
    let formula_kept = restored.get_cell_formula(SHEET, 2, 3).unwrap();
    println!("   1M-formula workbook: {} bytes msgpack, encode {encode_s:.3}s, decode {decode_s:.3}s, values equal={equal}, formula={formula_kept:?}", packed.len());
    println!("   gate round-trip: {}", if equal { "PASS" } else { "FAIL" });
    json!({"formula_cells": n + 2, "snapshot_bytes": packed.len(), "encode_s": encode_s,
           "decode_s": decode_s, "values_equal": equal, "formula_after_roundtrip": formula_kept, "gate_pass": equal})
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut report = serde_json::Map::new();
    report.insert("ironcalc_base".into(), json!("0.9.1"));
    report.insert("profile".into(), json!(if cfg!(debug_assertions) { "debug" } else { "release" }));
    if matches!(mode.as_str(), "golden" | "all") {
        report.insert("golden".into(), run_golden());
    }
    if matches!(mode.as_str(), "bench" | "all") {
        report.insert("bench".into(), run_bench());
    }
    if matches!(mode.as_str(), "serde" | "all") {
        report.insert("serde".into(), run_serde());
    }
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("results");
    fs::create_dir_all(&out).unwrap();
    let file = out.join(format!("s1_{mode}.json"));
    fs::write(&file, serde_json::to_string_pretty(&Value::Object(report)).unwrap()).unwrap();
    println!("\nwrote {}", file.display());
}
