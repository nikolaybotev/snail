# spec.md — IDLE refresh

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

On v0.1.4 (`c69c630`) the account loop logs `imap disconnected: Socket timeout` about every 10 minutes while the TCP connection to port 993 is still up, then reconnects. The process keeps running. Mail that arrived after IDLE stopped is saved and notified on the next connection's catch-up.

The locked client is imapflow 1.7.8 (`package-lock.json`). Its default socket inactivity timeout is 5 minutes. The first quiet period ends IDLE with `DONE` and a `NOOP` and does not start another IDLE, because `disableAutoIdle` is true and `maxIdleTime` is unset. The second quiet period raises `Error('Socket timeout')`. The 29-minute account keepalive has not run yet. The imported single-file client left auto-IDLE on, so imapflow started a new IDLE after that `NOOP`. This tree dropped that re-entry.

The fix sets `maxIdleTime` to 4 minutes on the production client. imapflow then writes `DONE` and starts a new IDLE inside the same `client.idle()` call, before the 5-minute watchdog. The regression test is a case in the existing IMAP harness, with the same timer relationship on a short clock. The public report is GitHub issue 19. This intent pull request stays unmerged. The later code merge, with neither `release:minor` nor `release:major`, publishes `v0.1.5`.

## 2. Goals and non-goals

**Goals**

- G1. While the account loop is in IDLE, the client writes `DONE` and a new `IDLE` before imapflow's default 5-minute socket inactivity timeout.
- G2. That refresh does not log `imap disconnected: Socket timeout`, and it does not count as new mail.
- G3. A message that arrives after a refresh, while IDLE is open, is saved once and wakes the notifier once.
- G4. The regression test runs in the existing IMAP harness against imapkit and the production adapter. It shows the broken timer relationship and the repaired one. It also locks the production interval under both the 5-minute socket timeout and a 10-minute deadline.

**Non-goals**

- Raising `socketTimeout`, or setting it from production code.
- Clearing `disableAutoIdle`.
- Changing `IDLE_KEEPALIVE_MS` (`29 * 60 * 1000`) or the 29-minute keepalive test.
- A config key, CLI flag, or documented user setting for the interval.
- Bumping imapflow, or editing `package.json` or the lockfile.
- Editing other intent folders, the service unit, or the launchd wrapper.
- A test that waits out a wall-clock 10 minutes.

**Release phasing.** This release is the single phase in [plan.md](plan.md). The later code merge publishes `v0.1.5`. This pull request only adds this folder and stays unmerged. Staying is not an exemption from a recorded cut. Nothing in this intent is postponed.

## 3. Principles

- P1. The smallest change is one imapflow option the library already implements (`maxIdleTime`).
- P2. `DONE` followed by a new `IDLE` is the refresh. A lone recovery `NOOP` is the failure path.
- P3. The harness already speaks IMAP on a real socket with the production adapter. The test uses that path.
- P4. Placeholders only. No personal names, emails, hostnames, machine names, or real mailbox names.

## 4. Users and scenarios

A running service watches a mailbox over IMAP on port 993. The server sends nothing during IDLE. Today, about every 10 minutes, the log contains `imap disconnected: Socket timeout` and the process opens a new connection. After this change the same quiet server stays on one connection, and a message that arrives while that connection is open is saved and notified without that reconnect.

## 5. Functional requirements

