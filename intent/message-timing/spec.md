# spec.md — Time a live message

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-02) |
| Status | Draft 1 |
| Stage | 2 · Design |

## 1. Summary

A live message cannot be timed from the log. `starting`, `imap disconnected`, and `notify ok` already carry a millisecond timestamp from `new Date().toISOString()`. Nothing marks the IDLE `exists` wake, the start and end of the message fetch, or the message file write.

This phase adds four log lines and leaves every existing line's timestamp format as it is. The `exists` line names the mailbox and the event's `path`, `count`, and `prevCount`. That event has no uid. The fetch start, fetch end, and file write lines name the mailbox and the uid the way `notify ok` names the uid. The lines omit the message body, the subject, addresses, and secrets.

The later commit on this pull request is the log change and its test. With neither `release:minor` nor `release:major`, the squash merge that contains that change publishes `v0.1.9`. This pull request stays open until that change is in it.

## 2. Goals and non-goals

**Goals**

- G1. An IDLE `exists` wake logs one line before the mailbox is reopened and before any fetch. The line carries the mailbox and the event's `path`, `count`, and `prevCount`. It carries no uid.
- G2. Each message fetch logs a start line and an end line. The end line is before the message file write. The message file write logs its own line after the JSON write returns and before the rename. Those three lines carry the mailbox and the uid.
- G3. A test locks the four lines, their order, and the absence of a uid on the `exists` line. `npm test` exits 0.

**Non-goals**

- Changing the timestamp format or the text of any existing log line, including `notify ok`, `notify failed`, `starting`, `imap disconnected`, and the mail-save failure line.
- Adding a timestamp to a line that does not already have one.
- Changing what is saved, woken, fetched, or reconnected.
- A second clock, or a timer finer than the millisecond prefix already in use.
- Editing other intent folders.
- A `release:minor` or `release:major` label.

**Release phasing.** This release is the four new lines. No later release is sequenced here. The plan and the log change land on this pull request before any merge. A squash merge of this pull request publishes `v0.1.9`.

## 3. Principles

- P1. Existing log lines keep the timestamp call they already make.
- P2. The four new lines use that same prefix: `new Date().toISOString()`, then `[snail] [<account>]`.
- P3. The `exists` line records the event it received. It does not borrow a uid from `uidNext` or from the later sync.
- P4. The new lines name the mailbox and, on the per-message lines, the uid. They omit the message body, the subject, addresses, and secrets.
- P5. Save, wake, and IDLE behavior stay as they are. The new lines are the only behavior this phase adds.

## 4. Users and scenarios

The service is connected and idle. A new message arrives. The log shows one `exists` line, then `fetch start`, `fetch end`, and `file write` for that uid, then the existing `notify ok` line. The timestamps are the prefix the daemon already prints. Two lines in the same millisecond stay in that order in the log.

The process starts with mail to catch up. Those fetches and writes log `fetch start`, `fetch end`, and `file write`. They do not log `exists`.

A fetch that returns nothing, or a save that finds the file already present, logs the fetch lines and does not log `file write`.

## 5. Functional requirements

