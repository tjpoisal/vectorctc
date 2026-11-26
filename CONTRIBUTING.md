# Contributing to VectorCTC

Thanks for helping. VectorCTC is a small, single-maintainer project, so focused issues and small pull requests land fastest.

## Setup

```bash
git clone https://github.com/tjpoisal/vectorctc.git
cd vectorctc
npm ci
npm run check        # lint + typecheck + build + tests
```

Node.js 20.11 or newer (CI runs 20, 22 and 24).

## Ground rules

- **Determinism first.** A gate rule must give the same answer on the same input. No network calls in the gate path.
- **Precision over recall.** A new rule should not flag clean code. Add a clean fixture next to every defect fixture.
- **Every hold explains itself.** New violation codes need a `ctc.explain.v1` entry (why, snippet, fix).
- **Tests.** Add a vitest test for each rule or bug fix. `npm test` must pass on all supported Node versions.
- **Honest numbers.** Do not change benchmark numbers in docs or the site without the raw results that back them.

## Pull requests

1. Branch from `main`, keep the change focused, and describe *why* in the PR body.
2. Run `npm run check` locally.
3. Update `CHANGELOG.md` under "Unreleased".

By contributing you agree that your contributions are licensed under the project's license (see `LICENSE`).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
