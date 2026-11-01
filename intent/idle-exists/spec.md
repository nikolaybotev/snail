# spec.md — Live IDLE exists

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

v0.1.1 misses a live EXISTS because the multi-account rewrite dropped the import's `exists` listener. The import at `3cb0e2f` unblocks on `client.once('exists')` (`snail.js` lines 369–372) and then fetches. v0.1.1 (`7342fed`) waits on `await client.idle()` (`snail.js` lines 171–174). `src/supervisor.js` line 442 treats that fulfillment as new mail, and lines 330–344 fetch only after it. An untagged EXISTS does not end that wait. imapflow emits `exists` and leaves IDLE open, and Dovecot leaves the tagged IDLE command open, so the socket stays up. The next process start saves and notifies that message from UIDNEXT (`src/supervisor.js` lines 272–286). On the current code the 29-minute re-entry also saves it. `raceIdle` returns `'keepalive'` while the real `idle()` stays pending (`src/supervisor.js` lines 323–328 and 436–461). The real client has no `cancelIdle`. The next `idle()` fulfills immediately because imapflow is already idling (1.7.8 lines 3116–3119). Line 442 treats that fulfillment as mail, and lines 330–344 save and wake the UID. This phase stops that false fetch and saves on `exists` instead.

The fix restores the import's signal at the adapter. `createImapFlowClient.idle()` fulfills on `exists` only and rejects on `close`. Fulfillment of `client.idle()` is ignored. The existing fetch path stays. One unit test drives that path with a mocked imapflow that emits `exists` while its `idle()` promise stays pending. The later code merge, with neither `release:minor` nor `release:major`, publishes `v0.1.2`. This intent pull request stays unmerged.

## 2. Goals and non-goals

**Goals**

- G1. A message that arrives while the IMAP connection stays open is saved and notified once, without a process restart.
- G2. A regression test fails while the adapter still waits only on `client.idle()`. A mocked imapflow emits `exists` and does not settle `idle()`. The account loop saves that UID and sends one wake.
- G3. Mail that arrives while the process is down is still saved and notified on the next start (`src/supervisor.js` lines 272–286), unchanged. That path uses the same one-UID `syncMessages` as the fetch after `exists` (lines 330–344).

**Non-goals**

- The launchd exit-2 mapping (pull request 13, `intent/config-error-restart/` when that folder exists). This change does not edit the service wrapper.
- The IMAP harness (pull request 15). A live IDLE scenario against a scripted server is that work, not this phase.
- Changing the imapflow range, the locked version, or the constructor options.
- Adding `getMailboxLock`, a NOOP loop, `disableAutoIdle`, or `maxIdleTime`.
- Changing the 29-minute keepalive, or adding `cancelIdle` on the real client.
- Restoring the import's two-pass `fetch` that buffers a UID range before reading bodies.
- Editing `intent/portable-mail/` or `intent/imap-bigint/`.
- A `release:minor` or `release:major` label on the phase pull request.

**Release phasing.** This release is the one phase in [plan.md](plan.md). The live IDLE scenario is not tagged on this spec. It belongs to the harness pull request 15, which is its own intent. A merge of this intent's draft publishes nothing, because that pull request stays unmerged.

## 3. Principles

- P1. Live mail is the `exists` event. Fulfillment of imapflow's `idle()` is not that event.
- P2. The listener is registered before `idle()` is started, which is the import's order.
- P3. After the event, the account still fetches one UID at a time through the existing sync path. The mailbox is not held in memory.
- P4. The saved file is durable before a wake. The body, HTML, and attachment bytes stay out of the notifier.
- P5. Placeholders only. No personal name, email, hostname, machine name, or real account name.

## 4. Users and scenarios

The service is connected and idle. A new message is delivered to the selected mailbox. Dovecot sends an untagged EXISTS and leaves IDLE open. Snail saves the message and sends one wake. The process is not restarted.

The process is down when a message arrives. The next start opens the mailbox, reads UIDNEXT, and saves and notifies that UID. That catch-up path is unchanged.

