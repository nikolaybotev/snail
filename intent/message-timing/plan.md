# plan.md — Time a live message

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in this plan only. A closed plan shows | Status | Finished | in the header table.

## Stops

None. The four lines, the untouched existing timestamp format, the `exists` fields, and the release boundary are decided in the spec.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` live `exists` of `{ path: 'INBOX', count: 3, prevCount: 2 }` with no uid, then order through `notify ok` | 1 |
| AC2 | `npm test` live `exists` with `path` `Archive` and mailbox `INBOX` | 1 |
| AC3 | `npm test` catch-up logs `fetch start`, `fetch end`, and `file write` and logs no `exists` line | 1 |
| AC4 | `npm test` sentinels absent; null fetch and an already-present file log no `file write` | 1 |
| AC5 | `npm test` leaves the `formatLogLine` prefix test and the FR1 statements in place | 1 |

`npm test` is `node --test`. Healthy: exit 0.

## Publishing

Checked 2026-11-02. `v0.1.8` is `46c1b0fc2527063b05386ce3c2bf94d21bbb09f2` on the default branch. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. That merge publishes `v0.1.9`.

This pull request is the squash merge that publishes `v0.1.9`. Phase 1, the log change and its test, lands on this branch. Squash-merge this pull request only after Phase 1 is in it and the required checks `test` and `javascript` have succeeded. A missing, pending, failed, or cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`. Do not close this pull request. Squash-merging before Phase 1 is in this pull request publishes `v0.1.9` without the log lines.

## Phase 1 — Log the live message

Files: `snail.js`, `src/supervisor.js`, `src/mail-store.js`, `test/message-timing-runner.js`, `test/message-timing.test.js`

1. Leave these statements as they are. `formatLogLine` still calls `new Date().toISOString()` (`src/supervisor.js` lines 44–48). `notify ok` and `notify failed` stay `` `${outcome} uid ${wakeCtx.uid} attempts ${result.attempts}` `` (lines 257–258). `imap disconnected` stays `` `imap disconnected: ${msg}` `` (line 357). `starting` stays `` `${new Date().toISOString()} [snail] starting` `` (`snail.js` line 291). The mail-save failure line stays `` `[snail] [${name}] mail save failed uid ${msg.uid}: ${message}` `` (`src/mail-store.js` line 427). Leave the test `formatLogLine uses UTC prefix and account tag` unchanged, including the pattern `\.\d{3}Z`.
2. In `createImapFlowClient`, keep the signature `(account, password, imapOverrides)`. Add `setLog(fn)` on the returned client. `runAccountLoop` calls `setLog` with its account logger when the method exists, immediately after `imapFactory` returns and before `connect`. The listener becomes `onExists(event)`. Before `resolve()`, and only when `setLog` has been called, log `exists mailbox ${account.mailbox} path ${event.path} count ${event.count} prevCount ${event.prevCount}` through that logger. Then keep the existing cleanup and `resolve()` with no argument. Do not read `event.uid`. Do not print `uidNext`. `raceIdle` still maps fulfillment to the string `exists`.
3. In `syncMessages`, accept the account logger and the mailbox. Immediately before `fetchOne`, log `fetch start mailbox ${mailbox} uid ${uid}`. When `fetchOne` returns, including a null result, log `fetch end mailbox ${mailbox} uid ${uid}`, then continue to `saveOneMessage` only when a message was returned. A throw from `fetchOne` logs no `fetch end` and no `file write`. Both `syncMessages` call sites in `runAccountLoop` pass the same logger and `account.mailbox`. The account logger is the one that already calls `formatLogLine`.
4. In `saveOneMessage`, after `writeFileSync` of the message JSON returns and before `renameSync`, log `file write mailbox ${mailbox} uid ${msg.uid}` through that same account logger. Pass the mailbox and that logger into `createMailStore` separately from the existing `log` used by the save-failed line. An existing file, a `beforeWrite` that returns false, or a throw from `writeFileSync` logs no `file write`.
5. Add `test/message-timing-runner.js` and `test/message-timing.test.js`, using the preload pattern from `test/idle-exists-runner.js` so a mocked imapflow is in place before `snail.js` loads. The mock emits `exists` and does not open a socket. The account name is `work`. The mailbox is `INBOX`. The password is `secret-token`. The message carries `body-token`, `subject-token`, and `from-token`. Share one sequence array between the log callback and the start of `mailboxOpen`. Assert order in that array. Two equal timestamps are still ordered by position.
   - Catch-up, before any `exists` emit: uid 101 is fetched and written. The sequence has `fetch start mailbox INBOX uid 101`, `fetch end mailbox INBOX uid 101`, and `file write mailbox INBOX uid 101`, and no `exists` line.
   - Null fetch: uid 102 is in the catch-up range and `fetchOne` returns null. The sequence has `fetch start` and `fetch end` for uid 102 and no `file write` for uid 102.
   - Already present: uid 103 has a file `lookupExistingMessageFile` finds. The sequence has `fetch start` and `fetch end` for uid 103 and no `file write` for uid 103.
   - Then emit `{ path: 'INBOX', count: 3, prevCount: 2 }` with no uid, and serve uid 104. The `exists` line is `exists mailbox INBOX path INBOX count 3 prevCount 2`. It appears before the next `mailboxOpen`. It does not match the token `uid`. Then `fetch start`, `fetch end`, `file write`, and `notify ok uid 104 attempts` follow, in that order. `notify ok` gains no new fields.
   - A second run emits `{ path: 'Archive', count: 1, prevCount: 0 }` while the mailbox is `INBOX`. The line is `exists mailbox INBOX path Archive count 1 prevCount 0`.
   - `body-token`, `subject-token`, `from-token`, and `secret-token` are absent from every `exists`, `fetch start`, `fetch end`, and `file write` line.
   - Read `snail.js` and `src/supervisor.js` and require the four statements in step 1. Read `test/supervisor.test.js` and require the `formatLogLine` test's `\.\d{3}Z` pattern.
6. Leave `AGENTS.md`, `REVIEW.md`, `package.json`, the release workflow, and every other intent folder unchanged. Leave existing `test()` bodies unchanged unless one fails only because a new line was added. In that case allow the new line and keep the previous expected text. Do not install anything. The test does not open a network socket.

DoD: `npm test` exits 0.
