# spec.md — Durable notify delivery

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-11) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

Mail intake stays exactly-once in `.snail-state.json`. Notify delivery becomes at-least-once in a separate `.snail-notify.json` ledger. A row is written before `lastUid` advances, survives restart, and retries with backoff until the notifier succeeds. Duplicate notifies are expected. Each one carries a stable `notify_id`. The operator can list outstanding rows and queue a redelivery. The log shows pending and failed rows without secrets, webhook URLs, or headers.

This pull request adds this folder only. The implementation pull request is later, after review. Merging this pull request would publish a release without that implementation (D8).

## 2. Goals and non-goals

**Goals**

- G1. Intake stays exactly-once. A notifier failure does not write a second message file and does not move `lastUid` backward.
- G2. Every notify that should be sent is durable until the notifier succeeds, survives restart, retries with backoff, and stays queued when `lastUid` advances.
- G3. Each notify carries a stable `notify_id`. Docs say at-least-once out, exactly-once in, and that recipients dedupe.
- G4. An operator can list pending and failed notifies and redeliver one uid or one saved file without rewinding `lastUid` or deleting the message file.
- G5. Pending and failed notifies are visible in the log for a daily check. The log has no secret, webhook URL, or header value.
- G6. Config secrets stay as they are. No new secret mechanism and no new config key.

**Non-goals**

- Exactly-once delivery. The recipient stores the `notify_id` values it has processed.
- Classifying, triaging, or sending mail.
- Waking a backlog uid, or a uid saved because `UIDVALIDITY` changed.
- Replaying every saved file that already sits at or below `lastUid` when this release is installed.
- A new secret field, a new resolver, or a new config key.
- Changing the OpenClaw handshake.
- Merging this pull request, publishing a release from it, or deploying.

**Release phasing.** The delivery change is one implementation phase in [plan.md](plan.md). This pull request is the design folder and stays unmerged. Nothing in this intent is postponed. A later idea starts a new intent folder.

## 3. Principles

- P1. Snail is the sender of notifications. At-least-once is the notify contract. The recipient is what makes processing exactly-once.
- P2. Snail is the recipient of IMAP mail. Exactly-once arrival into the saved queue stays in `.snail-state.json`.
- P3. Intake progress and delivery progress are separate records. Advancing `lastUid` does not delete, rewrite, or skip a ledger row.
- P4. The message file and the ledger row are both durable before a notify attempt. A backlog uid and a UIDVALIDITY-resync uid get neither a row nor an attempt.
- P5. A retry wait on one account does not run on another account's loop.
- P6. Secrets, webhook URLs, and header values stay out of the log, out of argv, and out of files this program writes. The message body stays out of every notifier.
- P7. The spec wins over the plan.

## 4. Users and scenarios

- A webhook returns 400 for a new message. One JSON file exists. `lastUid` includes that uid. `.snail-notify.json` still has the row. Later attempts continue with backoff. A restart posts again and does not write a second file.
- The same account receives another new message while the first row is still retrying. The new message is saved and gets its own row. The other account's IDLE, save, and notify continue.
- After a 2xx, or after an OpenClaw wake that resolves, the row is gone. A later pass does not post that notify again on its own.
- An operator runs `notify-list` and sees the failed uid, the file name, the attempt count, and the status token. `notify-redeliver` for that uid or that file queues an immediate attempt. The message file and `lastUid` stay as they are.
- A daily read of the log finds `notify failed` or `notify outstanding count` while a row remains. Those lines name the account and the uid. They do not name a URL, a header, or a secret.
- Installing this release does not notify again for files already checkpointed at or below `lastUid` with no ledger row. The operator uses `notify-redeliver` for a chosen file.
- A uid below `notifyBoundary`, and a save caused by a new `UIDVALIDITY`, still do not notify.

## 5. Functional requirements

Checked 2026-11-11 on `v0.1.9` (`69555a3a5320f57c4a84f6cb4a236beb22144b39`).

