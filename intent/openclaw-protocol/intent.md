# intent.md — OpenClaw protocol 4

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-26 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md), [Durable notify](../durable-notify/intent.md) |

## Problem

v0.1.11 saves mail. It cannot wake an OpenClaw gateway that speaks WebSocket protocol 4. Portable mail kept the imported handshake: the connect params in `src/notifiers/openclaw.js` advertise `minProtocol` 3 and `maxProtocol` 3. The gateway rejects that handshake before auth (`failurePhase=auth`, `failureCause=protocol-mismatch`). Durable notify leaves the pending row in place until the notifier succeeds, so the ledger keeps retrying.

## Proposed outcome

The OpenClaw notifier connects to a gateway on protocol 4 and still accepts a gateway on protocol 3. A regression test for protocol negotiation asserts that the advertised range covers the current gateway protocol, so a client pinned below that protocol cannot ship. The next patch, `v0.1.12`, is that protocol change.

## Affected users and systems

- **Users:** a person whose saved mail should wake an OpenClaw gateway on protocol 4, and a gateway that still speaks protocol 3.
- **Systems:** the OpenClaw connect handshake in `src/notifiers/openclaw.js`, the handshake test in `test/notifiers.test.js`, the notify ledger, and the release job on the default branch.

## Constraints and principles

- The recorded change raises `maxProtocol` in the connect params of `src/notifiers/openclaw.js` from 3 to 4, keeps `minProtocol` at 3, and leaves the rest of the handshake as it is. That change was tried against a gateway that expects protocol 4, and the connect proceeded.
- The regression test asserts the advertised range covers the current gateway protocol. Checked 2026-11-26 on `v0.1.11`: `src/notifiers/openclaw.js` sets both bounds to 3, and `test/notifiers.test.js` asserts `minProtocol` 3 and `maxProtocol` 3.
- Mail stays saved. The ledger keeps retrying until the notifier succeeds. A rejected handshake leaves the pending notify in place.
- The wake stays metadata only. The body stays out of the notifier. Secrets, the gateway token, webhook URLs, and authorization headers stay out of argv, logs, and files this program writes.
- This file records the outcome and the release boundary. Spec, plan, and the protocol change are later pull requests.
- This pull request stays unmerged. Its only file is this intent. It carries neither `release:minor` nor `release:major`.
- Checked 2026-11-26: tag `v0.1.11` and `origin/main` are commit `b6ba3291c682cfa25f6fa1b4b25265dab22b892e`. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. Merging this file would publish `v0.1.12` without the protocol change. `v0.1.12` is that protocol fix.
- Placeholders only. No personal names, emails, hostnames, or machine paths.
- This is a new intent. Other intent folders stay as they are.
- No deploy.

## Open questions (carried into spec.md)

None. The protocol range, the rest of the handshake, the regression test, and the `v0.1.12` boundary are stated above. Later spec and plan pull requests record them.

## Original prompt (verbatim)

> v0.1.11 saves mail and cannot wake an OpenClaw gateway that speaks WebSocket protocol 4. The gateway rejects the connect handshake before auth (failurePhase=auth, failureCause=protocol-mismatch). The client advertises minProtocol 3 and maxProtocol 3. The gateway expects 4. The notify ledger keeps retrying.
>
> Outcome: the OpenClaw notifier connects to gateways on protocol 4 and still accepts protocol 3. The known fix raises maxProtocol in the connect params of src/notifiers/openclaw.js from 3 to 4, keeps minProtocol at 3, and leaves the rest of the handshake as it is. Require a regression test for protocol negotiation that asserts the advertised range covers the current gateway protocol, so a client pinned below it cannot ship.
>
> Record that outcome and the release boundary in the intent. Spec and plan are later pull requests.
>
> Every squash-merge to main publishes the next patch. scripts/release-version.sh patch-bumps when the pull request has neither release:minor nor release:major. The current release is v0.1.11. The next patch is v0.1.12, and v0.1.12 is the protocol fix. This pull request stays unmerged. Do not add release:minor or release:major. No deploy.