- FR1. Checked 2026-11-02 on `v0.1.8` (`46c1b0fc2527063b05386ce3c2bf94d21bbb09f2`). `formatLogLine` (`src/supervisor.js` lines 44–48) sets the prefix with `new Date().toISOString()` and `[snail] [<account>]`. `notify ok` and `notify failed` are the message `notify ok uid <uid> attempts <n>` or `notify failed uid <uid> attempts <n>` (lines 257–258). `imap disconnected` is `imap disconnected: <message>` through the same function (line 357). `starting` is `${new Date().toISOString()} [snail] starting` (`snail.js` line 291). `test/supervisor.test.js` lines 687–689 require the prefix `YYYY-MM-DDTHH:mm:ss.sssZ`. Those statements stay. The phase does not replace the call, does not drop the fractional seconds, and does not add a timestamp to the mail-save failure line (`src/mail-store.js` line 427).
- FR2. Checked 2026-11-02 against imapflow 1.7.8 `lib/imap-flow.js` `untaggedExists`. The `exists` event object is `{ path, count, prevCount }`. It has no uid. `snail.js` lines 201–205 take no argument and `resolve()` with none. Line 224 registers that listener. `raceIdle` maps fulfillment to the string `exists` (`src/supervisor.js` line 442). The uid list is computed later in `syncMessages` from state and `uidNext` (lines 396–403). The `exists` line is emitted when that listener receives the event, before `resolve()` drops the argument, and before the `mailboxOpen` at line 334. `path`, `count`, and `prevCount` on the line are that event's own fields. `uidNext` is not printed as a uid.
- FR3. The full lines, with `<ts>` the existing `toISOString()` prefix and `<account>` the account name, are exactly:
  - `<ts> [snail] [<account>] exists mailbox <mailbox> path <path> count <count> prevCount <prevCount>`
  - `<ts> [snail] [<account>] fetch start mailbox <mailbox> uid <uid>`
  - `<ts> [snail] [<account>] fetch end mailbox <mailbox> uid <uid>`
  - `<ts> [snail] [<account>] file write mailbox <mailbox> uid <uid>`

  `<mailbox>` is the mailbox the account has open. `<path>` is the event's `path`. `<count>` and `<prevCount>` are the event's numbers in base 10, with no padding and no grouping. `<uid>` is the uid being fetched or written, in base 10 with no padding, the same spelling as `notify ok uid <uid>`. One space separates each token. The `exists` line has no `uid` token.
- FR4. `fetch start` is logged immediately before `fetchOne` (`src/supervisor.js` line 403). `fetch end` is logged when that call returns, including a null result, and before `saveOneMessage`. `file write` is logged after `writeFileSync` of the message JSON returns (`src/mail-store.js` line 416) and before `renameSync` (line 417). A throw from `fetchOne` logs no `fetch end` and no `file write` for that uid. An existing file, a `beforeWrite` that returns false, or a throw from `writeFileSync` logs no `file write`. The save-failed line stays as it is.
- FR5. One `exists` wake logs one `exists` line. Each uid from the existing sync, in the existing order, then logs `fetch start`, `fetch end`, and, when the JSON write returns, `file write`, before the next uid. `notify ok` for a woken uid stays after that uid's `file write`, and its text stays as in FR1. Catch-up through `syncMessages` after the initial open (lines 280–286) logs the per-message lines and does not log `exists`.
- FR6. The four lines omit the message body, the subject, addresses, secrets, and attachment bytes. A test message carries the sentinels `body-token`, `subject-token`, and `from-token`, and the account password is `secret-token`. None of those strings appear on the four lines.
- FR7. The test drives a live `exists` and a catch-up. The live case emits `{ path, count, prevCount }` with no uid, then sees the `exists` line before the following `mailboxOpen`, then `fetch start`, `fetch end`, `file write`, then `notify ok`, in that order. Order is the check when two timestamps are equal. The `exists` line matches FR3 and does not match a `uid` token. The catch-up case sees `fetch start`, `fetch end`, and `file write` and does not see `exists`. The account name in the test is `work`. The mailbox is `INBOX`. One live case uses event path `INBOX`. One case uses event path `Archive` with mailbox `INBOX`, and the line contains both strings in the FR3 positions. `npm test` exits 0. The run does not open a network socket.
- FR8. This pull request carries neither `release:minor` nor `release:major`. It stays open until the plan and the log change are in it. The squash merge that contains the log change publishes `v0.1.9`.

## 6. Acceptance criteria