- FR1. **Baseline.** `.snail-state.json` is the intake record (`src/mail-store.js`). `readSnailState` returns only `uidValidity`, `notifyBoundary`, `backlogUid`, and `lastUid`. `writeSnailState` replaces the file with those fields through a temp name and `renameSync`, mode `0600`. `saveOneMessage` returns without waking when a file for that uid validity and uid already exists. A uid below `notifyBoundary` is saved, checkpoints `backlogUid`, and is not woken. A uid at or above the boundary is woken, and only then is `lastUid` set to it. `notifyWithRetries` (`src/notifiers/retry.js`) runs one attempt and then one attempt after each of `1000`, `2000`, `4000`, `8000`, and `16000` ms, then returns. The supervisor logs `notify ok` or `notify failed` once for that series and the wake result does not keep a row. `uidsToSync` fetches uids above `lastUid` and unfinished backlog, so a uid at or below `lastUid` is not fetched again. `buildWebhookBody` sends `account`, `from`, `subject`, `date`, `message_id`, `path`, `mailbox`, `uid`, and `uid_validity`. Success is HTTP 2xx inside 10 seconds. Redirect statuses are failures and are not followed. `formatWakeText` is `New email arrived. From: <from> | Subject: <subject> | File: <path>`. `parseCli` accepts `--version` and `--config` only. `usage: snail --config /abs/config.toml` is the usage line.

- FR2. **Ledger file.** Each account has `<mail_dir>/.snail-notify.json`, mode `0600`. The write is a temp file in the same directory whose name contains `.tmp-`, then `renameSync` over the ledger. The temp name is eligible for the existing leftover-temp cleanup. The ledger itself is not. Removing an account leaves the ledger on disk, the same way it leaves `.snail-state.json`. A `UIDVALIDITY` change rewrites the intake state and does not delete or replace the ledger. The ledger is not a message file. Its JSON is `{ "items": [ ... ] }`. Each item has only `notify_id`, `account`, `uid`, `uid_validity`, `file`, `attempts`, `last_status`, `next_attempt_at`, and `request_id`. No secret, URL, header, subject, address, or message body. A missing ledger is an empty item list. `notify_id` is the upsert key. A failed ledger write also uses `<mail_dir>/.snail-notify-ledger-retry.json` with the same item shape until the row is durable in `.snail-notify.json`.

- FR3. **When a row is created.** For a uid at or above `notifyBoundary` whose message file rename has succeeded: write or keep the ledger row, then persist `lastUid` when that uid is greater than `lastUid`. Both writes finish before any notify attempt. A crash after the message rename and before the ledger row leaves `lastUid` unmoved. The next sync sees the existing file, writes the missing row, then persists `lastUid`, and does not write a second message file. A uid at or below `lastUid` with no row is left alone. Upgrade does not walk old files to create rows. A backlog uid gets no row. A save under a new `UIDVALIDITY` gets no row. A ledger write error leaves `lastUid` unmoved, leaves the message file in place, enqueues the row in `.snail-notify-ledger-retry.json`, logs `notify failed uid <uid> attempts <n> status ledger`, and makes no notify attempt. Ledger retries use the same `notifyDelayMs` backoff and the same delivery race as notifier failures. They do not wait for the next IMAP sync or keepalive.

- FR4. **Attempt and retry.** The production path does not call `notifyWithRetries`. Each due row gets one attempt per delivery turn. The turn does not sleep the backoff. After a failure it stores `next_attempt_at` from the injected clock and `notifyDelayMs(attempts)`. `notifyDelayMs` is `1000`, `2000`, `4000`, `8000`, `16000` for attempts 1 through 5, and `60000` for attempt 6 and above. The first attempt is immediate: a new row stores `next_attempt_at` at or before the injected now. During intake, that first attempt runs after FR3's writes and before the next uid is fetched. Further attempts run on a delivery turn: account start, the moment the soonest `next_attempt_at` is due, or when a redeliver request is noticed. The account loop races IDLE with that due time the same way it races the 29-minute keepalive. A due turn attempts each currently due row once, then returns to IDLE. One account's sleeper is not another account's sleeper. Webhook rules that stay: one attempt budget of 10 seconds, success is HTTP 2xx, redirects are failures and are not followed, `webhook start` and `webhook response` stay as they are. OpenClaw success is the existing `wake` promise resolving. Any other outcome is a failure, including HTTP 400, any other non-2xx, timeout, a thrown request, and a wake rejection. Failure updates `attempts` and `last_status`, leaves the row, and does not change `lastUid` or the message file. Success removes the row with the same temp-and-rename write, then logs `notify ok`. A crash after the notifier succeeds and before the row is removed retries later. That duplicate is expected. If the removal write throws, the row stays, `notify ok` is not logged, and a later turn attempts again.