In CI, a mocked imapflow emits `exists` after the adapter has entered its wait. The mock's `idle()` promise is still pending. The test sees one saved file and one wake.

## 5. Functional requirements

- FR1. The regression is the dropped listener, not an imapflow upgrade. On `3cb0e2f`, `snail.js` lines 365–372 resolve a wait from `client.once('exists')`, and from `close`, and reject from `error`. Line 372 starts `client.idle()` and observes its rejection. Fulfillment of `idle()` is not the signal. The comment on line 364 says `idle()` resolves on EXISTS; the listener is what unblocks. Lines 377–381 then fetch and notify. There is no `getMailboxLock`, no NOOP, and no `disableAutoIdle` or `maxIdleTime`. The constructor (lines 332–341) is host, port, secure, auth, and `logger: false`. `package.json` depends on `imapflow` `^1.3.1` and that commit has no lockfile.
- FR2. v0.1.1 is `7342fed`. `createImapFlowClient` (introduced in `b3a93dc`, still this shape) constructs imapflow with the same kind of options (`snail.js` lines 124–130): host, port, `secure` from `tls === 'on'`, auth, `logger: false`. It does not set `disableAutoIdle` or `maxIdleTime`. The only listener is `client.on('error', () => {})` at line 131. `idle()` at lines 171–174 is `await client.idle()`. `src/supervisor.js` line 442 maps fulfillment of that promise to `'exists'`. Lines 330–344 reopen the mailbox and call `syncMessages`. Lines 272–286 do that same sync after the initial open, which is why the next process start saves the message. The 29-minute re-entry is the other recovery on this code. `raceIdle` (lines 436–461) returns `'keepalive'` at lines 323–328 and does not cancel the real IDLE. The following `idle()` fulfills immediately, line 442 maps it to `'exists'`, and lines 330–344 save the UID. `createFakeImapClient.triggerExists` (lines 773–778) resolves the fake `idle()` promise. It does not emit `exists`.
- FR3. Checked 2026-11-01 against the published builds. imapflow 1.3.1 `lib/imap-flow.js` `untaggedExists` (lines 1378–1401) and 1.7.8 `untaggedExists` (lines 2100–2130) emit `exists` and do not finish IDLE. `idle()` (1.3.1 lines 2250–2253, 1.7.8 lines 3116–3119) returns only when the IDLE command finishes, or immediately if the connection is already idling. `lib/commands/idle.js` in both versions finishes IDLE when another command's preCheck writes `DONE`, or when `maxIdleTime` is set. NOOP, STATUS, or SELECT polling runs only when the server does not advertise IDLE. Dovecot advertises IDLE. An untagged EXISTS does not complete the tagged IDLE command (RFC 2177), so the socket stays open and `await client.idle()` stays pending. The locked version on v0.1.1 is 1.7.8. The range is still `^1.3.1`. The event contract matches 1.3.1, so the miss is the rewrite, not the bump from an unlocked 1.3.1 to the locked 1.7.8.
- FR4. `createImapFlowClient.idle()` fulfills only when that imapflow client emits `exists`. It rejects when that client emits `close`. Register both listeners on the client before calling `client.idle()`. The wait `raceIdle` is holding is the one that settles, so line 442 stays the mail signal and a drop reaches the catch at `src/supervisor.js` lines 354–360. Fulfillment of `client.idle()` does not settle the adapter wait. That includes the immediate `undefined` when already idling (1.7.8 `lib/imap-flow.js` lines 3116–3119) and the `false` returned when IDLE fails (1.3.1 `lib/commands/idle.js` lines 117–126, 1.7.8 lines 139–151). `ImapFlow.idle()` does not reject on a drop. `close()` rejects the in-flight IDLE exec (1.7.8 `lib/imap-flow.js` lines 2646–2683) and emits `close` (line 2808). The IDLE command catches that rejection and still returns `false`. After the 29-minute re-entry the open IDLE belongs to the earlier call, and the current `idle()` has already fulfilled `undefined`. The `close` listener is on the client, so that drop still rejects the wait `raceIdle` is holding. A wait that `raceIdle` has already left does not reject later. The empty `error` handler at `snail.js` line 131 stays. `emitError` (line 627) calls `closeAfter` (line 2539), which schedules `close()`. The constructor options stay as they are. AC1–AC3 do not cover the drop. This release adds no second test for it.
- FR5. `src/supervisor.js` keeps line 442 and lines 330–344. Adapter fulfillment is still the `'exists'` result. The fetch is still `mailboxOpen`, then `syncMessages`, one UID at a time. That `mailboxOpen` is the next IMAP command. imapflow's preCheck writes `DONE` and ends the IDLE command. This release does not call `getMailboxLock`, does not send NOOP, and does not set `disableAutoIdle` or `maxIdleTime`. It does not change `package.json` or the lockfile.
- FR6. A UID at or above `notifyBoundary` that is above `lastUid` is saved and woken once. The next-start catch-up in lines 272–286 is unchanged. A notifier failure does not delete or rewrite the file and does not save it again. The wake carries metadata only.
- FR7. The regression test installs a mocked imapflow before `snail.js` loads, using the same preload pattern as `test/imap-client-ac6-runner.js`. The mock is an event emitter. `connect` opens nothing on the network. `idle()` returns a promise the test does not settle. After the account loop has called `idle()`, the test raises UIDNEXT, serves one new message from `fetchOne`, and emits `exists`. The loop uses `createImapFlowClient` as its factory. The test asserts that UID is saved and that the notifier is called once, while the mock `idle()` promise is still pending. The assertion fails while `snail.js` lines 171–174 still wait only on `client.idle()`. Placeholders are `imap.example.com` and `you@example.com`. `createFakeImapClient.triggerExists` is not this test.
- FR8. The phase pull request carries neither `release:minor` nor `release:major`. Its squash-merge to the default branch is the push that publishes `v0.1.2`.

