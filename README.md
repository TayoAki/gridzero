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
- [ ] Preview environments per pull request (Railway PR environments, not yet enabled)

## Environments
| Env | URL | Hosting |
|---|---|---|
| Staging | https://control-staging-1dfe.up.railway.app | Railway project `gridzero`, environment `staging`: Postgres plus a `control` service built from the root `Dockerfile` on every push to `master` |

Staging deviates from BUILD-SPEC D14 (AWS) on purpose: the move to AWS is deferred until workbook hosts exist (M1).

## Local development
```bash
pnpm install
# Postgres: any local instance, or in-memory PGlite: npx @electric-sql/pglite-socket --port=54329 --max-connections=10
cp services/control/.env.example services/control/.env   # then set DATABASE_URL and a random BETTER_AUTH_SECRET
pnpm --filter @gridzero/control dev    # API on :8787, runs migrations on boot
pnpm --filter @gridzero/web dev        # app on :5173, proxies /api to :8787
pnpm --filter @gridzero/control test   # API integration tests (need DATABASE_URL)
pnpm --filter @gridzero/control db:generate   # new migration after editing src/db/schema.ts
```

## Rust
```bash
cargo check --workspace
cargo run --release -p s1_ironcalc -- all   # S1 gates
```
