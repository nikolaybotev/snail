# intent.md — IDLE refresh

| | |
|---|---|
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [IMAP harness](../imap-harness/intent.md) |

## Problem

On v0.1.4 the daemon logs `imap disconnected: Socket timeout` about every 10 minutes. The TCP connection to port 993 is still established when that line is written, and the process then reconnects. The process is not crash-looping. Mail that arrives is still saved and notified after a later reconnect. The guess was that IDLE is never refreshed: no `DONE` plus a new `IDLE`, and no `NOOP`, before the server or the socket times out.

## Proposed outcome

An open connection keeps IDLE alive across the point where that log line appears today. Mail that arrives while the connection is open is saved and notified without waiting for the reconnect. The code change is one later merge. With neither `release:minor` nor `release:major`, that merge publishes `v0.1.5`.

## Affected users and systems

- **Users:** a person whose mailbox is watched by the running service.
- **Systems:** the imapflow adapter in `snail.js`, the per-account IDLE loop in `src/supervisor.js`, imapflow 1.7.8, and the local IMAP harness.

## Constraints and principles

- The fix is the smallest one that refreshes IDLE before the timeout, plus a regression test.
- Reproduce the failure in the existing IMAP harness when that is practical. A wall-clock wait of 10 minutes is not required when the same timer relationship can be shown on a short clock.
- This pull request is the draft only. It does not implement the fix, and it stays unmerged. A merge to the default branch publishes the next patch tag.
- Docs and examples in this change use placeholders only. No personal names, emails, hostnames, machine names, or real mailbox names.
- This is a new intent. Other intent folders stay as they are.

## Open questions (carried into spec.md)

None. [spec.md](spec.md) records the cause (D1), the refresh (D2), the harness test (D3), and the `v0.1.5` release (D4).

## Original prompt (verbatim)

> Diagnose, open one GitHub issue, and draft only. Do not implement the code. Do not merge. Do not deploy. Do not edit local-skills. No personal names, emails, hostnames, machine names, or real mailbox names anywhere in the issue or the repo.
>
> On nikolaybotev/snail main (v0.1.4), verify this report: the daemon logs "imap disconnected: Socket timeout" about every 10 minutes while a connection to port 993 stays established, then reconnects. The process is not crash-looping. Mail that arrives is still saved and notified after a later reconnect. The guess is that IDLE is not refreshed (no DONE plus a new IDLE, and no NOOP) before the server or the socket times out. Read the connected loop, IDLE setup, any keepalive or maxIdleTime, and the imapflow version. Compare with the imported single-file snail.js if that still shows a refresh the rewrite dropped. Name the cause.
>
> Open a public issue on nikolaybotev/snail with that generic symptom and the verified cause. No operational timeline, no mailbox name.
>
> Then open one pull request whose only files are intent/idle-refresh/intent.md, spec.md, and plan.md. Follow the installed ai-native-sdlc templates. Do not edit other intent folders. One phase: the smallest fix, plus a regression test. Reproduce it in the existing IMAP harness if that is practical; otherwise a unit test that shows IDLE is refreshed before a 10-minute deadline. Say which, and why. Do not start the phase. This pull request must stay unmerged, because a merge to main publishes the next patch tag. The later code merge, with no release:minor or release:major label, is that release.
>
> Reply with the root cause, the issue URL, and the pull request URL.
