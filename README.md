# GridZero

A cloud spreadsheet for billion-row data (a Row Zero–class product).

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Engineering plan: [docs/BUILD-SPEC.md](docs/BUILD-SPEC.md)
- Spike reports: [docs/spikes/](docs/spikes/)

## Layout
See BUILD-SPEC §12. The Rust crates live in `crates/` and `spikes/` (a single Cargo workspace). The TypeScript packages live in `apps/` and `services/` (a pnpm workspace).

## Status: Milestone 0
- [x] Monorepo scaffold
- [x] S1 IronCalc gate: **PASS** ([report](docs/spikes/S1-ironcalc.md))
- [x] S2 canvas grid spike: **PASS** ([report](docs/spikes/S2-canvas-grid.md))
- [x] S3 Polars import spike: **PASS** ([report](docs/spikes/S3-polars-import.md))
- [x] Infra: GitHub Actions CI, Postgres, email/password auth, staging on Railway. **M0 gate passed:** sign up → empty home page in staging.
- [x] Preview environments per pull request: Railway PR environments, forked from `staging` with their own Postgres and domain, and removed when the PR closes

## Status: Milestone 1 (single-user editing)
- [x] Workbook host (`crates/wbhost`): one actor thread per workbook, routing tokens signed by the control plane, idle eviction with a snapshot
- [x] Engine on IronCalc `UserModel`: Session, Cells, Formatting, Sheets, Navigation and Names action groups (BUILD-SPEC §5.2)
- [x] Durability: op-log of IronCalc diffs (fsync before ack), snapshot every N ops, exact replay on rehydrate
- [x] Web: canvas grid with formulas, number formats, borders, merges, freeze panes, resize, sheet tabs, find/replace, named ranges, context menus, Excel shortcuts and TSV paste
- [x] Home page: workbook list, create, rename, delete
- [x] Acceptance suite (`tests/e2e`, runs in CI): persistence across reload and restart; no acked edit lost on SIGKILL; 50-step undo/redo; 10k-cell TSV paste; Ctrl+arrow, freeze, merge, formats and borders; §8 budgets

| §8 budget (release build) | Measured | Budget |
|---|---|---|
| Warm open p95 | 13 ms | ≤ 800 ms |
| UpdateCell → Changed p95, 100k-formula sheet | 59 ms | ≤ 120 ms |
| Cold rehydrate (snapshot + op-log) | 14 ms | — |

Known M1 gaps: undo history is per workbook and shared by everyone editing it; workbook data lives on the host's local volume (S3 snapshots come later); conditional formats and data validation are M3.

## Environments
| Env | URL | Hosting |
|---|---|---|
| Staging | https://control-staging-1dfe.up.railway.app | Railway project `gridzero`, environment `staging`: Postgres plus a `control` service built from the root `Dockerfile` on every push to `master` |
| Staging workbook host | wss://wbhost-staging.up.railway.app | `wbhost` service built from `crates/wbhost/Dockerfile`, with a volume at `/data` |
| PR previews | `control-gridzero-pr-<n>.up.railway.app` (posted on the PR by Railway) | One Railway environment per open pull request, cloned from `staging` |

`BETTER_AUTH_URL` is set to `https://${{RAILWAY_PUBLIC_DOMAIN}}` so each environment trusts its own domain.

Staging deviates from BUILD-SPEC D14 (AWS) on purpose: the move to AWS is deferred until workbook hosts exist (M1).

## Local development
```bash
pnpm install
# Postgres: any local instance, or in-memory PGlite: npx @electric-sql/pglite-socket --port=54329 --max-connections=10
cp services/control/.env.example services/control/.env   # then set DATABASE_URL and a random BETTER_AUTH_SECRET
pnpm --filter @gridzero/control dev    # API on :8787, runs migrations on boot
pnpm --filter @gridzero/web dev        # app on :5173, proxies /api to :8787
pnpm --filter @gridzero/control test   # API integration tests (need DATABASE_URL)
cargo run -p wbhost                    # workbook host on :8790 (set WB_TOKEN_SECRET to match control's .env)
cargo build --release -p wbhost && E2E_RELEASE=1 pnpm --filter @gridzero/e2e test   # M1 acceptance suite (needs DATABASE_URL)
pnpm --filter @gridzero/control db:generate   # new migration after editing src/db/schema.ts
```

## Rust
```bash
cargo check --workspace
cargo run --release -p s1_ironcalc -- all   # S1 gates
```
