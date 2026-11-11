# plan.md — Durable notify delivery

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in the plan only. A closed plan shows | Status | Finished | in the header table.

This pull request adds `intent/durable-notify/` only. Do not merge it. Merging it would push the default branch and publish the next patch without the ledger (D8). Do not implement from this pull request. Do not deploy.

## Stops

None. The ledger file is D1. `lastUid` after the row is D2. The delay sequence is D3. `notify_id` is D4. The operator commands are D5. The log tokens are D6. The release boundary is D8.

## Build gate

1. A fresh-context review reads [spec.md](spec.md) against [intent.md](intent.md). It does not edit. The model is Grok 4.7 High.
2. Apply the findings that are right. Re-check any fact the review disputes.
3. A fresh-context review reads this file against the spec. It does not edit. The same model.
4. Apply those findings the same way.
5. Start Phase 1 only after both reviews are applied and the build is requested. Phase 1 uses Composer 2.5. If that model cannot be launched, stop and ask.

Phase 1 is a new branch from this branch, and one pull request. It contains this folder and the delivery change. Squash-merge that pull request only, and only when the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not merge while either required check is missing, pending, failed, or cancelled. Do not use an admin override. Do not add `release:minor` or `release:major`. That merge publishes the next patch (D8). This pull request stays unmerged.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` one message file, `lastUid` advanced, one ledger row, `status 400`, no second file, sleeper delays `1000` `2000` `4000` `8000` `16000` `60000` | 1 |
| AC2 | `npm test` restart after the row and `lastUid` are durable posts again, does not fetch that uid, does not write a second file | 1 |
| AC3 | `npm test` 2xx removes the row, logs `notify ok`, and a later turn does not post that `notify_id` | 1 |
| AC4 | `npm test` webhook `notify_id` is `{account}/{uid_validity}/{uid}` with no body; wake text ends with ` \| Id: ` plus that id; `webhook start` request id differs | 1 |
| AC5 | `npm test` one account's 10-second webhook sleeper stays pending while the other account saves and notifies; the backoff sleep stays on the blocked account | 1 |
| AC6 | `npm test` backlog uid has no row and no notify; a new `uidValidity` adds no row for resync saves and keeps an older row | 1 |
| AC7 | `npm test` `notify-list` line and exits 1 and 0; planted secret absent; no `security` or `op` spawn | 1 |
| AC8 | `npm test` redeliver queues a request, `lastUid` and the message file stay, a second post happens while the 29-minute sleeper stays pending; `/` and `..` exit 2; backlog and resync without a row are refused | 1 |
| AC9 | `npm test` a file already at or below `lastUid` with no row is quiet on startup; `notify-redeliver --file` for an eligible basename creates one row and posts once | 1 |
| AC10 | `npm test` README has the D7 section; `AGENTS.md` and `REVIEW.md` have the D7 sentences; the config example has no new key; `npm test` exits 0 | 1 |

`npm test` is `node --test`. Healthy: exit 0.

## Phase 1 — Durable notify delivery

Files: `src/notify-ledger.js` (new), `src/mail-store.js`, `src/supervisor.js`, `src/notifiers/webhook.js`, `src/notifiers/openclaw.js`, `snail.js`, `README.md`, `AGENTS.md`, `REVIEW.md`, `test/notify-ledger.test.js` (new), `test/notify-cli.test.js` (new), and the existing tests that lock six in-memory attempts: `test/supervisor.test.js`, `test/notifiers.test.js`, `test/imap-harness.test.js`, `test/message-timing.test.js`. `intent/durable-notify/plan.md` only if a step departs from the spec.

1. Add `src/notify-ledger.js`. Read and write `<mail_dir>/.snail-notify.json` as FR2: mode `0600`, temp name containing `.tmp-`, then rename. Upsert by `notify_id`. Export `notifyDelayMs` as D3. A missing file is an empty list. A write throws to the caller and does not leave the temp name in place of the ledger. Items carry only the FR2 fields. `next_attempt_at` is UTC ISO-8601 from the injected clock.
2. In `src/mail-store.js`, for a uid at or above `notifyBoundary`, after the message rename succeeds, write the ledger row and then persist `lastUid` when the uid is greater (FR3). Do this before returning to the caller that attempts notify. When the file already exists, the uid is above `lastUid`, and the uid is at or above `notifyBoundary`, write a missing row and then persist `lastUid`, and do not rewrite the message file. A uid at or below `lastUid` with no row stays without a row (D2, AC9). A backlog uid gets no row. A ledger write error logs `notify ledger failed uid <uid>`, leaves `lastUid`, and returns without an attempt flag. Intake state stays the four fields. Do not store ledger items on `.snail-state.json`.
3. In `src/supervisor.js`, stop calling `notifyWithRetries` on the production path. After FR3 says a row is due, run one webhook or OpenClaw attempt, then either remove the row and log `notify ok` or keep the row, set `last_status` and `next_attempt_at`, and log `notify failed` with the FR6 token (FR4, FR6). Race the soonest `next_attempt_at` with IDLE. On that wake, attempt each currently due row once and return to IDLE. Apply `<mail_dir>/.snail-notify-requests/` at account start and within one second while IDLE, cancelling IDLE for that attempt without resolving the 29-minute sleeper (FR8). Log `notify outstanding count` as FR6. Log `notify pending` when a row is first durable. Pass `notify_id` into the webhook body and the wake text (FR5). Keep `webhook start` and `webhook response`. Do not log the URL, headers, the secret, the subject, addresses, or a caught error string. One account's sleeper stays on that account (AC5). A `UIDVALIDITY` reset of intake state must not delete or replace the ledger (AC6). An unchanged reload does not clear the ledger and does not reconnect that account (D9).
4. In `src/notifiers/webhook.js`, append `notify_id` to the payload keys. Keep the 10-second budget, the 2xx check, and the redirect failure. One call performs one attempt. In `src/notifiers/openclaw.js`, extend `formatWakeText` with ` | Id: ` and `notify_id`. One wake call is one attempt. Leave the handshake as it is.
5. In `snail.js`, add `notify-list` and `notify-redeliver` as FR7 and FR8. Use the existing config load and its permission checks. Do not call the secret resolver and do not spawn `security` or `op`. Leave the daemon argv check as four entries: node, the script, `--config`, and the absolute path. Usage for a normal start stays `usage: snail --config /abs/config.toml`.
6. Update the tests named above. Replace expectations that production stops after `1000`, `2000`, `4000`, `8000`, `16000` with AC1 through AC9. Inject `now` and the sleeper so the `60000` delay is recorded and not waited out. Keep synthetic account names and the example file name `20261101T031500Z_42_0000000123.json`. Plant a secret and fail if it appears in the ledger, a request file, or the new log lines.
7. Add the D7 README section. Add the D7 sentences to `AGENTS.md` and `REVIEW.md`. Do not add a config key to `snail.example.toml`. Do not edit other intent folders, the service unit, the launchd wrapper, `package.json`, or the lockfile. Do not deploy.

DoD: `npm test` exits 0, and the required checks `test` and `javascript` have succeeded on the Phase 1 pull request.
