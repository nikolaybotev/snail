# plan.md — Restore imported IDLE

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in the plan only. A closed plan shows | Status | Finished | in the header table.

This file is the draft. Do not start Phase 1 from this pull request. Do not merge this pull request. Merging it would push the default branch and publish `v0.1.6` without the client change (D4, FR7).

## Stops

FR4 is the proof. When that short-clock run fails, the phase stops and reports. It names no other timer workaround. It does not merge. That resolution is D4.

## Build gate

The spec review passed at `8727df521e735af508962cbfd1a84d3e88657dfc`.

1. A fresh-context review reads `plan.md` against [spec.md](spec.md). It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. Start Phase 1 only after that review is applied and the owner says to build.

Phase 1 is one branch and one pull request. Squash-merge it only when the required checks `test` and `javascript` have succeeded and FR4 passed. A cancelled check has not succeeded. Do not merge while either required check is missing, pending, failed, or cancelled. Do not use an admin override. Do not add `release:minor` or `release:major`. That merge publishes `v0.1.6` (FR7).

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` harness records `{ socketTimeout: 1500 }` and no other override. Options omit `disableAutoIdle`, `maxIdleTime`, and `autoIdleDelay`. Trace before the message is `IDLE`, `DONE`, `NOOP`, `IDLE`, `DONE`, `NOOP`, `IDLE`. No `Socket timeout` line. One EXISTS saves one message and sends one body-free webhook | 1 |
| AC2 | `npm test` two-argument options omit `disableAutoIdle`, `maxIdleTime`, `socketTimeout`, and `autoIdleDelay`. The module does not export `IDLE_REFRESH_MS` | 1 |
| AC3 | `npm test` default harness factory, exists runner, and BigInt runner call `createImapFlowClient` with account and password only. `snail.js` and files under `test/` do not contain `disableAutoIdle` | 1 |
| AC4 | `AGENTS.md` and `REVIEW.md` match FR6. `npm test` exits 0, including the 29-minute keepalive test with no fetch on that path | 1 |

`npm test` is `node --test`. Healthy: exit 0.

## Phase 1 — Restore imported IDLE

Files: `snail.js`, `test/imap-harness.test.js`, `AGENTS.md`, `REVIEW.md`. `intent/auto-idle/plan.md` only if a step departs from the spec.

1. In `snail.js`, remove `IDLE_REFRESH_MS` and its export. `createImapFlowClient(account, password)` passes host, port, `secure` from `tls === 'on'`, auth, and `logger: false`. Omit `disableAutoIdle`, `maxIdleTime`, `socketTimeout`, and `autoIdleDelay`. Keep the lazy `require('imapflow')` inside `connect` so the harness can record the constructor options. The third argument may set `socketTimeout` and no other imapflow option. Do not read `maxIdleTime` or `disableAutoIdle` from it. `snail.js` does not contain the identifier `disableAutoIdle`. `main` keeps the two-argument call. `src/supervisor.js` keeps `imapFactory(account, password)`. Leave `IDLE_KEEPALIVE_MS` at `29 * 60 * 1000`. Do not change `package.json`, the lockfile, or the config example. Do not add an IDLE config key.
2. In `test/imap-harness.test.js`, drop `IDLE_REFRESH_MS` from the `snail.js` require. Delete the case `AC1 idle refresh: broken maxIdleTime logs Socket timeout` and the case `AC2 idle refresh: maxIdleTime under socketTimeout stays connected`. On the direct `ImapFlow` constructor that opens the mailbox and logs out, omit `disableAutoIdle`. Keep the harness default factory as `createImapFlowClient`. Leave `test/idle-exists-runner.js` and `test/imap-client-ac6-runner.js` on the two-argument call. Replace the production-options case so it locks AC2. Add the FR4 proof: the factory passes `{ socketTimeout: 1500 }` only, the harness sleeper leaves `IDLE_KEEPALIVE_MS` pending and the reconnect delay of `5000` pending, and the server sends no unsolicited bytes during IDLE. Record the constructor options. Before `addMessage`, require the trace `IDLE`, `DONE`, `NOOP`, `IDLE`, `DONE`, `NOOP`, `IDLE` and no log line containing `Socket timeout`. Then one saved message, `lastUid` that UID, and one webhook whose payload has no body. Account names stay the synthetic names the suite already uses. Add the AC3 source check in that file. Build the searched identifier from two string parts so no file under `test/` contains it whole. The check reads `snail.js` and every `.js` file under `test/` and fails if that identifier appears.
3. In `AGENTS.md`, replace the Things agents get wrong bullet that begins with `Setting` and `` `disableAutoIdle: true` `` with the FR6 bullet, including the backticks. In `REVIEW.md`, on the Bugs line, replace the clause that begins with `` `disableAutoIdle` without `maxIdleTime` `` with the FR6 clause, including the backticks.
4. Do not edit other intent folders. Do not edit skills, the service unit, or the launchd wrapper. Do not deploy. When the FR4 run fails, stop and report. Name no other timer workaround. Do not merge the phase.

DoD: `npm test` exits 0, and the required checks `test` and `javascript` have succeeded.

### Build notes (Phase 1)

None. Phase 1 has not started.