## 6. Acceptance criteria

| ID | Criterion | Check |
|---|---|---|
| AC1 | With a seeded later-run state, the mocked imapflow emits `exists` after `idle()` is called and does not settle `idle()`. The new UID is saved. The notifier runs once. The mock `idle()` promise is still pending. | `npm test` |
| AC2 | The same test fails while `createImapFlowClient.idle()` is only `await client.idle()`. | `npm test` |
| AC3 | `npm test` exits 0. The run does not open a network socket and does not read a real account. | `npm test` |

## 7. Design decisions

**D1 — The regression is the dropped `exists` listener.** The known-good baseline is the scrubbed import `3cb0e2f`, `snail.js` lines 360–386. The connected loop opens the mailbox (line 351), catch-up fetches, then waits on `exists` (lines 365–372) and fetches (lines 377–381). The rewrite `b3a93dc` replaced that wait with `await client.idle()` and left the fetch behind fulfillment of that promise. v0.1.1 still has that shape. imapflow 1.3.1 and 1.7.8 both emit `exists` without ending IDLE, and both poll with NOOP only when IDLE is missing. Neither Snail version takes a mailbox lock or sets idle options. An untagged EXISTS does not end the v0.1.1 wait, so the connection stays up. The next start saves the message from lines 272–286. On the current code the 29-minute re-entry also saves it, because the second `idle()` fulfills immediately and line 442 treats that as mail (FR2). Checked 2026-11-01 by reading those commits and the two imapflow builds named in FR3 and FR4. No live server was contacted.

