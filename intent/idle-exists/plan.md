# plan.md — Live IDLE exists

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in the plan only. A closed plan shows | Status | Finished | in the header table.

This file is the draft. Do not start Phase 1 from the pull request that only adds `intent/idle-exists/`. Do not merge that pull request. Merging it would push the default branch and publish `v0.1.2` without the fix (D4).

## Stops

None. The listener is D2. The test double is D3. The `v0.1.2` tag is D4.

The live IDLE scenario on a scripted server is a cut from this intent. It is the harness pull request 15, a separate intent. It is not a step below.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against the spec. It does not edit.
4. Apply those findings the same way.
5. Start Phase 1 only after both reviews are applied and the owner says to build.

Phase 1 is one branch and one pull request. Squash-merge it only when the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`. That merge publishes `v0.1.2` (D4).

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` mocked imapflow emits `exists`, `idle()` stays pending, the UID is saved, the notifier runs once | 1 |
| AC2 | That test fails while `snail.js` `idle()` only awaits `client.idle()` | 1 |
| AC3 | `npm test` exits 0, with no network socket and no real account | 1 |

## Phase 1 — Restore the exists wait

Files: `snail.js`, `test/idle-exists.test.js`, `test/idle-exists-runner.js`

1. Change `createImapFlowClient.idle()` so its promise fulfills when the imapflow client emits `exists`, and rejects when `client.idle()` rejects (FR4, D2). Register the listener before calling `client.idle()`. Settle once. Do not fulfill the adapter wait when `client.idle()` fulfills, including when imapflow returns immediately because it is already idling. Leave the constructor options and the empty `error` handler as they are. Leave `package.json` and the lockfile on imapflow `^1.3.1` / 1.7.8.
2. Leave `src/supervisor.js` on the current fetch path. Line 442 still treats adapter fulfillment as `'exists'`. Lines 330–344 still `mailboxOpen` and `syncMessages`. That `mailboxOpen` is what leads imapflow to write `DONE`. Do not add `getMailboxLock`, NOOP, `disableAutoIdle`, `maxIdleTime`, or `cancelIdle`. Do not change the 29-minute keepalive test.
3. Add the regression test (FR7, D3, AC1, AC2). Follow `test/imap-client-ac6-runner.js`: patch the module loader, then load `snail.js`, so the stub is the imapflow the adapter constructs. The stub emits `exists` and leaves its `idle()` promise pending. Seed a later-run state so the initial sync has nothing to save. After `idle()` has been called, raise UIDNEXT, return one message from `fetchOne`, and emit `exists`. Assert one saved file and one notifier call, and assert the stub promise is still pending. Use `imap.example.com` and `you@example.com`. Do not call `createFakeImapClient.triggerExists`. The test fails while `snail.js` lines 171–174 still only await `client.idle()`.
4. Do not edit `intent/portable-mail/` or `intent/imap-bigint/`. Do not take the launchd exit-2 change. Do not add a scripted IMAP server, a live Dovecot, or the harness's live IDLE scenario. Pull request 15 adds that scenario later. It is out of scope for this phase, not a step in it.

DoD: `npm test` exits 0.

The phase pull request has neither `release:minor` nor `release:major`. Squash-merge it when `test` and `javascript` are green. That merge is the one push that publishes `v0.1.2` (D4).

## Out of scope

- Launchd exit-2 mapping, pull request 13. Not this phase.
- IMAP harness, pull request 15. That pull request should later add a live IDLE scenario. This phase does not add it and does not start that work.
- Breaking or restarting IDLE at 29 minutes on the real client. The fake keepalive test stays as it is.