- FR5. **Stable id.** `notify_id` is `{account}/{uid_validity}/{uid}` in decimal uid validity and uid. `account` is the config name. The webhook JSON keeps the FR1 keys and adds `notify_id` after `uid_validity`. The wake text is the FR1 sentence plus ` | Id: {notify_id}`. The `request` id on `webhook start` and `webhook response` is the row's `request_id`, minted when the row is first created and stored on every durable notify retry for that uid. It is not `notify_id`. The `attempt` number on those lines is the 1-based notifier attempt for that row. The saved file name is the operator handle and is stored on the row as `file`. Recipients dedupe on `notify_id`. This intent supersedes portable-mail wake-once logging and replaces the webhook timing semantics in `intent/message-timing/` for production notify delivery.

- FR6. **Log lines.** New messages go through `formatLogLine`, so they keep the UTC prefix and `[snail] [<account>]`. The message text is:
  - `notify pending uid <uid> file <basename>` when a row is first made durable.
  - `notify failed uid <uid> attempts <n> status <token>` once per finished failed attempt, including each durable notifier try and each failed ledger write. `<token>` is the HTTP status digits, or `timeout`, `error`, `missing`, or `ledger`. A missing message file uses `missing` and keeps the row.
  - `notify ok uid <uid> attempts <n>` after the row is removed. This text stays the success line.
  - `notify outstanding count <n>` at account start when `n > 0`, on each 29-minute keepalive while `n > 0`, and whenever the count changes, including the change to `0`.
  - `notify redeliver uid <uid> file <basename>` when a request causes an immediate attempt.
  - `notify redeliver refused uid <uid> reason <reason>` when the daemon drops a request. `<reason>` is `backlog`, `resync`, or `missing`.

  These lines omit the webhook URL, every header name and value, the secret, the message body, the subject, and addresses. A caught request error is not interpolated into the log. `status error` covers it. `webhook start` and `webhook response` stay, including their status and duration, and still omit the URL and headers.

- FR7. **List.** `snail notify-list --config /absolute/path.toml` uses the same config permission, owner, and parse checks as startup. It does not connect to IMAP, does not resolve a secret, and does not spawn `security` or `op`. It prints one line per row, sorted by account name, then uid validity, then uid:

  `account <name> uid <uid> uid_validity <v> file <basename> state <pending|failed> attempts <n> last_status <token> next_attempt <iso>`

  `state` is `pending` when `attempts` is 0 and `failed` otherwise. `last_status` is `none` before the first finished attempt. A missing ledger prints nothing for that account. Exit 0 when every ledger is readable and the row count is 0. Exit 1 when the row count is greater than 0. Exit 2 on usage, on a config rejection, or when a ledger is unreadable. An unreadable ledger does not print that file's bytes. The command prints `notify ledger unreadable account <name>` on stderr for that account.

