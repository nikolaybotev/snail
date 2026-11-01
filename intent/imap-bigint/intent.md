# intent.md — IMAP BigInt and service script name

| | |
|---|---|
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md) |

## Problem

Snail saves nothing when imapflow hands the mailbox `uidValidity` back as a BigInt. `snail.js` passes that value through. `JSON.stringify` of the mailbox state then throws `Do not know how to serialize a BigInt`, and the account loop disconnects and connects again about every 6 seconds. The fake IMAP client in tests uses plain numbers, so CI never saw it. The same BigInt can reach the webhook payload's `uid_validity`, and any `uid`, `uidNext`, or `modseq` imapflow returns as a BigInt.

On macOS, Login Items shows the service wrapper's file name. That file is `scripts/run-service.sh`.

## Proposed outcome

A mailbox whose IMAP integers arrive as BigInt is saved and woken the same way as one whose integers arrive as numbers. The webhook payload's `uid` and `uid_validity` are numbers. Login Items shows `snail-service.sh`. Both changes ship in one patch release, `v0.1.1`.

## Affected users and systems

- **Users:** a person whose mail is watched by the service and who sees the service in macOS Login Items.
- **Systems:** imapflow, the per-account IMAP loop, the mailbox state file, the webhook notifier, the LaunchAgent plist, the systemd user unit, and the release workflow on the default branch.

## Constraints and principles

- The fix normalizes BigInt IMAP fields to `Number` at the imapflow boundary, and adds a regression test whose fake client returns BigInt. That is the whole integer fix.
- One phase. One merge to the default branch publishes both changes together, because every push there publishes the next patch tag. With no `release:minor` or `release:major` label, that tag is `v0.1.1`.
- The per-account error path already backs off. Leave that path unchanged.
- The launchd exit-2 mapping in `intent/config-error-restart/` (pull request 13) stays out. Renaming the wrapper keeps the script body it already has.
- Docs and examples in this change use placeholders only. No personal names, emails, hostnames, or machine paths.
- This is a new intent. `intent/portable-mail/` and `intent/config-error-restart/` stay as they are.

## Open questions (carried into spec.md)

None. [spec.md](spec.md) records the boundary (D1), the locked imapflow types (D2), the script rename (D3), the existing backoff (D4), and the `v0.1.1` release (D5).

## Original prompt (verbatim)

> Draft only. Do not implement the code fix. Do not merge. Do not deploy. Do not edit local-skills.
>
> On nikolaybotev/snail main, open one pull request whose only files are intent/imap-bigint/intent.md, spec.md, and plan.md. Follow the installed ai-native-sdlc templates. This is a new intent. Do not edit intent/portable-mail/ or intent/config-error-restart/. No personal names, emails, hostnames, or machine paths.
>
> Bug, already diagnosed: imapflow returns mailbox.uidValidity as a BigInt. snail.js passes box.uidValidity through unchanged. It reaches ensureMailboxState / initialSnailState, and JSON.stringify(state) in src/mail-store.js throws "Do not know how to serialize a BigInt". The account loop then disconnects and reconnects about every 6 seconds. Nothing is saved. The fake IMAP client in tests uses plain numbers, so CI never saw it. The same BigInt can affect the webhook payload's uid_validity and any uid, uidNext, or modseq imapflow returns as a BigInt.
>
> The fix is the smallest one: normalize those BigInt fields to Number at the imapflow boundary, plus a regression test where the fake client returns BigInt. One phase. A merge to main with no release:minor or release:major label should publish v0.1.1. Say that in the plan. Do not start the phase.
>
> Also read the reconnect path. If a thrown per-account error already backs off, say so and leave it out. If it reconnects immediately, record that as out of scope for this intent unless the same small change fixes it. Do not pull in the launchd exit-2 mapping (intent/config-error-restart/, pull request 13).
>
> Verify the line references against current main before they harden. Reply with the pull request URL and whether backoff is in or out.

Follow-up in the same conversation:

> Add this to the same intent, spec, and plan you are drafting. Do not open a second intent. Do not implement the code yet. Do not merge. Do not deploy.
>
> v0.1.1 is one merge to main, because every push to main publishes the next patch tag. The plan's single phase includes both changes so they publish together:
>
> 1. Normalize imapflow BigInt fields to Number at the boundary, with a regression test whose fake client returns BigInt. Same scope as before.
> 2. Rename scripts/run-service.sh to scripts/snail-service.sh. Update the launchd plist template, the systemd unit, the docs, and the tests. The reason: Login Items shows the script's file name. No personal names, hostnames, or real paths.
>
> Leave the launchd exit-2 mapping (pull request 13) and any separate backoff change out, unless you already recorded backoff as the same small change. Reply with the pull request URL.
