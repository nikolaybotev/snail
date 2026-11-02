# plan.md — Time a live message

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 3 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in this plan only. A closed plan shows | Status | Finished | in the header table.

## Stops

None. The message lines, the webhook request id, the attempt number, the duration, the untouched existing timestamp format, the `exists` fields, and the release boundary are decided in the spec.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` live `exists` of `{ path: 'INBOX', count: 3, prevCount: 2 }` with no uid, then order through the webhook lines and `notify ok` | 1 |
| AC2 | `npm test` live `exists` with `path` `Archive` and mailbox `INBOX`; mailbox `IN BOX` and path `A B` are `IN%20BOX` and `A%20B` | 1 |
| AC3 | `npm test` catch-up logs `fetch start`, `fetch end`, and `file write` and logs no `exists` line | 1 |
| AC4 | `npm test` sentinels absent; null fetch and an already-present file log no `file write` | 1 |
| AC5 | `npm test` leaves the `formatLogLine` prefix test and the FR1 statements in place | 1 |
| AC6 | `npm test` live uid 104 webhook lines match FR12 aside from the generated id and `status 204`; injected `req-1` attempt 1 is `duration 15` status 500 and attempt 2 is `duration 20` status 204; `webhook-secret-token` is absent | 1 |
| AC7 | `npm test` timeout logs `webhook start` and no `webhook response`; fetch lines have no `request` token | 1 |

`npm test` is `node --test`. Healthy: exit 0.

## Publishing

Checked 2026-11-02. `v0.1.8` is `46c1b0fc2527063b05386ce3c2bf94d21bbb09f2` on the default branch. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. That merge publishes `v0.1.9`.

This pull request is the squash merge that publishes `v0.1.9`. Phase 1, the log change and its test, lands on this branch. Squash-merge this pull request only after Phase 1 is in it and the required checks `test` and `javascript` have succeeded. A missing, pending, failed, or cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`. Do not close this pull request. Squash-merging before Phase 1 is in this pull request publishes `v0.1.9` without the log lines.

## Phase 1 — Log the live message

Files: `snail.js`, `src/supervisor.js`, `src/mail-store.js`, `src/notifiers/webhook.js`, `test/idle-exists-runner.js`, `test/message-timing-runner.js`, `test/message-timing.test.js`

