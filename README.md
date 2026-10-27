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
- [ ] S2 canvas grid spike
- [ ] S3 Polars import spike
- [ ] Infra: CI, preview environments, Postgres, auth

## Commands
```bash
cargo check --workspace
cargo run --release -p s1_ironcalc -- all   # S1 gates
```
