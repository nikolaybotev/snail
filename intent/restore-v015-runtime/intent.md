# intent.md — Restore v0.1.5 runtime

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Restore imported IDLE](../auto-idle/intent.md), [IDLE refresh](../idle-refresh/intent.md) |

## Problem

The default branch is tag `v0.1.6`. That tag is `48d152e`, the squash merge of pull request 21. Tag `v0.1.5` is `fa91b2f`. The running daemon on `v0.1.6` does not match the `v0.1.5` IMAP client.

On `v0.1.5`, `createImapFlowClient` sets `disableAutoIdle: true` and `maxIdleTime: IDLE_REFRESH_MS` (`4 * 60 * 1000`). Startup calls that factory with account and password only. `IDLE_REFRESH_MS` is exported. The harness production-options case requires both options. Two harness cases pass a third argument so `maxIdleTime` and `socketTimeout` stand in a fixed relationship. One case constructs imapflow itself and sets `disableAutoIdle: true`.

`v0.1.6` removed `IDLE_REFRESH_MS`, `disableAutoIdle`, and `maxIdleTime` from that factory. The third argument accepts `socketTimeout` only. The harness asserts that `maxIdleTime` is absent and that `IDLE_REFRESH_MS` is not exported. `AGENTS.md` and `REVIEW.md` describe that `v0.1.6` client. The review line treats `disableAutoIdle` or `maxIdleTime` on the production client as a bug.

## Proposed outcome

The running daemon matches tag `v0.1.5` again. The production client sets `disableAutoIdle: true` and `maxIdleTime` to `IDLE_REFRESH_MS`. Startup calls the factory with account and password only. `IDLE_REFRESH_MS` is exported. Tests that lock those IDLE options match the tag. The `AGENTS.md` and `REVIEW.md` sentences that describe this client match the tag in the same change.

The code change is one later phase and one later merge. With neither `release:minor` nor `release:major`, the normal release flow publishes that merge as `v0.1.7`.

## Affected users and systems

- **Users:** a person whose mailbox is watched by the running service.
- **Systems:** `createImapFlowClient` in `snail.js`, tests that lock its IDLE options, the IDLE sentences in `AGENTS.md` and `REVIEW.md`, and imapflow 1.7.8.

## Constraints and principles

- The decision in Proposed outcome is closed. The phase restores the `v0.1.5` production client.
- `intent/auto-idle/` stays the record of pull request 21. This intent does not rewrite that folder or any other intent folder.
- This pull request adds this file only. The code stays out. The pull request stays open and unmerged. Checked 2026-11-01: the default branch is `v0.1.6` at `48d152e`, and `v0.1.5` is `fa91b2f`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`, so merging this pull request would publish `v0.1.7` without the runtime restore.
- The later phase pull request carries neither `release:minor` nor `release:major`. That merge publishes `v0.1.7`.
- No deploy.
- Placeholders only. No personal names, emails, phone numbers, addresses, hostnames, machine names, or real mailbox names.
- This is a new intent.

## Open questions (carried into spec.md)

None. The restore target, the commit it undoes, and the `v0.1.7` release are closed above.

## Original prompt (verbatim)

> Draft only the intent for one ai-native phase on https://github.com/nikolaybotev/snail. Read the installed ai-native-sdlc skill, AGENTS.md, and REVIEW.md. Do not copy those notes into the repo.
>
> The phase restores main's runtime behavior to tag v0.1.5. v0.1.6, the squash merge of pull request 21 at 48d152e, is the change to undo. The normal release flow should publish that as v0.1.7. Do not add release:minor or release:major. Do not deploy.
>
> This repo is ai-native and autonomous. Open the intent the way the skill says. Stop after the intent pull request exists. Do not write a spec, a plan, or code. Do not merge. Do not close the pull request.
>
> No personal names, emails, phone numbers, addresses, or real resource identifiers in repo text or the pull request body. Reply with the pull request URL and the intent path.
