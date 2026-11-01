# plan.md — IMAP BigInt and service script name

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. Do not start Phase 1 from the pull request that only adds `intent/imap-bigint/`. Do not merge that pull request. A merge to the default branch publishes the next patch tag (D5), and a docs-only merge would publish a tag that lacks the fix.

## Stops

None. The integer coercion is D1. The script rename is D3. Backoff stays as D4. The `v0.1.1` tag is D5.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against the spec. It does not edit.
4. Apply those findings the same way.
5. Start Phase 1 only after both reviews are applied and the owner says to build.

Phase 1 is one branch and one pull request. Squash-merge it only when the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`. That merge publishes `v0.1.1` (D5).

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` fake-client BigInt mailbox open writes numeric state and a numeric message record | 1 |
| AC2 | `npm test` webhook `uid` and `uid_validity` are numbers; fake `modseq` is absent | 1 |
| AC3 | `npm test` helper: safe BigInt, plain number, unsafe BigInt not stored | 1 |
| AC4 | `npm test` wrapper name, plist, unit, README, archive member, exit-2 body kept | 1 |
| AC5 | `npm test` exits 0 | 1 |

## Phase 1 — IMAP integers and service script name

Files: `snail.js`, `src/supervisor.js`, `test/supervisor.test.js`, `scripts/run-service.sh` renamed to `scripts/snail-service.sh`, `launchd/com.snail.agent.plist`, `snail.service`, `README.md`, `scripts/build.sh`, `test/install-docs.test.js`, `test/build.test.js`

1. Add the FR1 helper in a module both `snail.js` and `src/supervisor.js` can require. `snail.js` already requires `src/supervisor.js`, so exporting the helper from `src/supervisor.js` avoids a new cycle. Apply it in `createImapFlowClient`'s `mailboxOpen` return (D1, D2) and to both `mailboxOpen` results in `runAccountLoop` before `ensureMailboxState` and before `syncMessages` (FR3). Re-read those lines if the default branch has moved past `d70d54d`.
2. Add the regression in `test/supervisor.test.js`. `createFakeImapClient` returns `uidValidity` and `uidNext` as BigInt, and the fetched message carries a BigInt `modseq`. Run the account loop with `stopAfterSync` and a webhook `fetchImpl` that records the body. Assert AC1 and AC2. Assert AC3 on the helper, including that an unsafe BigInt does not produce a state file.
3. `git mv scripts/run-service.sh scripts/snail-service.sh`. Leave the script body as it is, including the existing exit-2 status. Update the plist, the unit, `README.md`, `scripts/build.sh`, `test/install-docs.test.js`, and `test/build.test.js` to `snail-service.sh` (FR5). Keep `/ABS/PATH/TO/HOME` and `/ABS/PATH/TO/node`. Add no personal name, hostname, or real path.
4. Do not change `connectBackoff`, `INITIAL_BACKOFF_MS`, or `MAX_BACKOFF_MS` (D4). Do not edit `intent/portable-mail/` or `intent/config-error-restart/`. Do not copy `modseq` or `highestModseq` into state, message JSON, or the webhook body.

DoD: `npm test` exits 0.

The phase pull request has neither `release:minor` nor `release:major`. Squash-merge it when `test` and `javascript` are green. That merge is the one push that publishes `v0.1.1` with both changes (D5).

### Build notes (Phase 1)

None yet. This phase has not started.
