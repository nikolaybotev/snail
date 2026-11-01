# intent.md — Restore imported IDLE

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Live IDLE exists](../idle-exists/intent.md), [IMAP harness](../imap-harness/intent.md), [IDLE refresh](../idle-refresh/intent.md) |

## Problem

On v0.1.5 the production imapflow client turns auto-IDLE off and sets `maxIdleTime`. The imported client did neither, and pull request 16's spec rejected both.

The imported single-file client (`3cb0e2f`, `snail.js` lines 332–341) constructs imapflow with host, port, secure, auth, and `logger: false`. Auto-IDLE stays at the library default. That constructor does not set `disableAutoIdle` or `maxIdleTime`. The IDLE wait listens for `exists`, `close`, and `error`, and starts `client.idle()` beside that wait (lines 364–373).

Pull request 16 merged `intent/idle-exists/spec.md` (`aad6cf3`, v0.1.2). Its non-goals and D2 reject `disableAutoIdle` and `maxIdleTime`. FR1 records that the import has neither. FR5 says that release does not set them. v0.1.1's `createImapFlowClient` (`7342fed`, then lines 124–130) still passed host, port, secure, auth, and `logger: false` only.

Commit `8db6c3c` (pull request 17, v0.1.3) set `disableAutoIdle: true` on `createImapFlowClient`. The harness plan's phase step tells that factory to set it. The harness spec's D3 records why: imapflow auto-IDLE would start an IDLE the adapter does not own, and the harness needed the IDLE session held still.

v0.1.5 (`fa91b2f`) kept `disableAutoIdle: true` and added `maxIdleTime: IDLE_REFRESH_MS` (`4 * 60 * 1000`) in `createImapFlowClient` (`snail.js` lines 135–136). Startup calls that factory with account and password only (`snail.js` line 297), so both options are on the production path. The harness default factory is the same two-argument `createImapFlowClient` (`test/imap-harness.test.js` line 215). Its production-options case requires `disableAutoIdle === true` and `maxIdleTime === IDLE_REFRESH_MS`. Two other cases pass a third argument to force a `maxIdleTime` relationship. One case constructs imapflow itself and sets `disableAutoIdle: true`.

`AGENTS.md` and `REVIEW.md` currently tell agents to keep `maxIdleTime` whenever `disableAutoIdle` is set. That note describes v0.1.5.

## Proposed outcome

The production client, and every test that stands in for it, uses the imported client's IDLE behavior. Auto-IDLE stays on. `disableAutoIdle` exists only as an opt-in a specific test sets when that test must hold the IDLE session still. The production path does not set it.

`maxIdleTime` leaves the production client when a short-clock harness run with auto-IDLE on shows no `Socket timeout` across several quiet periods and still saves one live EXISTS. When that proof fails, the phase stops and reports. This intent prescribes no other timer.

The code change is one later merge. With neither `release:minor` nor `release:major`, that merge publishes `v0.1.6`.

## Affected users and systems

- **Users:** a person whose mailbox is watched by the running service.
- **Systems:** `createImapFlowClient` in `snail.js`, tests that call that factory the way startup does, the local IMAP harness, imapflow 1.7.8, and the `disableAutoIdle` / `maxIdleTime` sentences in `AGENTS.md` and `REVIEW.md`.

## Constraints and principles

- The decision in Proposed outcome is closed. Auto-IDLE stays on for the production client and for any test standing in for production.
- A test stands in for production when it calls `createImapFlowClient` the way startup does: account and password, and no third-argument override of IDLE options.
- `disableAutoIdle` is an opt-in that one specific test sets when it must hold the IDLE session still. Startup, the two-argument factory, and the config file leave it unset.
- The proof is one short-clock harness run with auto-IDLE on: no `Socket timeout` across several quiet periods, and one live EXISTS saved. A wall-clock wait of 10 minutes is not the proof.
- A failed short-clock proof stops the phase and names no other timer workaround. A failed proof does not merge.
- When the proof passes, `maxIdleTime` is off the production path, and the `AGENTS.md` and `REVIEW.md` sentences that require it beside `disableAutoIdle` change in that same change.
- This pull request adds only this file. `spec.md`, `plan.md`, and code stay out. It stays unmerged. Every push to the default branch runs the release workflow. Checked 2026-11-01: `v0.1.5` is `fa91b2f`, and `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`, so merging this pull request would publish `v0.1.6` without the client change.
- The later phase pull request also carries neither `release:minor` nor `release:major`.
- Placeholders only. No personal names, emails, hostnames, machine names, or real mailbox names.
- This is a new intent. Other intent folders stay as they are.
- No deploy.

## Open questions (carried into spec.md)

1. Which single test, if any, must hold the IDLE session still and therefore opts into `disableAutoIdle`. The production path leaves it unset.
2. Which short-clock lengths count as several quiet periods, and how that harness run shows one saved live EXISTS. The pass rule and the stop are already decided.
3. What remains of the v0.1.5 harness cases that lock `maxIdleTime` and `disableAutoIdle` on the production factory. Those cases stop requiring the production path to set either option.

## Original prompt (verbatim)

> Draft only the intent for a small patch on https://github.com/nikolaybotev/snail (base main, current release v0.1.5). Follow AGENTS.md and the repo's intent process. Read the imported client behavior, #16's spec (it rejected disableAutoIdle and maxIdleTime), #17 commit 8db6c3c (where disableAutoIdle: true entered for the harness), and the current createImapFlowClient / harness. Stop after the intent pull request exists. Do not write a spec, a plan, or code. Do not merge. Do not deploy.
>
> Decision, already made: the production client and any test standing in for production go back to the imported client's IDLE behavior. Auto-IDLE stays on. disableAutoIdle may exist only as an opt-in a specific test sets when it must hold the IDLE session still. The production config path must not set it. Drop maxIdleTime if a short-clock harness run with auto-IDLE on shows no Socket timeout across several quiet periods and still saves one live EXISTS. If that proof fails, the intent says the phase stops and reports; it does not prescribe another timer workaround.
>
> No personal names, emails, hostnames, or real mailbox names in repo text. Do not add release:minor or release:major. Reply with the PR URL and the intent path.
