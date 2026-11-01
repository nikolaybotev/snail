# intent.md — Live IDLE exists

| | |
|---|---|
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md) |

## Problem

On v0.1.1 a new message is not saved and not notified while the IMAP connection stays open. The same message is saved and notified on the next process start. The server is Dovecot. The imported single-file daemon, the scrubbed import on main before the multi-account rewrite, did pick up live mail during IDLE. That path is a regression.

## Proposed outcome

Mail that arrives while the connection is open is saved and notified without a process restart. Mail that arrives while the process is down is still saved and notified on the next start. The code change is one later merge. With neither `release:minor` nor `release:major`, that merge publishes `v0.1.2`.

## Affected users and systems

- **Users:** a person whose mailbox is watched by the running service.
- **Systems:** the imapflow adapter, the per-account IDLE loop, the saved-message files, the notifier, and a Dovecot IMAP server.

## Constraints and principles

- The fix is the smallest one that restores live pickup, plus a unit regression test where a mocked imapflow emits `exists`.
- This pull request is the draft only. It does not implement the fix, and it stays unmerged. A merge to the default branch publishes the next patch tag.
- The launchd exit-2 fix stays out. The IMAP harness stays out. Harness pull request 15 later adds a live IDLE scenario; that scenario is not work for this phase.
- Docs and examples in this change use placeholders only. No personal names, emails, hostnames, machine names, or real account names.
- This is a new intent. Other intent folders stay as they are.

## Open questions (carried into spec.md)

None. [spec.md](spec.md) records the regression (D1), the wait (D2), the test (D3), and the `v0.1.2` release (D4).

## Original prompt (verbatim)

> Diagnose first, then draft only. Do not implement the code. Do not merge. Do not deploy. Do not edit local-skills. No personal names, emails, hostnames, or real account names.
>
> On nikolaybotev/snail main (v0.1.1), find why a new message is not saved or notified while an IMAP connection stays open, but the same message is saved and notified on the next process start. Read the IDLE path, the exists event, and the fetch-after-IDLE path in snail.js and src/supervisor.js. The server is Dovecot. Reply with the root cause first, citing the file and the line.
>
> Then open one pull request whose only files are intent/idle-exists/intent.md, spec.md, and plan.md. Follow the installed ai-native-sdlc templates. Do not edit other intent folders. One phase: the smallest fix, plus a unit regression test where a mocked imapflow emits exists. Do not build that phase. This pull request must stay unmerged, because a merge to main publishes the next patch tag. The later code merge, with no release:minor or release:major label, is v0.1.2.
>
> Do not pull in the launchd exit-2 fix or the IMAP harness. The harness pull request 15 should later add a live IDLE scenario; say that in this plan as out of scope, not as work for this phase.

Follow-up in the same conversation:

> Added constraint. The imported single-file snail.js, the scrubbed import on the history of main before the multi-account rewrite, is a known-good baseline: it did pick up live mail during IDLE. Diff the connected loop and imapflow event handling between that file and v0.1.1. Cover exists and IDLE setup, any polling or NOOP, the mailbox lock and the fetch after an exists event, and the imapflow version and options. The root cause you report, and the spec, should name that regression. Do not put hostnames, machine names, or personal names in the repo. Do not implement the code. Do not merge.
