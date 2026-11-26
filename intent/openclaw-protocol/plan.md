# plan.md — OpenClaw protocol 4

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in the plan only. A closed plan shows | Status | Finished | in the header table.

## Stops

None. The protocol range, the rest of the handshake, the regression test, and the `v0.1.12` boundary are D1–D4.

## Publishing

Checked 2026-11-26. Tag `v0.1.11` and `origin/main` are `b6ba3291c682cfa25f6fa1b4b25265dab22b892e`. Tag `v0.1.12` does not exist. This plan's base is `356245ba69546dc14f0fd60a80c52cd9c5fce03c` on `cursor/openclaw-protocol-spec-31e4`. That commit's parent is `caf99b3d9d486582ed79298b23d73f70721a08aa`. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`.

This pull request adds only `intent/openclaw-protocol/plan.md`. It stays unmerged to `main`. It carries neither `release:minor` nor `release:major`. A squash-merge of this file to `main` publishes `v0.1.12` without the protocol change.

Phase 1 is a later pull request. It starts from this plan's head, so the intent, the spec, and this plan are in that branch, and its base is `main`. It contains the `maxProtocol` change and the regression test (FR2, FR3). It carries neither label. Squash-merge it to `main` only when the required checks `test` and `javascript` have succeeded. A missing, pending, failed, or cancelled check has not succeeded. Do not use an admin override. That merge is what `v0.1.12` points at. The existing release workflow on that push tags `v0.1.12` and attaches the source tarball. This change adds no deploy, no service install, and no service restart.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` — `test/notifiers.test.js` | 1 |
| AC2 | `npm test` — `test/notifiers.test.js`; diff of `src/notifiers/openclaw.js` against `b6ba3291c682cfa25f6fa1b4b25265dab22b892e` | 1 |
| AC3 | `npm test`; inspection of the protocol-change diff | 1 |
| AC4 | This pull request stays unmerged to `main` and has neither release label. After Phase 1 merges, tag `v0.1.12` points at that merge and the tree contains `maxProtocol` 4 | this pull request; 1 |

`npm test` is `node --test`. Healthy: exit 0. AC1–AC3 are met by Phase 1. AC4's first sentence is this pull request. AC4's second sentence is Phase 1.

## Phase 1 — Publish v0.1.12

Files: `src/notifiers/openclaw.js`, `test/notifiers.test.js`

1. In `src/notifiers/openclaw.js`, set `maxProtocol` to 4. Leave `minProtocol` at 3. Against `v0.1.11` (`b6ba3291c682cfa25f6fa1b4b25265dab22b892e`), the only change in that file is that one value (lines 173–174 on that tree). Leave the file comment, methods, `buildDeviceAuthPayload`, `signedAt` (`Date.now()`), scopes, client object, and `wake` call as they are (FR2, D1, D2).
2. In `test/notifiers.test.js`, in the test `AC8: OpenClaw handshake and wake on fake gateway`, replace the two equality assertions on the protocol bounds (lines 219–220 on `v0.1.11`) with these four assertions, in this order:

   ```javascript
   assert.ok(connectParams.minProtocol <= 4);
   assert.ok(connectParams.maxProtocol >= 4);
   assert.equal(connectParams.minProtocol, 3);
   assert.equal(connectParams.maxProtocol, 4);
   ```

   The literal `4` is the current gateway protocol. The first pair fails a client whose advertised range excludes 4, including a client pinned at `maxProtocol` 3. The second pair locks the shipped bounds, so the range still includes protocol 3. The only change in that file is those assertions. The test's other checks stay: one connection, `client.id` `"cli"`, a base64 device signature, device-auth payload prefix `v2`, and `wake` params `{ text, mode: "now" }` with an absolute path in the text. No other test file changes. The fake gateway keeps accepting the connect frame and replying `ok`. It does not grow a second protocol implementation (FR3, D3).
3. Leave mail intake, the message file, `lastUid`, the notify ledger, retry delays, `notify-redeliver`, and the webhook notifier as they are. A connect failure still leaves the pending row in `.snail-notify.json` until the notifier succeeds. Config keys stay `openclaw_url` and `openclaw_token`. The wake text stays the metadata sentence from `formatWakeText`. The gateway token stays in `auth.token` and in the device-auth payload, and stays out of argv, logs, and files this program writes (FR4, FR5).
4. Leave `AGENTS.md`, `REVIEW.md`, other intent folders, `package.json`, and `.github/workflows/release.yml` unchanged. Add neither `release:minor` nor `release:major`. Add no deploy, service install, or service restart.

DoD: `npm test` exits 0. `git diff -U0 b6ba3291c682cfa25f6fa1b4b25265dab22b892e -- src/notifiers/openclaw.js` shows only `maxProtocol` changing from 3 to 4. The AC8 test contains the four assertions in step 2, in that order.
