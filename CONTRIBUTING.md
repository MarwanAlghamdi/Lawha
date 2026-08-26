# Contributing to Lawha

Lawha is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw). Which project a change belongs to is the first question, and it is usually easy:

- **The canvas, the renderer, the element model, the hand-drawn look** — that is Excalidraw's work and lives upstream. Open it at [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw); everyone gets it, including Lawha at the next merge.
- **Accounts, boards, folders, tags, sharing, invites, the admin screens, the server, the deployment** — that is Lawha. Open it here.

## Before writing code

Read **[`docs/lawha-roadmap.md`](docs/lawha-roadmap.md) §2 — the invariants.** Twenty-five of them, each learned from a live bug. Breaking one is a defect even when every test passes, so a change that touches one needs to say why in the pull request.

Then read **the [ADRs](docs/adr/)** that touch your area. They record why a decision was made, including the decisions that were later reversed — ADRs 0010 and 0011 added encryption and 0012 removed it, and reading only the last one leaves you without the reasoning.

Some things that look like bugs are decisions. Scenes are **not** encrypted (ADR 0012); administrators hand out a reset link rather than setting a password (ADR 0021); the stack terminates no TLS by default, because plain HTTP behind a gateway is the shipped configuration (ADR 0018) — though `LAWHA_TLS=on` gives it an HTTPS listener of its own, and compose publishes both host ports, 9002 and 9443, either way (ADR 0022); there is no email anywhere, at all (invariant 9). If you think one of these is wrong, the change is an ADR first and code second.

## `packages/` is upstream, and its divergence is capped

**Invariant 10.** Everything under `packages/` is Excalidraw's, and Lawha's divergence from it is deliberately small — that cap is the only reason merging upstream stays tractable. Measure before you trust any number:

```bash
# once per clone — a fresh clone has only `main`, and this needs upstream
git remote add upstream https://github.com/excalidraw/excalidraw.git
git fetch upstream

git diff --stat $(git merge-base upstream/master main)..main -- packages/
```

Do not add a new diverging file there without an ADR.

## The gates

All of these must pass:

```bash
yarn test:typecheck          # tsc over the app and packages
yarn test:typecheck:server   # tsc --noEmit in lawha-server
yarn test:code               # eslint --max-warnings=0
yarn test:other              # prettier; ignore list is .eslintignore, NOT .gitignore
yarn test:app --watch=false  # every vitest suite: the editor's, and Lawha's own
yarn test:server             # backup, restore, encrypt-db, deployment-config pins (node:test)
yarn fix                     # prettier --write, then eslint --fix
```

Those are script names, not necessarily commands you can paste. `yarn` is often not on `PATH` — the repo pins `yarn@1.22.22` through `packageManager`, so prefix each with `corepack`: `corepack yarn test:typecheck`. [`docs/development.md`](docs/development.md) opens with the same instruction.

`yarn test:all` is **not** sufficient on its own — it omits both server gates.

**What is and is not covered.** `test:app` is every vitest suite — 131 files and 2050 tests — and that means Excalidraw's editor tests **and** Lawha's own. Eight files and 103 tests cover Lawha's code directly: the trash and account sweeps, `getBoardAccess` and `listForUser` owner-derivation, the socket permission resolver, the admin account-deletion guards and route shape, the boards route ordering, and the mermaid parser. Several are integration tests — they open a real in-memory SQLite database with every migration applied and drive the real repositories, and the sweeps also write real file blobs to a temp directory, so the cascades and orphan-file cleanup are asserted against the database rather than a mock. Lawha's editor features are covered under `packages/` by `lawhaGridObjects.test.tsx` and `lawhaSvgExport.test.ts`.

`test:server` is a separate runner — `node --test scripts/*.test.mjs`, 4 files and 125 tests over backup, restore, encrypt-db and the deployment-config pins. Backup and restore are covered because a silent backup failure has cost this project real data.

Everything outside those two suites, which is still most of the app and the server, is held by the typechecker, the linter and review. There is a Playwright suite in `e2e/` covering sign-in, boards, invites and visual regression — CI does not run it, because `playwright.config.ts` expects a dev server already listening on `localhost:3001`. Run it yourself against one. Note that `yarn test:visual` is a bare `playwright test` and runs all 13 projects, not just the screenshots; `yarn test:e2e:open` is the one that filters. [`docs/development.md`](docs/development.md#end-to-end-tests) has the detail.

If you add a test, put it beside what it covers and make sure it fails without your change. Do not weaken an existing assertion to make it pass — if a test's literal stopped meaning what it meant, rewrite it against the constant.

## Style

Commits are [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

Comments say **why, not what**. The prevailing register here is a long comment explaining the reasoning and the bug being prevented. A comment that restates the syntax is noise; a comment recording why the obvious thing was rejected is often the most valuable line in the file.

Prefer small, focused files. Extract rather than grow.

## Reporting a security issue

Please do not open a public issue. Lawha is self-hosted, so a report matters to every operator running it, and they need a version to upgrade to before they need the details. Use GitHub's private [security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) form on this repository.

Two things are known and documented rather than accidental, so they are not findings: **scenes are stored in the clear** — anyone with the database can read every board (ADR 0012) — and **the stack speaks plain HTTP**, so on a network where the traffic can be watched the session cookie can be captured (ADR 0018). Both are stated in the README. A way to _exploit_ either beyond what is written down is very much a finding.
