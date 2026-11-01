# plan.md — IMAP integration harness

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. Do not start Phase 1 from the pull request that only adds `intent/imap-harness/`.

## Stops

Every push to the default branch runs `.github/workflows/release.yml`. Checked 2026-11-01: `v0.1.1` is the tag on `7342fedb2740a4e46b42d818d76968d12b0774f8`, and `scripts/release-version.sh` patch-bumps a squash merge whose subject ends in `(#N)` when the pull request has neither `release:minor` nor `release:major` (D6).

Merging this pull request would publish the next patch tag before the harness exists. That tag is hard to treat as the harness release, because the archive would not contain the suite.

Resolution: do not merge this pull request. Phase 1 is branched from this branch so `intent/imap-harness/` lands in the same merge as the harness. That merge is the one that publishes the next patch, and the patch contains the finished harness. Do not split the suite across earlier merges.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against the spec. It does not edit.
4. Apply those findings the same way.
5. Start Phase 1 only after both reviews are applied and the owner says to build.

The pull request that only adds this folder is not a build phase. Phase 1 is one branch and one pull request. Squash-merge it only when the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` first start saves existing mail and does not wake | 1 |
| AC2 | `npm test` IDLE arrival saves once and wakes once, webhook or OpenClaw | 1 |
| AC3 | `npm test` resume, no duplicate, no gap, UIDVALIDITY change | 1 |
| AC4 | `npm test` safe large UID and UIDVALIDITY, wide MODSEQ absent, unsafe UIDVALIDITY writes nothing | 1 |
| AC5 | `npm test` drop, bad password, and UNAVAILABLE use the FR10 delays | 1 |
| AC6 | `npm test` webhook timeout, HTTP 500, bearer, raw, and one OpenClaw wake | 1 |
| AC7 | `npm test` account B wakes while account A's reconnect sleep is pending | 1 |
| AC8 | `npm test` logs omit secrets and sockets stay on `127.0.0.1` | 1 |
| AC9 | `npm test` exits 0 | 1 |

## Phase 1 — Local IMAP harness

Files: `package.json`, `package-lock.json`, `snail.js`, `src/supervisor.js`, `test/imap-harness.test.js`, `intent/imap-harness/plan.md` only if a step departs from the spec

1. Add devDependency `imapkit` at 5.2.0 and refresh the lockfile. Confirm the smallest plugin set that satisfies FR2, including a `NAMESPACE` answer and no `STARTTLS` or `COMPRESS` capability. Record the set in this phase's build notes if it is more than IDLE and CONDSTORE.
2. In `createImapFlowClient`, set `disableAutoIdle: true`. Fulfill `idle()` on imapflow's `exists` event. Reject it when the socket drops or `IDLE` fails. Add `cancelIdle` that leaves IMAP IDLE without counting as new mail (D3). In `raceIdle`, await `cancelIdle` on the keepalive path and the stop path before the next `idle`. Leave `createFakeImapClient` in place.
3. Add `test/imap-harness.test.js`. Each case starts imapkit on `127.0.0.1` port `0`, one server per account, and calls `startSupervisor` with `createImapFlowClient`. Pass the existing sleeper injection. Cover AC1–AC8. Use synthetic account names and inline synthetic secrets. Assert captured logs do not contain those secrets (AC8). For FR9, use storage or `resetUidValidity` when imapkit 5.2.0 accepts the integer, and a script `send` that imapflow parses when it does not (D4). The unsafe UIDVALIDITY case must throw `IMAP integer is not a safe integer`.
4. Do not edit `intent/portable-mail/`, `intent/config-error-restart/`, or `intent/imap-bigint/`. Do not change backoff constants, notify delays, webhook keys, or the OpenClaw sentence. Do not add HMAC. Do not enable TLS on the harness socket. Do not add a personal name, email, hostname, or real account name.

DoD: `npm test` exits 0.

The phase pull request has neither `release:minor` nor `release:major`. Squash-merge it when `test` and `javascript` are green. That merge publishes the next patch tag, and that tag contains the harness (D6).