| ID | Criterion | Check |
|---|---|---|
| AC1 | A live `exists` of `{ path: 'INBOX', count, prevCount }` with no uid logs the FR3 `exists` line before the next `mailboxOpen`. The line has `mailbox INBOX`, `path INBOX`, `count`, and `prevCount`, and no `uid` token. Then `fetch start`, `fetch end`, `file write`, and the unchanged `notify ok` follow in that order for that uid. | `npm test` |
| AC2 | An `exists` event with `path` `Archive` while the account mailbox is `INBOX` logs `mailbox INBOX` and `path Archive` in the FR3 positions. | `npm test` |
| AC3 | Catch-up logs `fetch start`, `fetch end`, and `file write` for the caught-up uid and logs no `exists` line. | `npm test` |
| AC4 | `body-token`, `subject-token`, `from-token`, and `secret-token` are absent from the four new lines. A null fetch and an already-present file log no `file write`. | `npm test` |
| AC5 | `formatLogLine uses UTC prefix and account tag` still requires `YYYY-MM-DDTHH:mm:ss.sssZ`. `notify ok uid <uid> attempts <n>`, `starting`, and `imap disconnected` keep the statements in FR1. `npm test` exits 0. | `npm test` |

## 7. Design decisions

**D1 — The timestamp format of existing lines stays.** Checked 2026-11-02 on `v0.1.8`. `new Date().toISOString()` already prints millisecond precision, and `test/supervisor.test.js` lines 687–689 lock that prefix. `notify ok`, `imap disconnected`, and `starting` already call it (FR1). The four new lines use that same prefix. Rejected: a new clock, a coarser prefix, and adding a timestamp to the mail-save failure line. That line is an existing line. This phase leaves it.

**D2 — The `exists` line has no uid.** Checked 2026-11-02 against imapflow 1.7.8 `untaggedExists`, which emits `{ path, count, prevCount }`. The listener at `snail.js` lines 201–205 discards that object, and line 442 keeps only the string `exists`. The uid is known later, from `uidNext` and `uidsToSync`. The line is written from the event argument before that reduction. `path`, `count`, and `prevCount` are copied from the event. Rejected: printing `uidNext`, the next uid, or a computed uid on this line.

**D3 — Mailbox and uid use the `notify ok` shape, and the mailbox is added.** `notify ok` carries the account in `[snail] [<account>]` and the uid as `uid <n>`. The mailbox is absent from that line (FR1). The per-message lines keep that prefix and that `uid <n>` spelling, and they add `mailbox <mailbox>` in the same label-then-value form. The `exists` line uses the same prefix and `mailbox <mailbox>`, then the event fields, and stops before a uid. Rejected: omitting the mailbox because `notify ok` omits it. Rejected: replacing the account name with the mailbox.

**D4 — The write line is after the JSON write returns and before the rename.** `saveOneMessage` writes, then renames, then wakes (`src/mail-store.js` lines 416–447). A line logged after `saveOneMessage` returns would follow `notify ok`. The `file write` line is between `writeFileSync` returning and `renameSync`. `fetch end` is before `saveOneMessage`. The test asserts log order, because two lines can share one millisecond. Rejected: comparing the timestamps with `<` as the only order check.

**D5 — One later merge on this pull request publishes `v0.1.9`.** Checked 2026-11-02. `v0.1.8` is `46c1b0fc2527063b05386ce3c2bf94d21bbb09f2`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. Merging this spec alone would publish `v0.1.9` without the log lines. This pull request stays open until the plan and the log change are in it.

## 8. Open questions

None. The four lines, the untouched existing timestamp format, and the `exists` fields are decided (D1–D4). The release boundary is D5.

## 9. What was checked

Checked 2026-11-02 on `v0.1.8` (`46c1b0fc2527063b05386ce3c2bf94d21bbb09f2`). No live IMAP server.

- `src/supervisor.js` lines 44–48, 257–258, 280–286, 330–345, 357, 396–425, and 442. `test/supervisor.test.js` lines 687–689.
- `snail.js` lines 201–205, 224, and 291. `src/mail-store.js` lines 411–427.
- imapflow 1.7.8 `lib/imap-flow.js` `untaggedExists` emits `{ path, count, prevCount }`.
- `.github/workflows/release.yml` runs on a push to the default branch. `scripts/release-version.sh` patch-bumps when neither release label is set. The current tag is `v0.1.8`, so the next patch is `v0.1.9`.
