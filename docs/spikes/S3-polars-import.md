# Spike S3 — Polars import pipeline

**Result: PASS (7.6–7.9 s against a 30 s gate). Keep BUILD-SPEC D2 (Polars on Arrow, Parquet-backed Data Tables).**
Date: 2026-10-28 · Engine: `polars 0.55.2` (default features off; `lazy, csv, parquet, temporal, dtype-date, strings, decompress, fmt`) · Harness: `spikes/s3_import`

## Test data
`s3_import gen` writes a synthetic orders file: 5,000,000 rows × 12 columns, **532 MiB** of CSV and 138.6 MiB as `.csv.gz` (gzip level 6). It contains:
- integers, floats and booleans
- `YYYY-MM-DD` dates and `YYYY-MM-DD HH:MM:SS` timestamps
- about 10% empty values in one column
- quoted fields containing commas and escaped `""` quotes
- 500 records with a quoted newline (multi-line fields).

## Gate

| Step | Time (2 runs) |
|---|---|
| Preview: first 100 rows, schema inferred from 10k rows | 0.76–0.85 s |
| Full parse, CSV → DataFrame | 3.35–3.57 s |
| Write Parquet (zstd, 512k-row groups) | 3.41–3.62 s |
| **Preview + parse + Parquet** | **7.61–7.91 s (gate ≤ 30 s): PASS** |

Machine: i7-10750H laptop (6C/12T), 32 GB RAM, NVMe, release build. This is a laptop, not the m7i.2xlarge reference host.

## Correctness
- Row counts are exactly 5,000,000 for plain CSV, `.csv.gz`, the staged copy and the Parquet round-trip.
- Inferred types are all correct: `order_id`/`units` → i64, `unit_price`/`discount`/`revenue` → f64, `is_returned` → bool, `order_date` → **date**, `ship_ts` → **datetime[μs]**, everything else → str.
- Empty `discount` values became 500,404 nulls.
- All **500 of 500** multi-line records survived multi-threaded parsing, and escaped quotes decode correctly (`rush, gift wrap, ref "284144"`).

## Other import paths

| Path | Time | Peak heap* |
|---|---|---|
| Parse `.csv.gz` directly | 4.43–4.80 s | ≈ 1.8 GiB |
| Stream-gunzip to a staging file, then parse | 0.95–1.05 s + 3.30–3.32 s | ≈ 0.8 GiB |
| Preview from `.csv.gz` (100 rows) | 0.003–0.005 s | — |
| Read Parquet → DataFrame (rehydrate) | 0.33 s | — |

\*Measured with `peak_alloc`. The gz and staged rows ran while the first 5M-row frame (about 0.8 GiB) was still in memory, so I've subtracted that; treat these as approximate. Plain CSV parse peaked at 799 MiB.

Parquet output: **111.2 MiB**, 21% of the CSV's size and smaller than the gzip.

## Data Table operations (input to M2 budgets)

| Operation on 5M rows | Time | M2 budget |
|---|---|---|
| Sort by `revenue` descending | 0.76–0.82 s | ≤ 2 s ✔ |
| Filter `region = North AND units > 25` | 0.045 s | ≤ 2 s ✔ |
| Pivot: group by region × product, sum / count / mean | 0.35–0.36 s | ≤ 3 s ✔ |
| Group by month(order_date), sum | 0.20–0.22 s | ≤ 3 s ✔ |
| Distinct values of one column (slicer list) | 0.08–0.10 s | — |
| Computed column `revenue * (1 - discount)` | 0.04–0.05 s | ≤ 3 s ✔ |

## Findings that change the design
1. **The import pipeline is not the bottleneck.** Parse plus Parquet is about 7 s for 5M rows, so the 45 s M2 budget is mostly upload time. The 5 GB plan limit is roughly 47M rows; extrapolating linearly, that's about 70 s, which needs a progress bar (already planned with `Progress` frames).
2. **Don't parse uploads from `.gz` in memory.** Parsing the gzip file directly roughly doubles peak memory (≈ 1.8 GiB against ≈ 0.8 GiB). The importer should **stream-decompress to the staging disk while the upload arrives**, then mmap-parse the staged file. That uses less memory and is about as fast overall. It also means decompression overlaps the network transfer.
3. **Previews should read a byte prefix.** A 100-row preview of plain CSV took 0.75 s; Polars appears to scan the whole memory-mapped file before applying `n_rows`. From `.gz` it took 3 ms, because the decoder stops early. The preview should parse only the first few MB the upload has written so far, so the import dialog appears as the first bytes land, before the upload finishes.
4. **Parquet is the right at-rest format.** It reloads in 0.33 s, so it's cheap on rehydrate, against about 3.4 s to re-parse the CSV. Keep Parquet per table version as specced (§4.3).
5. **Memory:** a 5M × 12 frame is about 0.8 GiB. The §8 budget of ≤ 4 GB per active 5M-row workbook holds for one table plus a few derived frames (sort, pivot). The engine needs lazy evaluation and per-actor memory caps once workbooks hold several big tables.

## Not covered (carry into M2)
- XLSX (calamine), JSONL and Parquet uploads; delimiter, quote and escape autodetect and skip-N-rows; non-UTF-8 encodings; ragged rows and bad-row reporting.
- The streaming engine (`sink_parquet`) for files bigger than memory.
- Parse cost growing with very wide files (100+ columns) or long text columns.
- Upload networking, multipart and resume.

## Reproduce
```bash
cargo build --release -p s3_import
./target/release/s3_import gen <data-dir> 5000000
./target/release/s3_import run <data-dir>   # writes spikes/s3_import/results/s3_run.json
```
