# intent.md — Time a live message

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-02 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Live IDLE exists](../idle-exists/intent.md), [Portable mail](../portable-mail/intent.md) |

## Problem

A live message cannot be timed from the log. `starting`, `imap disconnected`, and `notify ok` already carry a millisecond timestamp. Nothing marks the IDLE `exists` wake, the start and finish of the message fetch, or the message file write, so the gap from wake to notify is one interval.

The webhook call sits inside that gap. `notifyWebhook` can post up to six times. The log shows `notify ok` or `notify failed` with the attempt count after the last try. Nothing marks when each request starts, or the status and duration when its HTTP response arrives.

## Proposed outcome

The phase adds six new log lines and leaves the timestamp format of every existing line as it is. The four message lines stay as already specified.

1. One line when an IDLE `exists` event wakes Snail, before the mailbox is reopened and before any fetch.
2. One line when that message's fetch starts.
3. One line when that fetch finishes, before the message file write.
4. One line for the message file write itself.
5. One line when a webhook request starts.
6. One line when that attempt's HTTP response arrives, with the status and the duration in milliseconds.

Both webhook lines carry the mailbox, the uid, a generated request id, and the attempt number. Retries share that id. The response line also carries the HTTP status and the duration in whole milliseconds. The id is generated for that wake. It is not derived from a secret or from personal data.

Fetch start, fetch end, and the file write already share the mailbox and the uid. `syncMessages` finishes one uid before the next, so those three lines correlate without a second id.

Each webhook attempt gets a start line. Each attempt whose HTTP response arrives gets a response line. A retry is timed on its own, not only the last attempt. A timeout or a thrown request has the start line and no response line.

`notify ok` stays the line after the notifier returns. A live message is the fetch and the write that follow the `exists` line, then the webhook lines, then `notify ok`. The same fetch and write calls also run for catch-up after connect; those calls log the per-message lines and do not log an `exists` line. A backlog uid is not woken, so it logs no webhook line.

The new lines use the timestamp prefix the existing lines already use. The phase adds these lines and a test that locks their fields. Save, wake, IDLE, and reconnect behavior stay as they are. No existing log line changes, including `notify ok`, `starting`, and `imap disconnected`.

Checked 2026-11-02 on `v0.1.8` (`46c1b0fc2527063b05386ce3c2bf94d21bbb09f2`):

- `formatLogLine` sets the prefix with `new Date().toISOString()` (`src/supervisor.js`). `notify ok` and `notify failed` go through that function as `notify ok uid <uid> attempts <n>` (and the failed sibling) under `[snail] [<account>]`. `imap disconnected` uses the same function. `starting` calls `new Date().toISOString()` directly (`snail.js`). `test/supervisor.test.js` already requires the prefix `YYYY-MM-DDTHH:mm:ss.sssZ`. That call already prints millisecond precision. The phase does not change it.
- imapflow 1.7.8 `untaggedExists` emits `exists` with `path`, `count`, and `prevCount`. The object has no uid. The IDLE listener in `snail.js` takes no argument and resolves with none. `raceIdle` turns that resolution into the string `exists`. The uid list is computed later from mailbox state and `uidNext` inside `syncMessages`.
- `syncMessages` calls `fetchOne` per uid, then `saveOneMessage`. The message file write is `writeFileSync` of that message's JSON. The rename that makes the file durable stays after that write. A fetch that returns nothing, and a save that finds the file already present, do not write.
- `notifyWebhook` posts inside `notifyWithRetries`. The first attempt is immediate. Five more follow delays of 1s, 2s, 4s, 8s, and 16s. Each attempt races the post with a 10s timeout. The supervisor calls `notifyWebhook` for the webhook notifier only, then logs `notify ok` or `notify failed`.

With neither `release:minor` nor `release:major`, the squash merge that contains this phase publishes `v0.1.9`.

## Affected users and systems

- **Users:** a person reading the running service log to time one live message.
- **Systems:** the IDLE `exists` listener in `snail.js`, `raceIdle` and `syncMessages` in `src/supervisor.js`, the message file write in `src/mail-store.js`, `notifyWebhook` and `notifyWithRetries`, `formatLogLine`, and the tests that lock log lines.

## Constraints and principles

