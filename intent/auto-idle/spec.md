# spec.md — Restore imported IDLE

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 1 |
| Stage | 2 · Design |

## 1. Summary

On v0.1.5 the production imapflow client sets `disableAutoIdle: true` and `maxIdleTime`. The imported client left auto-IDLE on and set neither. Pull request 16's spec rejected both options. Commit `8db6c3c` turned auto-IDLE off for the harness, and v0.1.5 then added `maxIdleTime`.

This release puts the production client, and every test that calls it the way startup does, back on the imported IDLE behavior. Auto-IDLE stays on. The production path does not set `disableAutoIdle`. No test in this release holds the IDLE session still, so none opts into `disableAutoIdle`. `maxIdleTime` leaves the production client when a short-clock harness run with auto-IDLE on shows no `Socket timeout` across several quiet periods and still saves one live EXISTS. A failed proof stops the phase and names no other timer workaround.

The later code merge, with neither `release:minor` nor `release:major`, publishes `v0.1.6` when that proof passes. This pull request stays unmerged.

## 2. Goals and non-goals

**Goals**

- G1. The production client matches the imported client's IDLE behavior. Auto-IDLE stays on. Startup and the two-argument factory do not set `disableAutoIdle` or `maxIdleTime`.
- G2. A test that calls `createImapFlowClient` with account and password, and no third argument, stands in for that client and gets the same options.
- G3. One short-clock harness run with auto-IDLE on shows no `Socket timeout` across several quiet periods and still saves one live EXISTS, with one body-free wake.
- G4. `AGENTS.md` and `REVIEW.md` describe that production client.

**Non-goals**

- A config key, CLI flag, or documented user setting for IDLE timing.
- Bumping imapflow, or editing `package.json` or the lockfile.
- Editing other intent folders, the service unit, or the launchd wrapper.
- A wall-clock wait of 10 minutes.
- Merging this pull request.
- A `release:minor` or `release:major` label on the later phase pull request.
- Deploy.

**Release phasing.** This release is the single later phase. It merges when the proof in G3 passes, and that merge publishes `v0.1.6`. A failed proof stops the phase and names no other timer workaround. The phase does not merge. This pull request only adds this folder's intent and spec and stays unmerged. Nothing in this intent is postponed.

## 3. Principles

- P1. Auto-IDLE stays the library default on the production client.
- P2. `disableAutoIdle` is a per-test opt-in for a test that must hold the IDLE session still. This release has no such test.
- P3. The short clock is how the proof shows several quiet periods. The production path omits it.
- P4. A failed short-clock proof stops the phase and names no other timer workaround.
- P5. Placeholders only. No personal names, emails, hostnames, machine names, or real mailbox names.

## 4. Users and scenarios

A running service watches a mailbox over IMAP. The server sends nothing during IDLE. After this change the production client leaves auto-IDLE on, the way the imported client did. A message that arrives while the connection is open is saved once and wakes the notifier once. The proof of the quiet connection is a short-clock harness run, not a 10-minute wait.

## 5. Functional requirements

