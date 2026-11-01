# plan.md — IMAP integration harness

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 3 |
| Status | Draft 3 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. Do not start Phase 1 from the pull request that only adds `intent/imap-harness/`.

## Stops

Every push to the default branch runs `.github/workflows/release.yml`. Checked 2026-11-01: `v0.1.1` is the tag on `7342fedb2740a4e46b42d818d76968d12b0774f8`, and `scripts/release-version.sh` patch-bumps a squash merge whose subject ends in `(#N)` when the pull request has neither `release:minor` nor `release:major` (D6).

Merging this pull request would publish the next patch tag before the harness exists. While `v0.1.1` is the tip, that tag is `v0.1.2`. The v0.1.2 hotfix is a separate mocked exists unit test. It is not this pull request. Taking the tag here would publish an archive with no live harness.

Resolution: do not merge this pull request. Phase 1 waits until the v0.1.2 hotfix is on the default branch, then starts from that tip and brings `intent/imap-harness/` with it. That merge publishes the next patch after `v0.1.2` and contains the live suite (FR6). Do not split the suite across earlier merges. Do not add the mocked exists unit test to Phase 1.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against the spec. It does not edit.
4. Apply those findings the same way.
5. Start Phase 1 only after both reviews are applied and the owner says to build.

The spec-against-intent review is applied in spec Draft 2 (findings F1–F5), together with the live `EXISTS` scenario. The plan-against-spec review is applied in this draft (findings F1–F5). Spec Draft 3 amends FR14 so the reconnect `10000` is a recorded release and the pending `10000` is only the webhook budget. Do not start Phase 1. Phase 1 still waits until the v0.1.2 exists hotfix is on the default branch.

The pull request that only adds this folder is not a build phase. Phase 1 is one branch and one pull request. Squash-merge it only when the required checks `test` and `javascript` have succeeded. A cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` first start saves existing mail and does not wake | 1 |
| AC2 | `npm test` untagged `EXISTS` while `IDLE` stays open, real imapflow client, one save, one wake | 1 |
| AC3 | `npm test` resume, no duplicate, no gap, UIDVALIDITY change | 1 |
| AC4 | `npm test` UID `4294967295` after that boundary; scripted wide MODSEQ parsed then omitted; UIDVALIDITY `9007199254740993` on a SELECT imapflow accepts, throw `IMAP integer is not a safe integer`, sleep `5000`, next attempt `5000`, no state file and no message file | 1 |
| AC5 | `npm test` doubling reconnect records and releases `5000`, then `10000`, then `20000`; `UNAVAILABLE` and a recovered drop each record and release `5000`; that reconnect `10000` is not left pending | 1 |
| AC6 | `npm test` webhook file is on disk when the POST arrives; after the hang and after six `500`s, `lastUid` is that UID and a later sync does not write again; success leaves the webhook `10000` pending and posts once; bearer, raw, and one OpenClaw wake | 1 |
| AC7 | `npm test` account B wakes while account A's reconnect sleep is pending | 1 |
| AC8 | `npm test` a failure line that would contain the password, and one that would contain the notifier secret, each show `[redacted]` and neither secret; both secrets are inline and at least 8 characters; sockets stay on `127.0.0.1` | 1 |
| AC9 | `npm test` exits 0 | 1 |
| AC10 | `npm test` one keepalive fetches nothing, and the cancelled wait does not later count as `exists` | 1 |

## Phase 1 — Local IMAP harness

Files: `package.json`, `package-lock.json`, `snail.js`, `src/supervisor.js`, `test/imap-harness.test.js`, `intent/imap-harness/plan.md` only if a step departs from the spec

1. Add devDependency `imapkit` at 5.2.0 and refresh the lockfile. Confirm the smallest plugin set that satisfies FR2, including a `NAMESPACE` answer and no `STARTTLS` or `COMPRESS` capability. Record the set in this phase's build notes if it is more than IDLE and CONDSTORE.
2. Set `disableAutoIdle: true` on `createImapFlowClient` whenever the factory does not already pass it (FR2, D3). If the default branch does not already fulfill `idle()` on imapflow's `exists` event, add that fulfillment. Reject `idle()` when the socket drops or `IDLE` fails. `cancelIdle` leaves IMAP IDLE, and the cancelled promise stays ineligible for a later `exists` (D3, FR4). In `raceIdle`, await `cancelIdle` on the keepalive path and the stop path before the next `idle`. Leave `createFakeImapClient` in place. Do not add the v0.1.2 mocked exists unit test. This step still waits until that hotfix is on the default branch.
3. Add `test/imap-harness.test.js`. Each case starts imapkit on `127.0.0.1` port `0`, one server per account, and calls `startSupervisor` with `createImapFlowClient`. Arm the FR14 sleeper per case. The keepalive call is the default `idleKeepaliveMs` (`1740000`) and stays pending until the test releases it. Webhook success leaves `10000` pending and posts once. Webhook timeout resolves `10000`, then `1000`, `2000`, `4000`, `8000`, `16000`. The doubling reconnect path records and releases `5000`, then `10000`, then `20000`. `UNAVAILABLE` and a recovered drop each record and release `5000`. The one FR12 call stays pending. The password and the notifier secret are inline literals of at least 8 characters, so `resolve()` does not spend a `5000` on this sleeper (FR14, D8). Cover AC1–AC8 and AC10. The IDLE case emits an untagged `EXISTS` while `IDLE` stays open, with the real client connected (FR6, AC2). Use synthetic account names. For the wide MODSEQ, send `HIGHESTMODSEQ` and `FETCH` `MODSEQ` of `9223372036854775807` with a script rule and assert imapflow parsed that BigInt (FR9a, D4). Storage that rewrites it does not count. UID `4294967295` arrives only after `notifyBoundary` is already that value (FR9). Send UIDVALIDITY `9007199254740993` on a `SELECT` response imapflow's parser accepts. The throw is `IMAP integer is not a safe integer`. The recorded sleep is `5000`, and the next attempt is `5000` again. No state file and no message file are written (FR9a, FR10, D7). Script one failure whose unredacted message includes the password, and one whose message includes the notifier secret. Captured lines contain `[redacted]` and contain neither secret (FR13, AC8). When the webhook POST arrives, the `path` file is already on disk. After the hanging webhook, and after six `500` responses, state `lastUid` is that UID, and a later sync does not write the file again (FR11, P2, AC6).
4. Do not edit `intent/portable-mail/`, `intent/config-error-restart/`, or `intent/imap-bigint/`. Do not change backoff constants, notify delays, webhook keys, or the OpenClaw sentence. Do not add HMAC. Do not enable TLS on the harness socket. Do not add the mocked exists unit test. Do not add a personal name, email, hostname, or real account name.

DoD: `npm test` exits 0.

The phase pull request has neither `release:minor` nor `release:major`. Squash-merge it when `test` and `javascript` are green. That merge publishes the next patch after the v0.1.2 hotfix, and that tag contains the live harness (D6).