- FR1. **Cause.** Checked 2026-11-01 on v0.1.4 (`c69c630`) and unpacked `imapflow@1.7.8`.
  - `createImapFlowClient` builds imapflow with `disableAutoIdle: true` and does not set `maxIdleTime` or `socketTimeout` (`snail.js` lines 126–133).
  - `idle()` waits on `exists`, `close`, and `error`, starts `client.idle()`, and ignores fulfillment of that call (`snail.js` lines 174–219). `cancelIdle` calls `preCheck` (`snail.js` lines 221–236).
  - `IDLE_KEEPALIVE_MS` is `29 * 60 * 1000` (`src/supervisor.js` line 18). `raceIdle` returns `'keepalive'` when that timer wins (lines 436–469). The loop then calls `cancelIdle` and continues (lines 323–328). The catch logs `imap disconnected: ${message}` (lines 354–360).
  - imapflow `SOCKET_TIMEOUT` is `5 * 60 * 1000` (`lib/imap-flow.js` line 57). `socketTimeout` defaults to that value (lines 401–402 and 465). `0` means the default, not off. `maxIdleTime` stays false when the option is unset (line 587). `configureSocket` enables TCP keep-alive at 5 seconds and arms `socket.setTimeout` (lines 1404–1409).
  - `_socketTimeout` (lines 1446–1469): while `idling` is true and the in-flight command is `IDLE`, it calls `run('NOOP')`. `run` awaits `preCheck`, which writes `DONE` (`lib/commands/idle.js` lines 59–71), then sends `NOOP`, then calls `autoidle` ( `lib/imap-flow.js` lines 4424–4432). `autoidle` returns immediately when `disableAutoIdle` is set (lines 2317–2320). The handler does not call `idle()` itself. When the connection is not idling, the handler emits `Error('Socket timeout')` with code `ETIMEOUT`. `emitError` emits `error` before `close` (`closeAfter` is `setImmediate`, lines 2539–2541 and 663–664).
  - `ImapFlow.idle` runs `IDLE` with `this.maxIdleTime` (lines 3116–3119). When `maxIdleTime` is set, `lib/commands/idle.js` lines 345–370 write `DONE` and start another IDLE inside the same call. The call does not return between restarts.
  - Node 26.13.0, checked 2026-11-01: `socket.setTimeout` fires after a quiet period; a write and its reply start a new full period; `setKeepAlive` does not reset that timer. Two default periods are 10 minutes. TCP keep-alive is why port 993 stays established through the first period.
  - Local scripted server (imapkit 5.2.0, IDLE plugin, no unsolicited IDLE traffic), same day: auto-IDLE off and no `maxIdleTime`, `socketTimeout` 400, produces inbound `IDLE`, `DONE`, `NOOP`, then the adapter rejects with `Socket timeout` one period after `idle()` fulfills. `maxIdleTime` 150 repeats `DONE` and a new `IDLE` and does not raise `Socket timeout`. Auto-IDLE on, with a short `autoIdleDelay`, writes a new `IDLE` after the `NOOP` and does not raise `Socket timeout`.
  - Import `3cb0e2f` `snail.js` lines 332–341 pass host, port, secure, auth, and `logger: false` only. Lines 360–373 wait on `exists`, `close`, and `error`, and do not treat fulfillment of `client.idle()` as the signal. There is no `maxIdleTime`, no `DONE` loop, and no `disableAutoIdle`. The refresh the rewrite dropped is imapflow auto-IDLE after the recovery `NOOP`.

- FR2. **Production options.** `snail.js` exports `IDLE_REFRESH_MS` as `4 * 60 * 1000`. `createImapFlowClient(account, password)` passes `maxIdleTime: IDLE_REFRESH_MS`, keeps `disableAutoIdle: true`, and omits `socketTimeout`. An optional third argument may set `maxIdleTime` (including `false`) and `socketTimeout`. Production startup does not pass it. The value is not read from config, argv, or the environment. `src/supervisor.js` still calls the factory with `(account, password)`.

- FR3. **Refresh behavior.** With the production options, imapflow's IDLE loop writes `DONE` and a new `IDLE` every `IDLE_REFRESH_MS` while the adapter wait is open. Fulfillment of `client.idle()` is still ignored. A `maxIdleTime` restart is not `'exists'` and does not fetch or wake. `exists` after a restart still fulfills the same adapter wait, and the existing `mailboxOpen` plus `syncMessages` path saves and notifies that UID once.

- FR4. **Harness regression.** Extend `test/imap-harness.test.js`. Both cases use imapkit on `127.0.0.1`, the production `createImapFlowClient`, and `startSupervisor`. The harness sleeper leaves `IDLE_KEEPALIVE_MS` pending so the 29-minute path cannot refresh IDLE during the case. The reconnect delay of `5000` stays pending so a disconnect cannot spin. The server sends no unsolicited bytes during IDLE. Record imapkit `trace` input.
  - Broken relationship: third argument `{ socketTimeout: 400, maxIdleTime: false }`. The case records the options object passed to the imapflow constructor and requires `maxIdleTime === false` and `socketTimeout === 400`. A session reaches Selected. The log then contains `imap disconnected: Socket timeout`. Before that line the trace has one `IDLE`, a `DONE`, and a `NOOP`, and no second `IDLE`. That trace is the same when `maxIdleTime` is `IDLE_REFRESH_MS` (`240000`) and `socketTimeout` is 400, because `240000` is also greater than 400. Checked 2026-11-01 on imapkit 5.2.0: both option sets produce one `IDLE`, `DONE`, and `NOOP`, then `Socket timeout` one period after `idle()` fulfills. The trace stays. It is not the proof that `false` took effect.
  - Repaired relationship: third argument `{ socketTimeout: 500, maxIdleTime: 150 }`. The trace shows a second `IDLE`, with a `DONE` before it, and the wait past two socket periods contains no `Socket timeout` line. `addMessage` during the open IDLE saves one message and sends one webhook, with no message body in the payload.
  - Constant: `IDLE_REFRESH_MS` is `4 * 60 * 1000`, and that number is less than `5 * 60 * 1000` and less than `10 * 60 * 1000`. The two-argument options object has `maxIdleTime === IDLE_REFRESH_MS`, `disableAutoIdle === true`, and no `socketTimeout` property.

