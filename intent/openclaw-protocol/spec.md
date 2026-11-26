# spec.md — OpenClaw protocol 4

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-26) |
| Status | Draft 1 |
| Stage | 2 · Design |

## 1. Summary

v0.1.11 saves mail. Its OpenClaw connect params advertise `minProtocol` 3 and `maxProtocol` 3. A gateway on WebSocket protocol 4 rejects that handshake before auth (`failurePhase=auth`, `failureCause=protocol-mismatch`). The pending notify stays in the ledger and retries.

This release raises `maxProtocol` to 4 and keeps `minProtocol` at 3. The advertised range includes protocol 4 and protocol 3. Every other handshake field stays as it is on v0.1.11. A regression test asserts that the advertised range covers protocol 4, so a client pinned below that protocol fails the test.

The later build merge that contains this change is `v0.1.12`. This pull request stays off `main`.

## 2. Goals and non-goals

**Goals**

- G1. The connect params in `src/notifiers/openclaw.js` advertise `minProtocol` 3 and `maxProtocol` 4.
- G2. A regression test for protocol negotiation asserts that the advertised range covers the current gateway protocol, 4, and that the shipped bounds are 3 and 4.
- G3. Mail still saves. Notify delivery otherwise stays as [durable notify](../durable-notify/spec.md) specifies. A rejected handshake leaves the pending notify in place.
- G4. `v0.1.12` is the later build merge that contains G1 and G2. This pull request is not that merge.

**Non-goals**

- A new config key.
- A message body on any notifier.
- A secret on the command line, in a log, or in a file this program writes.
- Any handshake field other than `maxProtocol`.
- Raising `minProtocol`.
- Editing other intent folders, `AGENTS.md`, or `REVIEW.md`.
- A `release:minor` or `release:major` label.
- Merging this pull request to `main`.
- A deploy, a service install, or a service restart.

**Release phasing.** This release is the protocol-range change in G1 and the regression test in G2. The plan and that change are later pull requests. This pull request adds this spec only and stays off `main`. Nothing in this intent is postponed, and nothing is tagged onto this spec for a later release. A squash-merge of this file onto `main` would publish `v0.1.12` without the protocol change. `v0.1.12` is the later build merge that contains the protocol change.

## 3. Principles

- P1. `maxProtocol` is 4. `minProtocol` is 3. No other handshake field moves.
- P2. The regression test names protocol 4. A client whose advertised range excludes 4 fails that test.
- P3. Mail stays saved. A failed handshake leaves the pending notify until the notifier succeeds. Delivery otherwise stays as durable notify specifies.
- P4. The wake stays metadata only. The body stays out of the notifier. Secrets, the gateway token, webhook URLs, and authorization headers stay out of argv, logs, and files this program writes.
- P5. Placeholders only. No personal names, emails, hostnames, or machine paths.

## 4. Users and scenarios

A person whose saved mail should wake an OpenClaw gateway on protocol 4, and a gateway that still speaks protocol 3.

Mail arrives and is saved once. The account's OpenClaw client answers `connect.challenge` with the same handshake as v0.1.11, except `maxProtocol` is 4. A gateway on protocol 4 is inside the advertised range and can complete connect, then receive `wake` with `{ text, mode: "now" }`. A gateway on protocol 3 is still inside that range. A client that advertises a maximum below 4 fails the regression test and does not ship.

## 5. Functional requirements