- FR8. **Redeliver.** `snail notify-redeliver --config /absolute/path.toml --account <name> --uid <uid>` or `--file <basename>`. The file argument is a basename matching `{YYYYMMDD}T{HHMMSS}Z_{uidValidity}_{uid}.json` with the uid padded to 10 digits. A value containing `/` or `..` exits 2 and writes no request. The command reads intake state and the message directory. It does not resolve a secret, does not rewrite `.snail-state.json`, and does not delete or rewrite a message file. It writes one request file under `<mail_dir>/.snail-notify-requests/` with mode `0600`, temp-and-rename, JSON `{ "file": "<basename>" }`. The daemon is the only writer of `.snail-notify.json`. It applies request files at account start and within one second while IDLE, without waiting for the 29-minute keepalive and without waiting for a new IMAP message. While IDLE, the one-second poll checks for request files and ends IDLE only when at least one request file is present; an empty poll does not call `cancelIdle`. Applying a request for an eligible file sets that row's `next_attempt_at` at or before now, creating the row when the file is eligible and no row exists. Eligible means the basename is in that account's mail directory, the parsed uid validity equals the current intake `uidValidity`, and the uid is at or above `notifyBoundary`. A basename whose uid validity is older is eligible only when a row for that `notify_id` already exists. Otherwise the daemon logs `notify redeliver refused` and deletes the request. `--uid` with more than one matching file exits 2 with `notify redeliver refused: ambiguous` and writes no request. A missing file, an unknown account, a missing intake state, a backlog uid, and a resync file without a row each exit 2 with `notify redeliver refused: <reason>` where reason is `missing`, `account`, `state`, `backlog`, or `resync`. Success prints `notify redeliver queued account <name> uid <uid> file <basename>` and exits 0. The HTTP or wake attempt happens in the daemon. A queued request waits until the daemon is running.

- FR9. **Secrets and config.** The config schema gains no key. Secret fields remain `password`, `webhook_secret`, and `openclaw_token`, resolved as they are now, once when the account loop starts. Retries use the in-memory cache. The daemon argv for a normal start stays `node`, the script, `--config`, and the absolute path. List and redeliver do not add a secret argument.

- FR10. **Docs and review notes.** README gains the section in D7, including the sentences that intake is exactly-once, notify delivery is at-least-once, duplicate notifies are expected, and the recipient stores `notify_id`. `AGENTS.md` gains the convention and prohibition sentences in D7. `REVIEW.md` gains the Bugs clause in D7. Other intent folders stay unchanged.

- FR11. **Tests.** `npm test` is `node --test`. Healthy: exit 0. Tests inject `now` and the sleeper. They do not wait 60 seconds of wall clock. IMAP and HTTP are the existing fakes. A planted secret string is absent from the ledger, from request files, and from the new log lines. CI stays `npm test` on Node 26. It does not call `op`, `security`, or a network IMAP server.

## 6. Acceptance criteria

| AC | What | Check |
|---|---|---|
| AC1 | A 400 that never becomes 2xx leaves one message file, advances `lastUid`, keeps one ledger row, logs `notify failed` with `status 400`, and a later sync does not write a second file. The sleeper records `1000`, then `2000`, `4000`, `8000`, `16000`, then `60000`. | `npm test` |
| AC2 | Stopping after the row and `lastUid` are durable, then starting again, does not fetch that uid again and does post again. The second start does not write a second message file. | `npm test` |
| AC3 | A 2xx removes the row, logs `notify ok uid <uid> attempts <n>`, and a later turn does not post that `notify_id` again. | `npm test` |
| AC4 | The webhook JSON contains `notify_id` equal to `{account}/{uid_validity}/{uid}` and omits `body`, `html_body`, and attachment content. The wake text ends with ` \| Id: ` plus that same id. The `request` token on `webhook start` is the row's stable `request_id`, not `notify_id`, and stays the same across durable retries. | `npm test` |
| AC5 | One account's webhook attempt leaves the 10-second sleeper pending. The other account still saves and notifies. The blocked account's backoff sleep is not applied to the second account. | `npm test` |
| AC6 | A uid below `notifyBoundary` creates no ledger row and no notify. A changed `uidValidity` creates no row for the resync saves and leaves an older row in place to retry. | `npm test` |
| AC7 | `notify-list` prints the FR7 line, exits 1 when a row exists, and exits 0 when none exist. A planted secret is absent from stdout, stderr, the ledger, and request files. The command does not spawn `security` or `op`. | `npm test` |
| AC8 | `notify-redeliver` for a failed uid queues a request, leaves `lastUid` and the message file unchanged, and the daemon posts again while the 29-minute sleeper stays pending. `--file` with `/` or `..` exits 2 and writes no request. A backlog uid and a resync file with no row are refused. | `npm test` |
| AC9 | A file already at or below `lastUid` with no ledger row is not notified on startup. `notify-redeliver --file` for that basename, when it is at or above the current boundary, creates one row and posts once. | `npm test` |
| AC10 | README contains the D7 section. `AGENTS.md` and `REVIEW.md` contain the D7 sentences. The config example gains no key. `npm test` exits 0. | `npm test` |