- FR5. **Release.** The phase pull request carries neither `release:minor` nor `release:major`. Its squash-merge to the default branch is the push that publishes `v0.1.5`. This intent pull request is not that merge.

## 6. Acceptance criteria

| AC | What | Check |
|---|---|---|
| AC1 | The broken harness case records the options object passed to the imapflow constructor, with `maxIdleTime === false` and `socketTimeout === 400`. The session was Selected. The log then contains `imap disconnected: Socket timeout` after one `IDLE`, a `DONE`, and a `NOOP`, and before a second `IDLE`. The trace is not the proof that `false` took effect. | `npm test` |
| AC2 | With `maxIdleTime` 150 and `socketTimeout` 500, a second `IDLE` appears after `DONE`, two socket periods produce no `Socket timeout` line, and one later `EXISTS` saves one message and sends one webhook with no body. | `npm test` |
| AC3 | `IDLE_REFRESH_MS` is `240000`. The two-argument client options set that `maxIdleTime`, set `disableAutoIdle`, and omit `socketTimeout`. | `npm test` |
| AC4 | The 29-minute keepalive test still passes with no fetch on that path. `npm test` exits 0. | `npm test` |

`npm test` is `node --test`. Healthy: exit 0.

## 7. Design decisions

**D1 — The 10-minute log is two 5-minute socket timeouts, and the missing piece is a new IDLE.** Checked 2026-11-01, as FR1 records. The first timeout does write `DONE` and `NOOP`. It does not write a new `IDLE` while `disableAutoIdle` is set and `maxIdleTime` is unset. The adapter ignores the fulfilled `client.idle()`. Five minutes later the connection is quiet and not idling, so `_socketTimeout` emits `Error('Socket timeout')`. `formatLogLine` puts that message in `imap disconnected: Socket timeout`. TCP keep-alive keeps port 993 established until that error closes the socket. Catch-up on the next connection (`src/supervisor.js` after `mailboxOpen`) saves mail that arrived once IDLE was gone. The import at `3cb0e2f` has no refresh of its own. It omits `disableAutoIdle`, and imapflow's `autoidle` starts a new IDLE after the recovery `NOOP` (default delay 15 seconds, inside the next 5-minute period). The harness phase set `disableAutoIdle: true` and did not set `maxIdleTime`. That is the dropped refresh.

**D2 — Set `maxIdleTime` to 4 minutes.** `4 * 60 * 1000` is one minute under the default `socketTimeout` of `300000`. `lib/commands/idle.js` then refreshes inside the `client.idle()` call the adapter already holds, so the wait stays pending and a restart is not a fetch. Rejected: shortening `IDLE_KEEPALIVE_MS`. That constant is the RFC 2177 re-entry, the existing test locks 29 minutes, and it does not run before the 5-minute watchdog. Rejected: clearing `disableAutoIdle`. Auto-IDLE would start a second IDLE the adapter does not own; the harness turned it off for that reason. Rejected: raising `socketTimeout` alone. The first watchdog would still end IDLE, and the error would only move later. Rejected: a config key. The interval is fixed by the library default, not by the mailbox.

**D3 — The regression test is the existing harness, on a short clock.** The harness already runs imapflow 1.7.8 against imapkit and can record `IDLE`, `DONE`, and `NOOP` from the `trace` event. The CI `test` job `timeout-minutes` is 10 for install plus the whole suite, so a wall-clock 10-minute wait does not fit. The failure is no refresh before the socket period: `maxIdleTime` unset, or a refresh that does not fire before that period. The first quiet period then writes `DONE` and `NOOP` and leaves IDLE. The next quiet period raises `Socket timeout`. Two default periods are the observed 10 minutes. The short clock keeps `maxIdleTime < socketTimeout` so the repaired case does not fail that way (`150 < 500` in AC2). The broken case is `maxIdleTime: false` with `socketTimeout: 400` (AC1). A fake-clock unit test would not run `_socketTimeout` or `lib/commands/idle.js`. The production interval is locked by AC3 so the two-argument client stays under 5 minutes. The 29-minute sleeper stays pending, so the pass comes from `maxIdleTime`, not from `raceIdle`.

**D4 — One later merge publishes v0.1.5.** Checked 2026-11-01. `v0.1.4` points at `c69c63029240dea8bdb1cd02bcd22e5b289c712b`, which is `origin/main`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` prints `noop` when HEAD already has a semver tag. Otherwise it reads the squash subject `(#N)` and patch-bumps unless the pull request has `release:minor` or `release:major`. Both labels make the script exit non-zero. The next tag after `v0.1.4` is `v0.1.5`. This intent pull request stays unmerged. Merging it would publish a patch that does not contain the fix. The phase pull request is the merge that publishes `v0.1.5`.

## 8. Open questions

None.