- FR1. **Baseline.** Checked 2026-11-26.
  - Tag `v0.1.11` and `origin/main` are commit `b6ba3291c682cfa25f6fa1b4b25265dab22b892e`. Tag `v0.1.12` does not exist. This spec's parent is `caf99b3d9d486582ed79298b23d73f70721a08aa`.
  - On that v0.1.11 tree, `src/notifiers/openclaw.js` sets `minProtocol` and `maxProtocol` to 3 in the connect params (lines 173–174). `test/notifiers.test.js` asserts both equal 3 (lines 219–220), in the test `AC8: OpenClaw handshake and wake on fake gateway`. No other test asserts either bound.
  - The same connect object also sends `client` `{ id: "cli", version: "1.0.0", platform: "linux", mode: "cli" }`, `role` `"operator"`, `scopes` `operator.read`, `operator.write`, and `operator.admin`, empty `caps` and `commands`, empty `permissions`, `auth.token` from the account, `locale` `"en-US"`, `userAgent` `"snail/1.0.0"`, and `device` `{ id, publicKey, signature, signedAt, nonce }`. `signedAt` is `Date.now()`. `buildDeviceAuthPayload` still joins `v2`, the device id, `cli`, `cli`, the role, the scopes, `signedAt`, the token, and the nonce with `|`. `wake` still sends `{ text, mode: "now" }` from `formatWakeText`. A new Ed25519 key is still generated per connection. Outbound methods stay `connect` and `wake`.
  - Config keys stay `openclaw_url` and `openclaw_token`. There is no protocol key.
  - Public gateway docs, fetched 2026-11-26: [versioning](https://docs.openclaw.ai/gateway/protocol/versioning) sets `PROTOCOL_VERSION` to 4 and `MIN_CLIENT_PROTOCOL_VERSION` to 4. Clients send `minProtocol` and `maxProtocol`. Operator and UI clients must include the current protocol in that range. The N-1 window (protocol 3) is for an authenticated client with `role` `"node"` and `client.mode` `"node"`, and for lightweight probes (`MIN_NODE_PROTOCOL_VERSION` 3, `MIN_PROBE_PROTOCOL_VERSION` 3). The [handshake](https://docs.openclaw.ai/gateway/protocol/handshake) example for an operator client sends `minProtocol` 4 and `maxProtocol` 4, and tells device-auth clients to use the challenge `ts` as `signedAt`. [Portable mail](../portable-mail/spec.md) D5 kept the imported client on protocol 3 and payload `v2`.
  - The intent records that raising only `maxProtocol` to 4 was tried against a gateway on protocol 4, and the connect proceeded. This spec does not repeat that trial.
  - `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major` (the `else` branch that increments `patch`).

- FR2. **Connect params.** In `src/notifiers/openclaw.js`, the connect params set `maxProtocol` to 4. `minProtocol` stays 3. The only change in that file from v0.1.11 is that one value. The file's comment, methods, payload builder, `signedAt`, scopes, client object, and `wake` call stay as they are.

- FR3. **Regression test.** In `test/notifiers.test.js`, the test `AC8: OpenClaw handshake and wake on fake gateway` replaces its two equality assertions on the protocol bounds with these four assertions, in this order:

  ```javascript
  assert.ok(connectParams.minProtocol <= 4);
  assert.ok(connectParams.maxProtocol >= 4);
  assert.equal(connectParams.minProtocol, 3);
  assert.equal(connectParams.maxProtocol, 4);
  ```

  The literal `4` is the current gateway protocol. The first pair fails a client whose advertised range excludes 4, including a client pinned at `maxProtocol` 3. The second pair locks the shipped bounds, so the range still includes protocol 3. The only change in that file is those assertions. The test's other checks stay: one connection, `client.id` `"cli"`, a base64 device signature, device-auth payload prefix `v2`, and `wake` params `{ text, mode: "now" }` with an absolute path in the text. No other test file changes. The fake gateway in this test keeps accepting the connect frame and replying `ok`. It does not grow a second protocol implementation.

- FR4. **Mail and delivery.** This release does not change mail intake, the message file, `lastUid`, the notify ledger, retry delays, `notify-redeliver`, or the webhook notifier. A connect failure still leaves the pending row in `.snail-notify.json` until the notifier succeeds. For the connect bounds, this spec replaces the protocol-3 pin in portable-mail D5. Every other field of that handshake stays. Notify delivery stays as durable notify specifies.

- FR5. **Secrets and body.** The wake text stays the metadata sentence from `formatWakeText`. It gains no body. The gateway token stays in `auth.token` and in the device-auth payload, where v0.1.11 already places it. It stays out of argv, logs, and files this program writes. Webhook URLs and authorization headers stay out of those same places. The config file gains no key.

- FR6. **Release boundary.** Checked 2026-11-26: `v0.1.11` is `b6ba3291c682cfa25f6fa1b4b25265dab22b892e`, which is `origin/main`. `v0.1.12` does not exist. This pull request's only file is `intent/openclaw-protocol/spec.md`. Its base is the open intent branch, and it stays unmerged to `main`. It carries neither `release:minor` nor `release:major`. Merging this file to `main` would make the release workflow publish `v0.1.12` without the protocol change. The later build pull request contains FR2 and FR3, carries neither label, and squash-merges to `main`. That merge is what `v0.1.12` points at. The existing release workflow on that push tags `v0.1.12` and attaches the source tarball. This change adds no deploy, no service install, and no service restart.

## 6. Acceptance criteria

| AC | What | Check |
|---|---|---|
| AC1 | The connect params advertise `minProtocol` 3 and `maxProtocol` 4. The test asserts `minProtocol <= 4` and `maxProtocol >= 4` before the equality checks. A params object with `maxProtocol` 3 fails. | `npm test` — `test/notifiers.test.js` |
| AC2 | The diff of `src/notifiers/openclaw.js` against `v0.1.11` changes only `maxProtocol` from 3 to 4. The AC8 test still checks `client.id` `"cli"`, a base64 device signature, payload prefix `v2`, and `wake` `{ text, mode: "now" }`. | `npm test` — `test/notifiers.test.js`; diff against `b6ba3291c682cfa25f6fa1b4b25265dab22b892e` |
| AC3 | The config schema has no new key. The wake text has no message body. A failed connect leaves the pending notify row. Logs, argv, and files this program writes gain no secret, gateway token, webhook URL, or authorization header. | `npm test`; inspection of the protocol-change diff |
| AC4 | This pull request is not merged to `main` and has neither release label. After the later build merge, tag `v0.1.12` points at that merge and the tree contains `maxProtocol` 4. | `git` tag and the pull request base |

`npm test` is `node --test`. Healthy: exit 0. AC1–AC3 are met by the later build merge. AC4's first sentence is this pull request. AC4's second sentence is that later merge.

## 7. Design decisions

**D1 — Advertise 3 through 4.** Choice: `minProtocol` 3 and `maxProtocol` 4. A gateway on protocol 4 is inside the range, which is the mismatch v0.1.11 hits. A gateway on protocol 3 stays inside the range because the minimum stays 3. Checked 2026-11-26 against `src/notifiers/openclaw.js` on `v0.1.11` and against the versioning and handshake pages in FR1. Those pages tell an operator client to send 4 and 4, and they reserve the protocol-3 window for node and probe clients. This client is `role` `"operator"` and `client.mode` `"cli"`. This release does not adopt that operator pin. The intent locks the minimum at 3 and records that the 3-and-4 pair connected to a protocol-4 gateway. Rejected: leaving `maxProtocol` at 3; raising `minProtocol` to 4; widening the range past 4.

**D2 — The rest of the handshake stays.** Choice: the only source edit is the `maxProtocol` value in FR2. That includes `buildDeviceAuthPayload` staying on the `v2` pipe string, and `signedAt` staying `Date.now()`. The handshake page tells device-auth clients to copy the challenge `ts` into `signedAt`. This release does not adopt that. The intent locks the rest of the handshake, and the tried connect used this handshake with only `maxProtocol` raised. Rejected: a payload-prefix change; copying the challenge timestamp; editing client id, platform, scopes, locale, user agent, or the `wake` shape.

**D3 — The regression test is the existing AC8 connect capture.** Choice: the four assertions in FR3, in the test that already reads `connectParams`. The literal 4 is independent of the client's own maximum, so a client pinned below 4 fails even when that pin is the previous shipped value of 3. The equality pair keeps protocol 3 inside the shipped range. The fake gateway already accepts the connect frame; the regression is the advertised range, not a second gateway. Rejected: deleting the assertions; asserting only `maxProtocol === 4` with no coverage check against the literal 4; a live gateway test; a new test file.

**D4 — `v0.1.12` is the build merge, and this pull request stays off `main`.** Choice: FR6. Checked 2026-11-26: `v0.1.11` and `origin/main` are `b6ba3291c682cfa25f6fa1b4b25265dab22b892e`, `v0.1.12` is absent, and `scripts/release-version.sh` patch-bumps when both release labels are absent. This pull request has neither label. Merging it to `main` would publish the next patch without FR2. The later build pull request is the one that publishes `v0.1.12`. Rejected: a `release:minor` or `release:major` label; merging this spec to `main`; a deploy step.

## 8. Open questions

None. The protocol range, the rest of the handshake, the regression test, and the `v0.1.12` boundary are D1–D4.