1. Leave these statements as they are. `formatLogLine` still calls `new Date().toISOString()` (`src/supervisor.js` lines 44–48). `notify ok` and `notify failed` stay `` `${outcome} uid ${wakeCtx.uid} attempts ${result.attempts}` `` (lines 257–258). `imap disconnected` stays `` `imap disconnected: ${msg}` `` (line 357). `starting` stays `` `${new Date().toISOString()} [snail] starting` `` (`snail.js` line 291). The mail-save failure line stays `` `[snail] [${name}] mail save failed uid ${msg.uid}: ${message}` `` (`src/mail-store.js` line 427). Leave the test `formatLogLine uses UTC prefix and account tag` unchanged, including the pattern `\.\d{3}Z`.
2. In `createImapFlowClient`, keep the signature `(account, password, imapOverrides)`. Add `setLog(fn)` on the returned client. `runAccountLoop` calls `setLog` with its account logger when the method exists, immediately after `imapFactory` returns and before `connect`. The listener becomes `onExists(event)`. Read `path`, `count`, and `prevCount` only when `event` is an object and has that field. Do not read `event.path` when `event` is missing. When `setLog` has been called, log `exists mailbox ${encodeURIComponent(account.mailbox)}` and append `path`, `count`, and `prevCount` only for the fields that are present. `path` is `encodeURIComponent` of the raw path. Then always run the existing cleanup and `resolve()` with no argument, including when the event has no fields and when the log call throws. Do not read `event.uid`. Do not print `uidNext`. `raceIdle` still maps fulfillment to the string `exists`. In `test/idle-exists-runner.js`, change `liveImap.emit('exists')` to `liveImap.emit('exists', { path: 'INBOX', count: 1, prevCount: 0 })`. Leave that runner's wake count and the still-pending `idle()` promise as they are.
3. In `syncMessages`, accept the account logger and the mailbox. Immediately before `fetchOne`, log `fetch start mailbox ${mailbox} uid ${uid}`. When `fetchOne` returns, including a null result, log `fetch end mailbox ${mailbox} uid ${uid}`, then continue to `saveOneMessage` only when a message was returned. A throw from `fetchOne` logs no `fetch end` and no `file write`. Both `syncMessages` call sites in `runAccountLoop` pass the same logger and `account.mailbox`. The account logger is the one that already calls `formatLogLine`.
4. In `saveOneMessage`, after `renameSync` returns and before `onWake`, log `file write mailbox ${encodeURIComponent(mailbox)} uid ${msg.uid}` through that same account logger. A throw from `renameSync` does not log that line. Pass the mailbox and that logger into `createMailStore` separately from the existing `log` used by the save-failed line. An existing file, a `beforeWrite` that returns false, or a throw from `writeFileSync` logs no `file write`. Fetch start, fetch end, and this file write line carry mailbox and uid only. Do not add a request id to them. `syncMessages` already finishes one uid before the next, so those three lines correlate by that pair. Write every mailbox and path with `encodeURIComponent`. A space is `%20`.
5. In `notifyWebhook`, generate one id with `crypto.randomUUID()` at the start of the call. Accept an injected id and an injected `now` so the test can force both. Accept the account logger. Do not change `notifyWithRetries` or its delays. Inside the webhook `attempt` function, count from 1. Before `fetchImpl`, log `webhook start mailbox ${encodeURIComponent(mailbox)} uid ${uid} request ${id} attempt ${n}`. When that attempt receives a Response, log `webhook response mailbox ${encodeURIComponent(mailbox)} uid ${uid} request ${id} attempt ${n} status ${status} duration ${ms}` before the attempt returns. `ms` is `now()` after the Response minus `now()` from before `fetchImpl`. A timeout or a throw logs no response line and does not invent a status. The duration does not include the retry sleep. Mailbox and uid come from the payload already passed into `notifyWebhook`. The lines do not include the URL, the body, a header, the subject, or an address. Leave the Openclaw call unchanged.
6. Add `test/message-timing-runner.js` and `test/message-timing.test.js`, using the preload pattern from `test/idle-exists-runner.js` so a mocked imapflow is in place before `snail.js` loads. The mock emits `exists` and does not open a socket. The account name is `work`. The mailbox is `INBOX`. The password is `secret-token`. The webhook secret is `webhook-secret-token`. The message carries `body-token`, `subject-token`, and `from-token`. The webhook URL contains `url-token`. The live fetch returns status 204. Share one sequence array between the log callback and the start of `mailboxOpen`. Assert order in that array. Two equal timestamps are still ordered by position.
   - Catch-up, before any `exists` emit: uid 101 is fetched and written. The sequence has `fetch start mailbox INBOX uid 101`, `fetch end mailbox INBOX uid 101`, and `file write mailbox INBOX uid 101`, and no `exists` line.
   - Null fetch: uid 102 is in the catch-up range and `fetchOne` returns null. The sequence has `fetch start` and `fetch end` for uid 102 and no `file write` for uid 102.
   - Already present: uid 103 has a file `lookupExistingMessageFile` finds. The sequence has `fetch start` and `fetch end` for uid 103 and no `file write` for uid 103.
   - Uid 101 is below the notify boundary, so it is saved and not woken. It logs no webhook line.
   - Then emit `{ path: 'INBOX', count: 3, prevCount: 2 }` with no uid, and serve uid 104. The `exists` line is `exists mailbox INBOX path INBOX count 3 prevCount 2`. It appears before the next `mailboxOpen`. It does not match the token `uid`. Then `fetch start`, `fetch end`, and `file write` for uid 104 follow. Those three contain `mailbox INBOX` and `uid 104` and no `request` token. The `file write` line is after `renameSync` returns and before `notify ok`. Then the live webhook lines are exactly `webhook start mailbox INBOX uid 104 request <id> attempt 1` and `webhook response mailbox INBOX uid 104 request <id> attempt 1 status 204 duration <ms>`, with one generated `<id>` shared by both lines and `<ms>` a base-10 integer. Every other character matches. Then `notify ok uid 104 attempts`. `notify ok` gains no new fields. `webhook-secret-token` is absent from those lines.
   - One run uses mailbox `IN BOX` and emits path `A B`. The line contains `mailbox IN%20BOX` and `path A%20B`, and `uid` is the next token on the fetch line.
   - A second run emits `{ path: 'Archive', count: 1, prevCount: 0 }` while the mailbox is `INBOX`. The line is `exists mailbox INBOX path Archive count 1 prevCount 0`.
   - Call `notifyWebhook` with the injected id `req-1`, a `now` that advances 15 then 20, mailbox `INBOX`, and uid `104`. The first fetch returns status 500. The second returns status 204. The lines are `webhook start mailbox INBOX uid 104 request req-1 attempt 1`, `webhook response mailbox INBOX uid 104 request req-1 attempt 1 status 500 duration 15`, then the same pair for attempt 2 with status 204 and duration 20.
   - One `notifyWebhook` attempt never resolves before the attempt timeout. It logs `webhook start` and no `webhook response`.
   - `body-token`, `subject-token`, `from-token`, `secret-token`, `webhook-secret-token`, and `url-token` are absent from every `exists`, `fetch start`, `fetch end`, `file write`, `webhook start`, and `webhook response` line.
   - Read `snail.js` and `src/supervisor.js` and require the four statements in step 1. Read `test/supervisor.test.js` and require the `formatLogLine` test's `\.\d{3}Z` pattern.
7. Leave `AGENTS.md`, `REVIEW.md`, `package.json`, the release workflow, `src/notifiers/retry.js`, `src/notifiers/openclaw.js`, and every other intent folder unchanged. Leave existing `test()` bodies unchanged unless one fails only because a new line was added. In that case allow the new line and keep the previous expected text. Do not install anything. The test does not open a network socket.

DoD: `npm test` exits 0.
