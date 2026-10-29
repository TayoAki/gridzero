//! Synthetic import files for the M2 benchmarks (BUILD-SPEC §8 `bench/import_5m`).
//!
//!   gen-fixtures csv  <path> <rows>   orders CSV (same shape as spike S3)
//!   gen-fixtures xlsx <path> <rows>   orders XLSX, first sheet, header row

use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

use rust_xlsxwriter::{Format, Workbook};

const REGIONS: [&str; 4] = ["North", "South", "East", "West"];
const PRODUCTS: [&str; 6] = [
    "Widget",
    "Gadget",
    "Gizmo",
    "Doohickey",
    "Sprocket",
    "Thingamajig",
];

struct Lcg(u64);

impl Lcg {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) % n
    }
}

struct Order {
    id: u64,
    month: u64,
    day: u64,
    region: &'static str,
    product: &'static str,
    units: u64,
    price: f64,
    discount: Option<f64>,
    returned: bool,
}

fn order(rng: &mut Lcg, id: u64) -> Order {
    Order {
        id,
        month: rng.below(12) + 1,
        day: rng.below(28) + 1,
        region: REGIONS[rng.below(4) as usize],
        product: PRODUCTS[rng.below(6) as usize],
        units: rng.below(50) + 1,
        price: (rng.below(12_000) + 500) as f64 / 100.0,
        discount: (rng.below(10) != 0).then(|| rng.below(30) as f64 / 100.0),
        returned: rng.below(20) == 0,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, kind, path, rows] = &args[..] else {
        eprintln!("usage: gen-fixtures csv|xlsx <path> <rows>");
        std::process::exit(2);
    };
    let rows: u64 = rows.parse().expect("rows must be a number");
    let t = Instant::now();
    let mut rng = Lcg(42);
    match kind.as_str() {
        "csv" => {
            let mut w = BufWriter::with_capacity(1 << 20, File::create(path).unwrap());
            writeln!(
                w,
                "order_id,order_date,region,product,units,unit_price,discount,revenue,is_returned"
            )
            .unwrap();
            for id in 1..=rows {
                let o = order(&mut rng, id);
                let discount = o.discount.map(|d| format!("{d:.2}")).unwrap_or_default();
                writeln!(
                    w,
                    "{},2025-{:02}-{:02},{},{},{},{:.2},{},{:.2},{}",
                    o.id,
                    o.month,
                    o.day,
                    o.region,
                    o.product,
                    o.units,
                    o.price,
                    discount,
                    o.units as f64 * o.price,
                    o.returned
                )
                .unwrap();
            }
            w.flush().unwrap();
        }
        "xlsx" => {
            let mut wb = Workbook::new();
            let date = Format::new().set_num_format("yyyy-mm-dd");
            let ws = wb.add_worksheet_with_constant_memory().unwrap();
            let header = [
                "order_id",
                "order_date",
                "region",
                "product",
                "units",
                "unit_price",
                "discount",
                "revenue",
                "is_returned",
            ];
            for (c, h) in header.iter().enumerate() {
                ws.write_string(0, c as u16, *h).unwrap();
            }
            for id in 1..=rows {
                let o = order(&mut rng, id);
                let r = id as u32;
                ws.write_number(r, 0, o.id as f64).unwrap();
                // Excel serial date for 2025-mm-dd (2025-01-01 is 45658).
                let serial = 45658.0 + ((o.month - 1) * 28 + o.day - 1) as f64;
                ws.write_number_with_format(r, 1, serial, &date).unwrap();
                ws.write_string(r, 2, o.region).unwrap();
                ws.write_string(r, 3, o.product).unwrap();
                ws.write_number(r, 4, o.units as f64).unwrap();
                ws.write_number(r, 5, o.price).unwrap();
                if let Some(d) = o.discount {
                    ws.write_number(r, 6, d).unwrap();
                }
                ws.write_number(r, 7, o.units as f64 * o.price).unwrap();
                ws.write_boolean(r, 8, o.returned).unwrap();
            }
            wb.save(path).unwrap();
        }
        other => panic!("unknown kind {other}"),
    }
    let bytes = std::fs::metadata(path).unwrap().len();
    println!(
        "wrote {path}: {rows} rows, {:.1} MiB in {:.1}s",
        bytes as f64 / 1048576.0,
        t.elapsed().as_secs_f64()
    );
}
