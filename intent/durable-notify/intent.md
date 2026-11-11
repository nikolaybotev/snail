# intent.md — Durable notify delivery

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-11 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md), [Time a live message](../message-timing/intent.md) |

## Problem

A notifier failure is forgotten once intake moves on. The webhook and OpenClaw paths try once immediately, then five more times after 1s, 2s, 4s, 8s, and 16s, all in memory. After that the account logs `notify failed` and persists `lastUid` past the uid. A later pass does not wake a uid at or below `lastUid`. A message file that already exists is not written again and is not woken. Nothing on disk still says the notify is owed, and there is no command to send it again.

Two webhook notifies failed with HTTP 400 after those six in-memory tries. `lastUid` had already moved. The recovery outside the program was to delete the saved JSON files, rewind `lastUid`, and restart.

## Proposed outcome

Mail intake stays exactly-once. The state file records what has been fetched and saved.

Snail is the sender of notifications, so notify delivery is at-least-once. That is the only guarantee the sender side can give. Only the recipient can guarantee exactly-once receipt and processing, by keeping a persistent store of what it has processed. As the recipient of mail from IMAP, Snail guarantees exactly-once arrival into its own queue, tracked in its state file.

Every saved message that should be woken has its notify recorded durably as pending until the notifier succeeds. The record survives restarts and keeps retrying with backoff. It is never dropped because `lastUid` moved. Intake progress and delivery progress are tracked separately.

Duplicate notifies are acceptable and expected. Each notify carries a stable id, account plus uid validity plus uid, or the saved file name, so a recipient can dedupe.

An operator can see what is pending or failed, and can redeliver one uid or one saved file, without deleting the message file or rewinding `lastUid`.

Pending and failed notifies show up in the log so a daily health check can spot them. The log does not include secrets, webhook URLs, or headers.

Docs state the semantics in those words: at-least-once out, exactly-once in, recipients dedupe.

Config secrets stay as they are. There is no new secret mechanism.

## Affected users and systems

- **Users:** a person who runs the service and reads its log, and a webhook or OpenClaw recipient that must tolerate a duplicate notify.
- **Systems:** the per-account intake state file, the save-then-wake path, both notifiers, the service log, and the operator commands on the same binary.

## Constraints and principles

- At-least-once is the notify contract. Exactly-once processing belongs to the recipient.
- Exactly-once intake stays. A notifier failure does not write a second message file and does not move `lastUid` backward.
- A pending notify is durable before `lastUid` advances past that uid, and it remains until the notifier succeeds.
- A backlog uid is not notified. A uid from a UIDVALIDITY resync is not notified.
- The message body, HTML, and attachment bytes stay out of every notifier.
- Secrets stay out of argv, logs, and files this program writes. Webhook URLs and header values stay out of the log. No new secret field and no new way to load a secret.
- One account's retry wait does not block another account.
- Placeholder examples only. No personal names, emails, hostnames, machine names, or real mailbox names.
- This pull request is the three files in this folder. It does not implement the delivery change, it does not merge, and it does not publish a release. Checked 2026-11-11: `v0.1.9` is `69555a3a5320f57c4a84f6cb4a236beb22144b39` on the default branch, and `.github/workflows/release.yml` runs on every push to that branch.
- This is a new intent. Other intent folders stay as they are.
- No deploy.

## Open questions (carried into spec.md)

None. [spec.md](spec.md) decides the ledger file (D1), when `lastUid` advances (D2), the retry schedule (D3), the stable id (D4), the operator commands (D5), the log lines (D6), and the release boundary (D8).

## Original prompt (verbatim)

> Open the intent/spec/plan PR for durable outbound notify delivery. Docs only this phase: do not implement, do not release, do not deploy.
>
> What happened: two webhook notifies failed with HTTP 400 after six in-memory retries, lastUid advanced anyway, and there was no way to resend. The hand fix was to delete the saved JSON files, rewind lastUid, and restart. Use generic examples.
>
> Requirement: at-least-once delivery is the only guarantee the sender side can give. Only the recipient can guarantee exactly-once receipt and processing by keeping a persistent store of what it has processed. Snail is the sender for notifications, so its notify semantics are at-least-once. As the recipient of mail from IMAP, it guarantees exactly-once arrival into its own queue, tracked in its state file.
>
> Outcome:
> - Mail intake stays exactly-once (state file tracks what has been fetched and saved).
> - Every saved message's notify is recorded durably as pending until a 2xx is received. It survives restarts and keeps retrying with backoff. It is never silently dropped because lastUid moved on. Intake progress and delivery progress are tracked separately.
> - Duplicate notifies are acceptable and expected. Carry a stable id (account + uid, or the file name) in each notify so recipients can dedupe.
> - A way to see what's pending or failed, and to redeliver a given uid or file manually.
> - Pending and failed notifies show up clearly in the log so a daily health check can spot them. Do not log secrets, webhook URLs, or headers.
> - Docs state the semantics plainly: at-least-once out, exactly-once in, recipients dedupe.
> - Config secrets stay untouched. No new secret mechanism.
>
> Branch from main. Put intent, spec, and plan in a new intent/ directory. Open one PR. In the PR body, say this is intent/spec/plan only and implementation follows review. Do not merge.