- FR1. **Baseline.** Checked 2026-11-01.
  - Import `3cb0e2f`, `snail.js` lines 332–341: host, port, secure, auth, and `logger: false`. No `disableAutoIdle`, no `maxIdleTime`, no `socketTimeout`, no `autoIdleDelay`. Lines 364–373 wait on `exists`, `close`, and `error`, and start `client.idle()` beside that wait.
  - Pull request 16, `intent/idle-exists/spec.md` at `aad6cf3`: non-goals and D2 reject `disableAutoIdle` and `maxIdleTime`. FR5 says that release does not set them. v0.1.1 `7342fed`, `snail.js` lines 124–130, still passes host, port, secure, auth, and `logger: false` only.
  - Commit `8db6c3c` sets `disableAutoIdle: true` on `createImapFlowClient`. The harness spec's D3 records that choice so auto-IDLE would not start an IDLE the adapter does not own.
  - v0.1.5 `fa91b2f`: `IDLE_REFRESH_MS` is `4 * 60 * 1000` (`snail.js` line 9). `createImapFlowClient` sets `disableAutoIdle: true` and `maxIdleTime: IDLE_REFRESH_MS` (lines 135–136). A third argument may set `maxIdleTime` and `socketTimeout` (lines 140–147). Startup calls the factory with account and password only (line 297).
  - imapflow 1.7.8, `lib/imap-flow.js`. `SOCKET_TIMEOUT` is `5 * 60 * 1000` (line 57). `socketTimeout` defaults to that (line 465). `AUTO_IDLE_DELAY` is `15 * 1000` (line 72). `AUTO_IDLE_SOCKET_MARGIN` is `1000` (line 76). `normalizeAutoIdleDelay` (lines 173–201) caps the delay at `socketTimeout - 1000`. `autoidle` (lines 2317–2338) returns immediately when `disableAutoIdle` is set, and otherwise schedules `idle()` after `autoIdleDelay` when the connection is selected and not busy. `connectionBusy` (lines 2308–2309) is true while a command, including `IDLE`, is in flight. `_socketTimeout` (lines 1446–1469) sends `NOOP` while idling and emits `Error('Socket timeout')` when the connection is quiet and not idling. `run` calls `autoidle` after every command except `IDLE` (lines 4429–4432). `ImapFlow.idle` (lines 3116–3119) returns immediately when already idling, and otherwise runs `IDLE` with `maxIdleTime`. Unset `maxIdleTime` stays false (line 587).
  - The current adapter wait resolves on `exists` and rejects on `close` or `error`. Fulfillment of `client.idle()` does not settle that wait (`snail.js` lines 189–234).
  - Harness default factory is the two-argument `createImapFlowClient` (`test/imap-harness.test.js` line 215). One direct `ImapFlow` constructor sets `disableAutoIdle: true`, then opens the mailbox and logs out (lines 769–780). Three idle-refresh cases lock `maxIdleTime` and `disableAutoIdle` (lines 825, 862, and 923).

- FR2. **Production options.** `createImapFlowClient(account, password)` builds imapflow with host, port, `secure` from `tls === 'on'`, auth, and `logger: false`. The options object omits `disableAutoIdle`, `maxIdleTime`, `socketTimeout`, and `autoIdleDelay`. The module does not export `IDLE_REFRESH_MS`. Startup keeps the two-argument call. The config file gains no IDLE key. An optional third argument may set `socketTimeout` and no other imapflow option. The client does not read `maxIdleTime` or `disableAutoIdle` from that argument. `src/supervisor.js` still calls the factory with account and password. `IDLE_KEEPALIVE_MS` stays `29 * 60 * 1000`.

- FR3. **Who stands in for production.** A test stands in for production when it calls `createImapFlowClient` with account and password and no third argument. The harness default factory stays that call. The exists unit test and the BigInt runner stay on that call. The direct constructor at `test/imap-harness.test.js` lines 769–780 omits `disableAutoIdle`. That test opens the mailbox and logs out. It does not hold an IDLE session. `snail.js` and the files under `test/` do not contain `disableAutoIdle`.

- FR4. **Proof.** One new case in `test/imap-harness.test.js`. It uses the harness server, the real `createImapFlowClient`, and `startSupervisor`. The factory passes `{ socketTimeout: 1500 }` and nothing else. The recorded constructor options have `socketTimeout === 1500` and omit `disableAutoIdle`, `maxIdleTime`, and `autoIdleDelay`. The harness sleeper leaves `IDLE_KEEPALIVE_MS` pending and leaves the reconnect delay of `5000` pending. The server sends no unsolicited bytes during IDLE. Before the message is added, the client trace is `IDLE`, `DONE`, `NOOP`, `IDLE`, `DONE`, `NOOP`, `IDLE`, and the log has no `Socket timeout` line. `addMessage` during that third `IDLE` saves one message and sends one webhook. The payload has no body. `lastUid` is that UID.

- FR5. **v0.1.5 harness cases.** The case that expects `Socket timeout` with `maxIdleTime: false`, and the case that keeps the connection with `maxIdleTime: 150`, do not remain. The production-options case remains and locks FR2: `IDLE_REFRESH_MS` is absent, and the two-argument options omit `disableAutoIdle`, `maxIdleTime`, `socketTimeout`, and `autoIdleDelay`.

