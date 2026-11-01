# plan.md — IDLE refresh

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in the plan only. A closed plan shows | Status | Finished | in the header table.

This file is the draft. Do not start Phase 1 from the pull request that only adds `intent/idle-refresh/`. Do not merge that pull request. Merging it would push the default branch and publish `v0.1.5` without the fix (D4).

The public report is GitHub issue 19. This draft pull request does not close it. The Phase 1 pull request body closes issue 19.

## Stops

None. The cause is D1. The 4-minute `maxIdleTime` is D2. The harness case is D3. The `v0.1.5` tag is D4.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against the spec. It does not edit.
4. Apply those findings the same way.
5. Start Phase 1 only after both reviews are applied and the owner says to build.

Phase 1 is one branch and one pull request. Squash-merge it only when the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not merge while either required check is missing, pending, failed, or cancelled. Do not use an admin override. Do not add `release:minor` or `release:major`. That merge publishes `v0.1.5` (D4).

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` harness: `socketTimeout` 400, `maxIdleTime` false, Selected, then `imap disconnected: Socket timeout` after one `IDLE`, `DONE`, and `NOOP`, with no second `IDLE` | 1 |
| AC2 | `npm test` harness: `socketTimeout` 500, `maxIdleTime` 150, second `IDLE` after `DONE`, no `Socket timeout` across two periods, one `EXISTS` saves once and sends one body-free webhook | 1 |
| AC3 | `npm test` asserts `IDLE_REFRESH_MS` is `240000` and the two-argument options set it, set `disableAutoIdle`, and omit `socketTimeout` | 1 |
| AC4 | `npm test` exits 0, including the existing 29-minute keepalive test | 1 |

`npm test` is `node --test`. Healthy: exit 0.

## Phase 1 — Refresh IDLE before the socket timeout

Files: `snail.js`, `test/imap-harness.test.js`, `AGENTS.md`, `REVIEW.md`

1. In `snail.js`, export `IDLE_REFRESH_MS` as `4 * 60 * 1000`. Pass `maxIdleTime: IDLE_REFRESH_MS` from `createImapFlowClient(account, password)`. Keep `disableAutoIdle: true`. Do not set `socketTimeout` on that call. Add the optional third argument from FR2. `main` keeps the two-argument call. `src/supervisor.js` keeps `imapFactory(account, password)`. Leave `IDLE_KEEPALIVE_MS` at `29 * 60 * 1000`. Do not change `package.json` or the lockfile.
2. In `test/imap-harness.test.js`, add the FR4 cases. Use the existing harness sleeper so `IDLE_KEEPALIVE_MS` stays pending and the reconnect `5000` stays pending. Point `imapFactory` at a wrapper that passes the third argument. Read `IDLE` / `DONE` / `NOOP` from imapkit `trace` input. The repaired case uses `addMessage` after the second `IDLE` and the existing webhook receiver. Account names stay synthetic. The host string stays `127.0.0.1`. Assert AC3 on the exported constant and on the two-argument options object.
3. In `AGENTS.md`, under Things agents get wrong, state that `disableAutoIdle` without a `maxIdleTime` under imapflow's 5-minute socket timeout logs `imap disconnected: Socket timeout` about every 10 minutes. In `REVIEW.md`, add that failure to the Bugs line.
4. Do not edit other intent folders. Do not edit skills. Do not deploy.

DoD: `npm test` exits 0.

### Build notes (Phase 1)

Phase 1 has not started.