## 7. Design decisions

**D1 — Delivery lives in `.snail-notify.json`.** Checked 2026-11-11 on `v0.1.9`. `readSnailState` copies four fields (`src/mail-store.js` lines 92–97) and `writeSnailState` writes that object back (lines 108–114). A pending list stored on the intake file would disappear on the next `lastUid` write, which is the failure this change closes. The ledger is its own file, same mode and same temp-and-rename. An account removal still leaves mail files and intake state; it leaves the ledger too. A `UIDVALIDITY` rewrite of intake state does not truncate the ledger, so a notify owed from the previous generation is still sent.

**D2 — `lastUid` moves after the row is durable, not after notify success.** Checked 2026-11-11. Today `saveOneMessage` calls `onWake` and then updates `lastUid` (lines 447–458). An existing file returns with no wake and no `lastUid` change (lines 386–388). `uidsToSync` starts new mail at `lastUid + 1` (`src/supervisor.js` lines 93–96). This release writes the row first, then `lastUid`, then attempts. The existing-file branch creates the row only when the uid is still above `lastUid` and at or above `notifyBoundary`, which is the crash window between rename and checkpoint. Files already at or below `lastUid` are the installed baseline and are not replayed. Sending one of those again is `notify-redeliver`. Rewinding `lastUid` or deleting the message file is not the recovery path.

**D3 — One attempt per turn, then a capped backoff.** The in-memory series stops at six tries (`src/notifiers/retry.js` lines 3–27). That stop is what left the HTTP 400 with no further attempt. Production no longer uses that helper. The delay sequence keeps the same first five waits and then uses `60000`, the same cap as connect backoff, for every later attempt. The sleep is the time until the next turn, raced with IDLE, so intake of a later message is not stuck behind an unbounded retry, and another account is not stuck behind this one. HTTP 400 stays a retry. The status in the log is how the operator sees that it is still failing. A 2xx is the only webhook success. OpenClaw success stays "the wake promise resolved."

**D4 — `notify_id` includes uid validity.** Account plus uid is not stable across a `UIDVALIDITY` change: portable mail already treats that pair plus validity as the message identity, and the file name carries validity and uid. `notify_id` is `{account}/{uid_validity}/{uid}`. The file basename is the other handle, used by the operator commands. The webhook `request` id is the row's stable `request_id` for every durable retry. The `attempt` number counts notifier tries for that row. Duplicate delivery after a crash between success and row removal is allowed.

**D5 — The daemon is the only ledger writer.** List reads the ledger. Redeliver writes a request file. Two writers on the ledger would drop a row the same way a torn intake write would. The daemon watches for request files on a one-second poll that leaves IDLE up until a request is present, then applies it without waiting for the 29-minute keepalive. The CLI validates before it writes the request so a backlog uid, a slash in the file argument, or an unknown account never becomes a request. The daemon repeats the eligibility check. A request for a file that is no longer eligible is deleted and logged, so a bad file does not spin.

**D6 — Status tokens, not error text.** `webhook response` already logs a numeric status and a duration, and it does not log the URL. The outcome line gains `status <token>` so a daily search for `notify failed` shows the code. Timeout and throw have no response today; they use `timeout` and `error` and do not include the exception string, because that string can contain the URL. `notify outstanding count` is logged while rows remain, including on the 29-minute keepalive, so a quiet hour still shows the depth. The count is also logged when it changes, including to zero.

