# Benchmark locks

`heldout2.PREREGISTRATION.lock.json` is a copy of `bench/results/heldout2/PREREGISTRATION.lock.json`:
SHA-256 hashes of the held-out-2 task specs (answer key), policies and rubric, plus the corpus hash.
It was written and committed before any v0.3 code change, so the git timestamp of this commit
proves the answer key predates the v0.3 work. `node scripts/verify-preregistration.mjs` with
`BENCH_SET=heldout2` re-checks the hashes before scoring.