- FR6. **Notes.** In `AGENTS.md`, replace the Things agents get wrong bullet that begins with `Setting` and `` `disableAutoIdle: true` `` with this bullet, including the backticks:

  ```markdown
  - The production imapflow client leaves auto-IDLE on. It does not set `disableAutoIdle` or `maxIdleTime`. A test sets `disableAutoIdle` only when that test must hold the IDLE session still.
  ```

  In `REVIEW.md`, on the Bugs line, replace the clause that begins with `` `disableAutoIdle` without `maxIdleTime` `` with this clause, including the backticks: `` the production imapflow client setting `disableAutoIdle` or `maxIdleTime` ``.

- FR7. **Stop and release.** The proof is FR4. When FR4 fails, the phase stops and reports. It names no other timer workaround. It does not merge. When FR4 passes, the phase pull request carries neither `release:minor` nor `release:major`. Its squash-merge to the default branch publishes `v0.1.6`. Checked 2026-11-01: `v0.1.5` is `fa91b2f` on the default branch, and `scripts/release-version.sh` patch-bumps a squash merge that has neither label. This pull request is not that merge. Merging it would publish `v0.1.6` without the client change.

## 6. Acceptance criteria

| AC | What | Check |
|---|---|---|
| AC1 | With `{ socketTimeout: 1500 }` and no other override, the recorded options omit `disableAutoIdle`, `maxIdleTime`, and `autoIdleDelay`. Before the message, the trace is `IDLE`, `DONE`, `NOOP`, `IDLE`, `DONE`, `NOOP`, `IDLE`, and the log has no `Socket timeout` line. One later EXISTS saves one message and sends one webhook with no body. | `npm test` |
| AC2 | The two-argument client omits `disableAutoIdle`, `maxIdleTime`, `socketTimeout`, and `autoIdleDelay`. The module does not export `IDLE_REFRESH_MS`. | `npm test` |
| AC3 | The harness default factory, the exists unit test, and the BigInt runner call `createImapFlowClient` with account and password only. `snail.js` and the files under `test/` do not contain `disableAutoIdle`. | `npm test` |
| AC4 | `AGENTS.md` and `REVIEW.md` match FR6. `npm test` exits 0. The 29-minute keepalive test still passes with no fetch on that path. | `npm test` |

`npm test` is `node --test`. Healthy: exit 0.

## 7. Design decisions

**D1 — No test opts into `disableAutoIdle`.** Checked 2026-11-01 against imapflow 1.7.8 and the harness. `autoidle` does not start `IDLE` while `connectionBusy` is true, and an in-flight `IDLE` makes the connection busy. The harness cases that call the two-argument factory enter `client.idle()` and finish on `exists` inside that wait. They do not need a second IDLE held off. The direct constructor at lines 769–780 reads the mailbox and logs out. It never enters IDLE, so it is not a test that must hold the IDLE session still. It omits `disableAutoIdle`. The v0.1.5 cases that set it do not remain (D3). This release has no opt-in call. The production path omits the option. A later test may set it only when that test must hold the IDLE session still. This release does not add that test.

**D2 — The short clock is `socketTimeout: 1500`.** Checked 2026-11-01 on imapflow 1.7.8, imapkit 5.2.0, and Node 26.13.0, using the current adapter wait and `startSupervisor`, with `disableAutoIdle` and `maxIdleTime` omitted and `socketTimeout` 1500. `normalizeAutoIdleDelay` caps the default `15000` at `1500 - 1000`, so the library delay sits inside the short period. The test does not set `autoIdleDelay`. Three runs each reached a third `IDLE` in about 4.4s. The trace before the message was `IDLE`, `DONE`, `NOOP`, `IDLE`, `DONE`, `NOOP`, `IDLE`. The log had no `Socket timeout` line. One `EXISTS` then saved one message, set `lastUid` to that UID, and sent one webhook with no body. Two quiet recoveries and a third open `IDLE` are several quiet periods. The production two-argument client omits `socketTimeout`. The 29-minute keepalive stays pending during the case, so the pass is this trace.

**D3 — The v0.1.5 `maxIdleTime` cases do not remain.** They lock the option this release removes from the production path. The broken case and the repaired case go away. The production-options case stays and locks the imported constructor (FR2, AC2). The proof case (FR4, AC1) is the quiet-period check those cases were standing in for.

**D4 — A failed proof stops the phase.** FR4 is the proof. When it fails, the phase stops and reports. It names no other timer workaround. It does not merge. `v0.1.6` is the later merge that contains the passing proof, with neither `release:minor` nor `release:major`. This pull request stays unmerged.

## 8. Open questions

None.