**D7 — Operator text.** README gains this section:

```markdown
## Notify delivery

Mail intake is exactly-once. `.snail-state.json` records what has been fetched and saved. A message file is written once.

Notify delivery is at-least-once. Snail is the sender. A saved message that should be woken stays in `.snail-notify.json` until the notifier succeeds. Moving `lastUid` does not drop that notify. A restart keeps retrying with backoff. Duplicate notifies are expected.

The recipient is what makes processing exactly-once. It stores each `notify_id` it has already processed. `notify_id` is `{account}/{uid_validity}/{uid}` on the webhook body and in the wake text.

Search the log for `notify failed` and `notify outstanding count`. Those lines name the account, the uid, and a status token. They do not include a webhook URL, a header, or a secret.

`snail notify-list --config /absolute/path/to/config.toml` prints outstanding notifies. Exit 0 means none. Exit 1 means one or more.

`snail notify-redeliver --config /absolute/path/to/config.toml --account ACCOUNT --uid UID` or `--file FILE` queues another attempt. It does not rewind `lastUid` and it does not delete the message file.
```

`AGENTS.md` Conventions gains this sentence: `Follow intent/durable-notify/spec.md and intent/durable-notify/plan.md for notify delivery.`

`AGENTS.md` Prohibitions gains these two bullets:

```markdown
- drops a pending notify because `lastUid` advanced, or deletes a pending notify without a successful notifier response;
- logs a webhook URL, an authorization header, or a secret;
```

`AGENTS.md` Things agents get wrong gains this bullet:

```markdown
- Treating `notify failed` as the end of delivery. The row stays in `.snail-notify.json` and retries until the notifier succeeds. `notify-redeliver` queues another attempt. Deleting the message file or rewinding `lastUid` is not the recovery.
```

`REVIEW.md` Bugs gains this clause: `dropping a pending notify when lastUid advances; deleting a notify row without notifier success; logging a webhook URL or an authorization header`.

**D8 — This pull request does not merge.** Checked 2026-11-11. `v0.1.9` is `69555a3a5320f57c4a84f6cb4a236beb22144b39`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. Merging this folder alone would publish the next patch without the ledger. The implementation is one later pull request, branched from this branch after the build gate in [plan.md](plan.md). That pull request carries neither label. Its squash-merge publishes the next patch and is the merge that contains the delivery change. No deploy.

**D9 — What this release leaves in place.** Body, HTML, and attachment bytes stay out of both notifiers. Backlog and UIDVALIDITY-resync saves still do not notify. One account still does not block another. Config permissions, live reload, and secret resolution stay as specified for portable mail. A reload that restarts an account reloads the ledger from disk and does not clear it. An unchanged account is not reconnected and is not re-notified for rows already removed. `webhook start` and `webhook response` stay. The service unit and the launchd wrapper stay.

## 8. Open questions

None.

## 9. What was checked

Checked 2026-11-11 on `v0.1.9` (`69555a3a5320f57c4a84f6cb4a236beb22144b39`).

- `src/mail-store.js`: four-field state read and write, skip when the file exists, backlog without wake, `lastUid` after `onWake`.
- `src/notifiers/retry.js`: five delays and then stop.
- `src/notifiers/webhook.js`: payload keys, 10-second budget, 2xx, redirects not followed.
- `src/notifiers/openclaw.js`: wake sentence and `notifyWithRetries`.
- `src/supervisor.js`: `uidsToSync`, `formatLogLine`, one `notify ok` or `notify failed` after the retry helper.
- `snail.js`: `parseCli` flags. `src/config.js`: usage line.
- `.github/workflows/release.yml` on push to the default branch, and `scripts/release-version.sh` patch bump without `release:minor` or `release:major`.

## 10. Models

Spec, plan, and fresh-context review: Grok 4.7 High. Build: Composer 2.5. Do not substitute. If one of those models cannot be launched, stop and ask.
