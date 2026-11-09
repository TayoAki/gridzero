# Benchmark: GridZero against other spreadsheets

The same tasks on the same data in each product. GridZero is measured automatically; the others are timed by hand in a browser, with a stopwatch, by the steps in `scoresheet.csv`.

## The data

```bash
node bench/dataset.mjs 100000 sales-100k.csv
node bench/dataset.mjs 1000000 sales-1m.csv
node bench/formulas.mjs > formulas.tsv
```

`dataset.mjs` is seeded, so every run and every product gets byte-identical files: orders with `order_id, order_date, region, product, channel, units, unit_price, revenue, discount`. The 1M-row file is about 70 MB. `formulas.tsv` is the formula coverage sheet: a small data block in A:C, 96 formulas in column E, and Excel's answer in column G.

For T8, make `recalc.tsv` with 20,000 rows of `n<TAB>(n mod 7)+1<TAB>=An*Bn*$E$1`, put 1 in E1 and `=SUM(C1:C20000)` in D1. The GridZero runner builds the same sheet.

## GridZero

```bash
node bench/gridzero.mjs https://<control-domain> 100000,1000000
```

It signs up a throwaway `@example.test` account, runs T0–T9 over the same API and socket the browser uses, deletes its workbooks, and writes `bench/results/gridzero-<host>-<date>.json`. Times are round trips from the machine running it, so they include the network, as a person's clicks would. T0 is an empty round trip; subtract it to see the server's share. Drawing in the browser is not measured.

## Other products

1. Use the same machine and network as the GridZero run, in one browser, with nothing else heavy running.
2. For each task in `scoresheet.csv`, follow "how to measure by hand" three times and write down the middle time. Times under about 300 ms are hard to time by hand: write `<0.3 s` rather than a guess.
3. If a task is refused or crashes, write what happened ("over row limit", "tab crashed") instead of a time.
4. Fill in the C rows from the product's own docs and pricing page, with the date you checked.

## Against our own budgets

BUILD-SPEC §8 sets GridZero's budgets at 5M rows (import ≤ 45 s, sort or filter ≤ 2 s, pivot ≤ 3 s). The runner takes any size (`node bench/gridzero.mjs <url> 5000000`), but a 5M-row file is about 350 MB, so run that one from a cloud machine near the server rather than over a home connection.

## The report

```bash
node bench/report.mjs
```

Builds `bench/report.html` from the newest GridZero result and `scoresheet.csv`: one table per task, GridZero's time split into network and server, the formula coverage by area, and the capability checklist.
