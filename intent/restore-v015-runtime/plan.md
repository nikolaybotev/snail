# plan.md — Restore v0.1.5 runtime

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 3 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in the plan only. A closed plan shows | Status | Finished | in the header table.

This pull request is the publishing merge, and only after the client change is in it. G4 names that same merge. The coverage rows stay on Phase 1.

This file is the plan. It does not restore the client. Do not merge this pull request until `snail.js` matches tag `v0.1.5` (`fa91b2f`). Merging before that publishes `v0.1.7` without the restore (D4).

## Stops

None. The factory surface is D1. The harness file is D2. The handbook sentences are D3. The patch tag is D4.

Keychain migration is closed. `48d152e` does not change secret resolution, and this release does not migrate `keychain://` references. That work does not continue on this intent. A later idea starts a new `intent/<slug>/` that links to this folder.

## Build gate

The spec review passed at `0e21f627601a823ae31f07b2d220c1e1e2b94144`. Draft 3 names this pull request as the publishing merge, and only after the client change is in it.

1. A fresh-context review reads this plan against [spec.md](spec.md) Draft 2. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. Start Phase 1 only after that review is applied and the owner says to build.

Phase 1 is this branch and this pull request. Squash-merge it only when the client change is in it and the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not merge while either required check is missing, pending, failed, or cancelled. Do not use an admin override. Do not add `release:minor` or `release:major`. That merge publishes `v0.1.7` (D4).

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `git diff --exit-code v0.1.5 -- snail.js` | 1 |
| AC2 | `git diff --exit-code v0.1.5 -- test/imap-harness.test.js` | 1 |
| AC3 | `git diff --exit-code v0.1.5 -- AGENTS.md REVIEW.md` | 1 |
| AC4 | `npm test` exits 0, including the 29-minute keepalive case | 1 |
| AC5 | `git diff --exit-code v0.1.6 -- intent/auto-idle src/supervisor.js src/secrets.js` | 1 |

`npm test` is `node --test`. Healthy: exit 0. `v0.1.5` is `fa91b2f`. `v0.1.6` is `48d152e`.

## Phase 1 — Restore the v0.1.5 IMAP client

Files: `snail.js`, `test/imap-harness.test.js`, `AGENTS.md`, `REVIEW.md`

1. Restore `snail.js` from tag `v0.1.5` (`fa91b2f`). That returns `IDLE_REFRESH_MS` (`4 * 60 * 1000`), `disableAutoIdle: true`, `maxIdleTime: IDLE_REFRESH_MS`, the third argument that may set `maxIdleTime` (including `false`) and `socketTimeout`, and the export of `IDLE_REFRESH_MS`. Startup keeps the two-argument call. Do not edit `src/supervisor.js`.
2. Restore `test/imap-harness.test.js` from tag `v0.1.5`. That returns the three idle-refresh cases and `disableAutoIdle: true` on the direct `ImapFlow` constructor in the wide-UID case. The `v0.1.6` auto-idle cases do not remain.
3. Restore `AGENTS.md` and `REVIEW.md` from tag `v0.1.5`. The IDLE bullet and the Bugs clause match FR4, including U+2019 in `library’s` and `imapflow’s` and U+2014 in the `AGENTS.md` bullet.
4. Do not restore `intent/auto-idle/`. Leave `src/secrets.js`, the keychain docs, `package.json`, the lockfile, the service unit, and the launchd wrapper as they are on `v0.1.6`. Do not add `release:minor` or `release:major`. Do not deploy.

DoD: AC1, AC2, AC3, AC4, and AC5 exit 0 on this branch. The pull request stays open until those checks pass and `test` and `javascript` have succeeded. Then squash-merge it.