**D2 — Put the listener back on the adapter, and keep the fetch.** `createImapFlowClient.idle()` is the only place that sees the imapflow emitter. `runAccountLoop` sees the adapter. Fulfilling the adapter wait on `exists` makes line 442 and lines 330–344 run. The following `mailboxOpen` breaks IDLE the way the import's `fetch` did: the next command's preCheck writes `DONE`. A drop rejects that wait on `close` (FR4), so the catch at lines 354–360 reconnects. `client.idle()` fulfills on a drop, with `false`. It does not reject. Ignoring that fulfillment, and the immediate `undefined` when already idling, is what stops the false fetch on the 29-minute re-entry. After this phase the message is saved on `exists`. Rejected: waiting until `idle()` fulfills. Rejected: treating an already-idling `idle()` return as mail. Rejected: a rejection handler on `client.idle()`, which never sees the drop. Rejected: `getMailboxLock`, a NOOP loop, `disableAutoIdle`, and `maxIdleTime`. The import did not need them. Rejected: porting the import's range `fetch` that collects every envelope before reading bodies. The current sync already fetches one UID at a time. Rejected: a second test for the drop. AC1–AC3 stay the exists test.

**D3 — The regression test mocks imapflow, not the in-memory fake.** `triggerExists` resolves a promise. A test that calls it stays green while line 173 still awaits `client.idle()`. The new test must emit `exists` and leave `idle()` pending, and it must go through `createImapFlowClient` so the listener under test is the production one. The preload runner exists so the stub is in place before `snail.js` loads. The 29-minute keepalive test stays on the fake client. This release does not add `cancelIdle` to the real adapter. The real keepalive still does not write `DONE`. Stopping the false fetch at that re-entry is the ignored `idle()` fulfillment in D2, not a new keepalive.

**D4 — One later merge publishes v0.1.2.** Checked 2026-11-01. `v0.1.1` points at `7342fedb2740a4e46b42d818d76968d12b0774f8`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` patch-bumps when the merged subject ends with `(#N)` and the pull request has neither `release:minor` nor `release:major`. The next tag after `v0.1.1` is `v0.1.2`. Both labels together make the script exit non-zero. This intent pull request stays unmerged. Merging it would publish a patch that does not contain the fix. The phase pull request is the merge that publishes `v0.1.2`.

**D5 — The harness live scenario is a separate intent.** Pull request 15 is the IMAP harness. It should later add a live IDLE scenario on a local scripted server. This spec does not include that scenario, that server, or a change to the harness. The launchd exit-2 work is also outside this intent.

## 8. Open questions

None. The signal is the `exists` event (D2). The live server scenario is the harness's, not this release (D5).

## 9. What was checked

Checked 2026-11-01, the tree and the published imapflow builds. No live IMAP server.

- Import `3cb0e2f` `snail.js`: IDLE loop lines 351 and 360–386, constructor lines 332–341, no mailbox lock, no NOOP, no idle options. `package.json` `imapflow` `^1.3.1`, no `package-lock.json`.
- Rewrite `b3a93dc` `snail.js` lines 168–171: `await client.idle()` and no `exists` listener. `git log -S "once('exists'"` shows the listener added in `3cb0e2f` and removed in `b3a93dc`.
- v0.1.1 `7342fed`: `snail.js` lines 124–131 and 171–174; `src/supervisor.js` lines 272–286, 330–344, 442, and 773–778. `package-lock.json` resolves imapflow 1.7.8. The range is still `^1.3.1`.
- imapflow 1.3.1 and 1.7.8 `lib/imap-flow.js` `untaggedExists` and `idle()`, and `lib/commands/idle.js`: emit `exists`, finish IDLE only on `DONE` or `maxIdleTime`, NOOP only without the IDLE capability. The IDLE catch returns `false` (1.3.1 lines 117–126, 1.7.8 lines 139–151). 1.7.8 `close()` rejects the in-flight command (lines 2646–2683) and emits `close` (line 2808). `emitError` (line 627) calls `closeAfter` (line 2539).
- `src/supervisor.js` lines 323–328, 354–360, and 436–461: keepalive does not cancel a client without `cancelIdle`, and the account catch is the reconnect.
- `.github/workflows/release.yml` and `scripts/release-version.sh`: a default-branch push with neither release label patch-bumps. `v0.1.1` is the current tag, so the next patch is `v0.1.2`.
