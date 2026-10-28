//! Spike S3: can Polars turn a 5M-row CSV into a Data Table fast enough?
//! (BUILD-SPEC §11 M0: "5M-row CSV -> Parquet + preview in <= 30 s".)
//!
//! Usage:
//!   cargo run --release -p s3_import -- gen <dir> [rows]   # synthetic CSV + .csv.gz
//!   cargo run --release -p s3_import -- run <dir>          # measure preview, import, parquet, table ops

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use flate2::write::GzEncoder;
use flate2::Compression;
use peak_alloc::PeakAlloc;
use polars::prelude::*;
use serde_json::{json, Value};

#[global_allocator]
static PEAK: PeakAlloc = PeakAlloc;

const REGIONS: [&str; 4] = ["North", "South", "East", "West"];
const PRODUCTS: [&str; 6] = ["Widget", "Gadget", "Gizmo", "Doohickey", "Sprocket", "Thingamajig"];
/// Rows whose notes field contains a quoted newline, to check multi-line records survive parsing.
const MULTILINE_EVERY: u64 = 10_000;

fn csv_path(dir: &Path) -> PathBuf {
    dir.join("orders_5m.csv")
}

fn secs(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 1000.0).round() / 1000.0
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

fn mib(bytes: u64) -> f64 {
    (bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0
}

// ---------------------------------------------------------------- generator

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn generate(dir: &Path, rows: u64) {
    fs::create_dir_all(dir).unwrap();
    let path = csv_path(dir);
    let t = Instant::now();
    let mut w = BufWriter::with_capacity(1 << 20, File::create(&path).unwrap());
    writeln!(w, "order_id,order_date,ship_ts,region,product,customer_email,units,unit_price,discount,revenue,is_returned,notes").unwrap();
    let mut rng = Lcg(42);
    for id in 1..=rows {
        let (m, d) = (rng.below(12) + 1, rng.below(28) + 1);
        let (hh, mm, ss) = (rng.below(24), rng.below(60), rng.below(60));
        let units = rng.below(50) + 1;
        let price_cents = rng.below(12_000) + 500;
        let discount = if rng.below(10) == 0 { String::new() } else { format!("{:.2}", rng.below(30) as f64 / 100.0) };
        let revenue = units as f64 * price_cents as f64 / 100.0;
        let notes = if id % MULTILINE_EVERY == 0 {
            "\"line one\nline two\"".to_string()
        } else if rng.below(4) == 0 {
            format!("\"rush, gift wrap, ref \"\"{}\"\"\"", rng.below(1_000_000))
        } else {
            String::new()
        };
        writeln!(
            w,
            "{id},2025-{m:02}-{d:02},2025-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02},{},{},user{}@example.com,{units},{:.2},{discount},{revenue:.2},{},{notes}",
            REGIONS[rng.below(4) as usize],
            PRODUCTS[rng.below(6) as usize],
            rng.below(250_000),
            price_cents as f64 / 100.0,
            rng.below(20) == 0,
        )
        .unwrap();
    }
    w.flush().unwrap();
    drop(w);
    let csv_bytes = fs::metadata(&path).unwrap().len();
    println!("wrote {} ({} MiB, {rows} rows) in {:.1}s", path.display(), mib(csv_bytes), secs(t));

    let t = Instant::now();
    let gz_path = path.with_extension("csv.gz");
    let mut gz = GzEncoder::new(BufWriter::new(File::create(&gz_path).unwrap()), Compression::new(6));
    std::io::copy(&mut File::open(&path).unwrap(), &mut gz).unwrap();
    gz.finish().unwrap().flush().unwrap();
    println!("wrote {} ({} MiB) in {:.1}s", gz_path.display(), mib(fs::metadata(&gz_path).unwrap().len()), secs(t));
}

// ---------------------------------------------------------------- measurements

fn read_options(n_rows: Option<usize>) -> CsvReadOptions {
    CsvReadOptions::default()
        .with_has_header(true)
        .with_infer_schema_length(Some(10_000))
        .with_n_rows(n_rows)
        .map_parse_options(|p| p.with_try_parse_dates(true))
}

fn read_csv(path: &Path, n_rows: Option<usize>) -> DataFrame {
    read_options(n_rows).try_into_reader_with_file_path(Some(path.to_path_buf())).unwrap().finish().unwrap()
}

fn schema_json(df: &DataFrame) -> Value {
    Value::Object(df.schema().iter().map(|(name, dtype)| (name.to_string(), json!(dtype.to_string()))).collect())
}

fn timed<T>(label: &str, f: impl FnOnce() -> T) -> (T, f64) {
    let t = Instant::now();
    let out = f();
    let s = secs(t);
    println!("   {label:<38} {s:>7.3}s");
    (out, s)
}

fn run(dir: &Path) -> Value {
    let csv = csv_path(dir);
    let gz = csv.with_extension("csv.gz");
    let csv_mib = mib(fs::metadata(&csv).unwrap().len());
    println!("\n== S3 import ({csv_mib} MiB CSV, {} threads)", threads());

    // 1. Preview: what the import dialog shows before the user confirms.
    let (preview, preview_s) = timed("preview (100 rows, infer 10k)", || read_csv(&csv, Some(100)));
    println!("   preview schema: {}", schema_json(&preview));

    // 2. Full parse into memory.
    PEAK.reset_peak_usage();
    let (mut df, parse_s) = timed("full parse CSV -> DataFrame", || read_csv(&csv, None));
    let parse_peak = PEAK.peak_usage();
    let rows = df.height();

    // 3. Persist as the Data Table's Parquet file.
    let parquet = dir.join("orders_5m.parquet");
    let (_, parquet_s) = timed("write Parquet (zstd)", || {
        ParquetWriter::new(File::create(&parquet).unwrap())
            .with_compression(ParquetCompression::Zstd(None))
            .with_row_group_size(Some(512 * 1024))
            .finish(&mut df)
            .unwrap()
    });
    let parquet_mib = mib(fs::metadata(&parquet).unwrap().len());

    // 4. The upload path: gzip-compressed CSV (PRD E32).
    PEAK.reset_peak_usage();
    let (gz_df, gz_s) = timed("full parse CSV.gz -> DataFrame", || read_csv(&gz, None));
    let gz_peak = PEAK.peak_usage();
    let gz_rows = gz_df.height();
    drop(gz_df);

    // 4b. Uploads arrive compressed: how fast is a preview straight from .gz, and
    //     does stream-decompressing to a staging file first cut peak memory?
    let (_, gz_preview_s) = timed("preview from CSV.gz (100 rows)", || read_csv(&gz, Some(100)));
    let staged = dir.join("orders_5m.staged.csv");
    PEAK.reset_peak_usage();
    let (_, gunzip_s) = timed("stream-gunzip .gz -> staging file", || {
        let mut out = BufWriter::with_capacity(1 << 20, File::create(&staged).unwrap());
        std::io::copy(&mut flate2::read::GzDecoder::new(std::io::BufReader::new(File::open(&gz).unwrap())), &mut out).unwrap();
        out.flush().unwrap();
    });
    let (staged_df, staged_parse_s) = timed("full parse staged CSV -> DataFrame", || read_csv(&staged, None));
    let staged_peak = PEAK.peak_usage();
    let staged_rows = staged_df.height();
    drop(staged_df);
    fs::remove_file(&staged).unwrap();

    // 5. Re-open from Parquet (rehydrate path).
    let (reloaded, reload_s) = timed("read Parquet -> DataFrame", || {
        ParquetReader::new(File::open(&parquet).unwrap()).finish().unwrap()
    });

    // Correctness checks.
    let dtype = |name: &str| df.column(name).unwrap().dtype().to_string();
    let notes = df.column("notes").unwrap().str().unwrap().clone();
    let multiline_rows = notes.iter().flatten().filter(|s| s.contains('\n')).count();
    let checks = json!({
        "rows": rows,
        "rows_expected": 5_000_000,
        "gz_rows": gz_rows,
        "staged_rows": staged_rows,
        "parquet_rows": reloaded.height(),
        "order_date": dtype("order_date"),
        "ship_ts": dtype("ship_ts"),
        "units": dtype("units"),
        "unit_price": dtype("unit_price"),
        "is_returned": dtype("is_returned"),
        "discount_nulls": df.column("discount").unwrap().null_count(),
        "multiline_notes_rows": multiline_rows,
        "multiline_expected": 5_000_000 / MULTILINE_EVERY,
        "quoted_example": notes.iter().flatten().find(|s| s.contains('"')).map(str::to_string),
    });
    println!("   checks: {checks}");

    // 6. Data Table operations (feeds M2 budgets: sort/filter <= 2 s, pivot <= 3 s).
    println!("\n== table ops on {rows} rows");
    let lf = || df.clone().lazy();
    let (_, sort_s) = timed("sort by revenue desc", || {
        lf().sort(["revenue"], SortMultipleOptions::default().with_order_descending(true)).collect().unwrap()
    });
    let (filtered, filter_s) = timed("filter region=North & units>25", || {
        lf().filter(col("region").eq(lit("North")).and(col("units").gt(lit(25)))).collect().unwrap()
    });
    let (pivot, group_s) = timed("group_by region,product sum/count/mean", || {
        lf().group_by([col("region"), col("product")])
            .agg([col("revenue").sum().alias("revenue"), col("order_id").count().alias("orders"), col("unit_price").mean().alias("avg_price")])
            .collect()
            .unwrap()
    });
    let (_, month_s) = timed("group_by month(order_date) sum", || {
        lf().group_by([col("order_date").dt().month().alias("month")]).agg([col("revenue").sum()]).collect().unwrap()
    });
    let (distinct, distinct_s) = timed("distinct region values (slicer)", || {
        df.column("region").unwrap().unique().unwrap().len()
    });
    let (_, computed_s) = timed("computed column revenue*(1-discount)", || {
        lf().with_column((col("revenue") * (lit(1.0) - col("discount").fill_null(lit(0.0)))).alias("net")).collect().unwrap()
    });

    let preview_and_import = preview_s + parse_s + parquet_s;
    let gate = preview_and_import <= 30.0 && rows == 5_000_000;
    println!(
        "\n   preview + parse + parquet = {preview_and_import:.2}s  (gate <= 30s): {}",
        if gate { "PASS" } else { "FAIL" }
    );
    println!(
        "   peak heap: parse {} MiB, gz parse {} MiB, gunzip-to-staging + parse {} MiB",
        mib(parse_peak as u64),
        mib(gz_peak as u64),
        mib(staged_peak as u64)
    );

    json!({
        "csv_mib": csv_mib,
        "parquet_mib": parquet_mib,
        "threads": threads(),
        "timings_s": {
            "preview": preview_s, "parse_csv": parse_s, "write_parquet": parquet_s, "parse_csv_gz": gz_s,
            "preview_csv_gz": gz_preview_s, "gunzip_to_staging": gunzip_s, "parse_staged_csv": staged_parse_s,
            "read_parquet": reload_s, "sort": sort_s, "filter": filter_s, "group_by_pivot": group_s,
            "group_by_month": month_s, "distinct": distinct_s, "computed_column": computed_s,
        },
        "peak_heap_mib": { "parse_csv": mib(parse_peak as u64), "parse_csv_gz": mib(gz_peak as u64), "gunzip_staging_then_parse": mib(staged_peak as u64) },
        "preview_schema": schema_json(&preview),
        "checks": checks,
        "results": { "filtered_rows": filtered.height(), "pivot_groups": pivot.height(), "distinct_regions": distinct },
        "gate": { "preview_parse_parquet_s": preview_and_import, "limit_s": 30.0, "pass": gate },
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("run");
    let dir = PathBuf::from(args.get(2).expect("data dir argument"));
    match mode {
        "gen" => generate(&dir, args.get(3).map(|s| s.parse().unwrap()).unwrap_or(5_000_000)),
        "run" => {
            let report = run(&dir);
            let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("results");
            fs::create_dir_all(&out).unwrap();
            fs::write(out.join("s3_run.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();
            println!("\nwrote {}", out.join("s3_run.json").display());
        }
        other => panic!("unknown mode {other}"),
    }
}