- The decision is closed. The change is the four message lines already specified, plus the webhook start line and the webhook response line. The timestamp format of every existing line stays, including `notify ok`, `starting`, and `imap disconnected`. The four message lines stay as specified.
- Each new per-message line uses the `notify ok` shape: the existing `new Date().toISOString()` prefix, `[snail] [<account>]`, and `uid <n>`. It also names the mailbox the account has open. `notify ok` carries the account and `uid <n>`. The mailbox is absent from that line. The new lines add the mailbox in that same line.
- The `exists` line uses that same prefix and names that mailbox. It also includes the event fields the library actually emits: `path`, `count`, and `prevCount`. It has no uid. `uidNext` and any uid computed after the wake are not a substitute for an event uid.
- Fetch start, fetch finish, and the message file write each carry the mailbox and the uid of the message being fetched or written. One `exists` wake can be followed by more than one uid. Each uid gets its own fetch start, fetch finish, and, when the file is written, its own write line. Those three lines correlate by mailbox and uid. They do not get a request id.
- The new lines omit the message body, the subject, addresses, and secrets. The webhook lines also omit the URL, the request body, and response headers.
- Webhook start and webhook response use that same prefix and the same `mailbox` and `uid` form as the fetch lines. Both carry `request <id>` and `attempt <n>`. The id is one `crypto.randomUUID()` per wake, shared by that wake's retries. The attempt number starts at 1. The response line also carries `status <status>` and `duration <ms>`. Every attempt is logged, including a retry. Openclaw does not gain these lines.
- The `exists` line is only the IDLE wake. Catch-up does not emit it. Catch-up does emit the fetch and write lines, because those are the same calls.
- The write line is the message JSON write, not the state file and not a skipped save.
- This pull request starts as this file. The phase content is added here before any merge: [spec.md](spec.md), [plan.md](plan.md), and the log change with its test. The pull request stays open until that content is in it. It is not closed. Checked 2026-11-02: `v0.1.8` is `46c1b0fc2527063b05386ce3c2bf94d21bbb09f2` on the default branch. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`, so merging this file alone would publish `v0.1.9` without the log lines.
- This is a new intent. Other intent folders stay as they are.
- No deploy. Nothing is installed.

## Open questions (carried into spec.md)

None. The message lines, the webhook lines, the untouched existing timestamp format, the `exists` fields, and the release boundary above are decided. [spec.md](spec.md) records the exact line text and the test that locks it.

## Original prompt (verbatim)

> Draft only the intent for one ai-native phase on this repo (current release v0.1.8). Read the installed ai-native-sdlc skill, AGENTS.md, REVIEW.md, and the current log lines (notify ok, starting, imap disconnected) plus where EXISTS, fetch, and the message file write happen. Follow these private notes and do not copy them into the repo.
>
> Closed decision. Do not reopen it.
>
> Add finer log lines so a live message can be timed. At least:
> - one line when an IDLE push (EXISTS) wakes the process
> - one line when the message fetch starts and one when it finishes, before the file write
> - one line for the file write itself
>
> Each new line carries the mailbox and the uid the same way the existing notify ok line does. If the EXISTS event does not include a uid, say so in the intent and log the mailbox plus what the event actually has. Do not invent a uid. Do not log message bodies, subjects, addresses, or secrets.
>
> Also add millisecond precision to the existing log lines (including notify ok, starting, and imap disconnected) so every line uses the same clock. That call is already made.
>
> No personal names, emails, phone numbers, addresses, hostnames, or real resource identifiers. No deploy. Do not install anything. Do not add release:minor or release:major. Do not merge and do not close the pull request. A squash merge to main publishes the next patch, so this pull request stays open until the phase content is in it. Do not request a review. Bloom reviews when asked, later.
>
> Stop after the intent pull request exists. Do not write a spec, a plan, or code. Reply with the pull request URL and the intent path.

Follow-up in the same conversation:

> Correction to the logging intent. The Snail log already has millisecond timestamps. Do not change the timestamp format of any existing line, including notify ok, starting, and imap disconnected.
>
> Scope the intent to new log lines only:
> - one line when an IDLE push (EXISTS) wakes Snail
> - one line when the message fetch starts and one when it finishes, before the file write
> - one line for the file write itself
>
> Each new line carries the mailbox and the uid the same way notify ok does. If EXISTS does not include a uid, say so and log the mailbox plus what the event actually has. Do not invent a uid. Do not log bodies, subjects, addresses, or secrets.
>
> Follow the private notes. Do not copy them into the repo. Do not merge. Do not close the pull request. If a pull request already exists, revise that same one. Reply with the pull request URL and the intent path when the corrected intent is up.

Follow-up in the same conversation:

> Add webhook timing to the existing intent, spec, and plan on this pull request. Same pull request and same branch. Do not open a new pull request. Do not close this one. Do not merge. Do not write the code. Do not request a review.
>
> Scope to add, without changing existing timestamp formats or the four lines already specified:
> - a line when a webhook request starts
> - a line when the HTTP response arrives, with the status and the duration in milliseconds
> - both tagged with the mailbox and uid the same way notify ok is
> - retries included, so each attempt is timed, not only the last one
>
> Do not log secrets, bodies, subjects, addresses, or URLs that contain them. Follow the private notes and do not copy them into the repo. No personal names or real identifiers. No release:minor or release:major.
>
> Reply with the commit SHA when intent, spec, and plan all include this.

Follow-up in the same conversation:

> Add this to the same intent, spec, and plan on this pull request, together with the webhook timing if that is not in yet. Same pull request. Do not open a new one. Do not close this one. Do not merge. Do not write the code. Do not request a review.
>
> Webhook calls need a generated request id that is not derived from a secret or from personal data. The id appears on both the request-start line and the response line. Retries share that id and add an attempt number. The response line still has the HTTP status and the duration in milliseconds. Mailbox and uid stay on those lines too.
>
> Fetch start, fetch end, and the file write already correlate by mailbox and uid. Say that in the docs. Do not add a second id for them unless the code shows mailbox and uid are not enough.
>
> Do not change existing timestamp formats. Follow the private notes and do not copy them into the repo. No personal names or real identifiers. No release:minor or release:major.
>
> Reply with the commit SHA when intent, spec, and plan all include the request id, the attempt number, and the duration.
