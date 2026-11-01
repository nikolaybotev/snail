# spec.md — IMAP integration harness

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 3 |
| Stage | 2 · Design |

## 1. Summary

CI today builds the account loop around `createFakeImapClient`. That fake can hand back a BigInt, and it resolves `idle()` itself. It never runs imapflow's parser over a socket. Production uses imapflow 1.7.8 over a socket. The harness starts an embeddable IMAP server on `127.0.0.1`, passes `createImapFlowClient` into `startSupervisor`, and checks the mail directory, `.snail-state.json`, and a local notifier. The socket is plaintext. Every push to the default branch publishes the next patch tag, so the pull request that only adds this folder stays unmerged (D6).

## 2. Goals and non-goals

**Goals**

- G1. Scenario tests open a real TCP socket to a local IMAP server and use the production imapflow adapter.
- G2. Those tests cover first-start backlog, a live untagged `EXISTS` while `IDLE` stays open, UIDVALIDITY change, resume, large integers, connect failures, webhook auth and failure, OpenClaw wake, and two accounts at once.
- G3. The suite stays on `node --test`. It binds `127.0.0.1` only.
- G4. The adapter surfaces imapflow's `exists` event on the wait the account loop already uses. One keepalive cycle fetches nothing and sends no wake, and that cancelled wait does not later count as `exists`.

**Non-goals**

- Replacing `createFakeImapClient` or deleting the tests that use it.
- The v0.1.2 mocked exists unit test. This intent's IDLE coverage is the live socket case in FR6.
- An HMAC webhook signature. v0.1.1 sends `bearer` or `raw` (D5).
- TLS on the test socket (D2).
- A change to reconnect delays, notify delays, or the saved JSON schema.
- Editing `intent/portable-mail/`, `intent/config-error-restart/`, or `intent/imap-bigint/`.
- Deploying, or merging the pull request that only adds this folder (D6).
- A `release:minor` or `release:major` label on the harness phase.

**Release phasing.** Untagged requirements belong to the one harness phase. Nothing in this spec is deferred to a later release. That phase is also the only merge onto the default branch for this work, so the tag it publishes contains the finished harness (D6).

## 3. Principles

- P1. The body stays in the mail file. The webhook body has the existing keys. The OpenClaw text is the existing sentence.
- P2. A file is durable before a wake. A failed wake does not write the file again.
- P3. Backlog UIDs and UIDs saved for a UIDVALIDITY change do not wake.
- P4. One account's reconnect sleep does not delay another account's save or wake.
- P5. The harness password and the notifier secret are each at least 8 characters, so a log line that would have echoed them shows `[redacted]` instead (D8).
- P6. Fixtures use synthetic account names and `127.0.0.1`. They do not use a personal name, a real mailbox, or a hostname.

## 4. Users and scenarios

An operator's CI job runs `npm test`. New cases start a local IMAP server, then start the supervisor with the production client factory.

On a first start the mailbox already holds mail. Each message is saved. The notifier receives nothing.

The real imapflow client is connected and `IDLE` is open. The server emits an untagged `EXISTS` and leaves that `IDLE` open. The message is saved, and exactly one wake goes out.

The process stops and starts again with the same state file. Mail that arrived while it was down is saved once. Mail already on disk is not saved again.

The server changes UIDVALIDITY. Snail writes a new state file, saves the current messages under the new validity, and does not wake those messages. Older files stay in the directory.

UID `4294967295` arrives after `notifyBoundary` is already that value. The webhook carries that `uid` and that `uid_validity`. A scripted `MODSEQ` of `9223372036854775807` is on the wire, imapflow parses it as that BigInt, and the saved JSON omits it. A UIDVALIDITY past the safe-integer limit throws before any state or message file is written, and the account waits before connecting again.

The server drops the socket, rejects the password, or answers `SELECT` with `NO [UNAVAILABLE]`. A rejected password, and a drop whose later connects also fail, sleeps 5 seconds, then 10, then 20, up to 60. `UNAVAILABLE`, and a drop onto a server that accepts the next connection, each sleeps 5 seconds. None of those waits is zero.

A local HTTP server records webhook headers. It can time out, return a non-2xx status, and check `bearer` and `raw`. A local WebSocket stub records one OpenClaw wake.

Two accounts run together. One is held in a reconnect sleep. The other still saves a new message and wakes.

## 5. Functional requirements

- FR1. The harness server is `imapkit` 5.2.0, MIT, engines `node >= 20`, as a devDependency. Each test listens on `127.0.0.1` and an ephemeral port, one server instance per account. The production factory is `createImapFlowClient` from `snail.js`. Tests call `startSupervisor` with that factory. They do not pass `createFakeImapClient`.
- FR2. The server speaks enough IMAP that imapflow 1.7.8 finishes `connect` and the later `SELECT`, `UID FETCH`, and `IDLE`. Checked 2026-11-01 against unpacked `imapflow@1.7.8` `lib/imap-flow.js`: after the greeting, `startSession` sends `CAPABILITY`, sends `ID` when that capability is present, calls `upgradeToSTARTTLS`, authenticates, sends `NAMESPACE`, then `COMPRESS` unless disabled, then `ENABLE` for capabilities it advertised. Authentication uses `AUTHENTICATE` when `AUTH=PLAIN` or `AUTH=LOGIN` is advertised, and `LOGIN` otherwise (`authenticate`, lines 1959–1970). The phase enables the smallest plugin set in imapkit 5.2.0 that answers those commands and does not advertise `STARTTLS` or `COMPRESS`. `createImapFlowClient` sets `disableAutoIdle: true`.
- FR3. Account `tls` is `off`. The host string passed to imapflow is `127.0.0.1`. The test fails if a socket's remote address is anything else.
- FR4. `createImapFlowClient.idle` fulfills when that connection emits imapflow's `exists` event while the IMAP `IDLE` command is still open. A dropped socket or a failed `IDLE` rejects, so the account loop takes the existing `catch`. `cancelIdle` leaves IMAP IDLE. The promise that was waiting stays ineligible: it does not fulfill as new mail, and a later `exists` on that same wait does not fulfill it and does not cause a second wake. `raceIdle` awaits `cancelIdle` when the call returns a promise, on the keepalive path and the stop path, before the next `idle`.
- FR5. First start, missing `.snail-state.json`, mailbox already holding messages: every existing UID is saved, `notifyBoundary` equals the server `UIDNEXT`, and neither the HTTP receiver nor the WebSocket stub receives a wake.
- FR6. The live IDLE case is this intent's coverage. The real imapflow client is connected, and the server has accepted `IDLE`. The server then emits an untagged `EXISTS` while that `IDLE` stays open: no tagged end to `IDLE` before the `EXISTS`, and the client has not sent `DONE`. The message is saved once. A webhook account sends exactly one `POST`. An OpenClaw account sends exactly one `wake`. The webhook JSON keys are `account`, `from`, `subject`, `date`, `message_id`, `path`, `mailbox`, `uid`, `uid_validity`. `uid` and `uid_validity` are numbers. The wake text is `New email arrived. From: <from> | Subject: <subject> | File: <absolute path>`. The message body is absent from both. The v0.1.2 hotfix, a unit test that mocks the `exists` event without a socket, is not this requirement.
- FR7. Stop the supervisor, leave the directory in place, append one UID, start again. The new UID is saved and woken once. UIDs already on disk are not written again. Every UID from `lastUid + 1` through `UIDNEXT - 1` has a file. A second start with no new mail writes nothing and wakes nothing.
- FR8. `resetUidValidity` (or the same change before the next connect) makes the server UIDVALIDITY differ from `.snail-state.json`. Snail writes a new four-field state before any body fetch, saves the current messages under the new validity, wakes none of them, and leaves the old files in place. A message that arrives after the new `notifyBoundary` is saved and woken once.
- FR9. UID `4294967295` arrives after `notifyBoundary` is already `4294967295`. UIDVALIDITY is `4294967295`. Before the arrival, UIDNEXT is `4294967295` and the directory has no file for that UID. The arrival makes the server report that UID and UIDNEXT `4294967296`. State then holds `uidValidity` `4294967295` and `lastUid` `4294967295`. The message file and the webhook `uid` and `uid_validity` are that number. A first start whose UIDNEXT is already `4294967296`, with UID `4294967295` already in the mailbox, is the no-wake case from FR5.
- FR9a. The MODSEQ case is a scripted response on the wire, with CONDSTORE enabled. `SELECT` carries `HIGHESTMODSEQ` `9223372036854775807` and `FETCH` carries `MODSEQ` of that same value. The test fails when imapflow's parser drops the line. It passes when `highestModseq` or the fetch `modseq` is that BigInt, and `.snail-state.json`, the message file, and the webhook body omit it. Storage that rewrites the value does not count. A `SELECT` whose UIDVALIDITY is `9007199254740993` makes `coerceImapInteger` throw `IMAP integer is not a safe integer` before any state or message file is written. The parser must accept that response: a canned line that imapflow rejects does not satisfy this requirement. The account then uses the FR10 sleep for that unsafe value.
- FR10. Auth failure, and a drop whose following `connect()` calls also fail, log `imap disconnected` and pass `5000`, then `10000`, then `20000` to the injected sleeper, doubling until `60000`. `SELECT` answered with `NO [UNAVAILABLE]`, and a drop onto a server that accepts the next `connect()`, each pass `5000` and do not double: `runAccountLoop` sets `connectBackoff` back to `5000` when `connect()` resolves (`src/supervisor.js` lines 269–270 on `7342fed`), and the failure is after that reset. A successful connect makes the following failure `5000` again. Any of those waits being `0` fails the test. The sleeper is the one `startSupervisor` already accepts. Wall-clock delays stay out of the test. The delay constants stay as they are.
- FR11. The webhook target is an HTTP server on `127.0.0.1`. Timeout: the server accepts the body and does not respond; the injected sleeper resolves the `10000` ms attempt budget; the notifier retries with `1000`, `2000`, `4000`, `8000`, `16000`. On a success path the `10000` call stays pending so the `2xx` wins that race, and the account posts once. Non-2xx: the server returns status `500` six times. Both failure cases leave one message file, do not write a second file on a later sync, and advance `lastUid`. `bearer` sends header `Authorization` with value `Bearer <secret>`. `raw` sends the configured header name with the secret as the whole value. The OpenClaw stub speaks the current handshake: it sends `connect.challenge`, accepts `connect` at protocol 3, and accepts `wake` with `{ text, mode: "now" }`.
- FR12. Two accounts, two servers, two mail directories. Account A's reconnect sleeper is left pending. Account B still saves an IDLE arrival and sends one wake before A's sleeper resolves.
- FR13. `npm test` runs the new file with the existing suite. The test command stays `node --test`. No workflow file changes. The cases do not open a config file. The harness password and the notifier secret are each at least 8 characters. Captured log lines contain `[redacted]` in place of those secrets.
- FR14. Each case arms its own sleeper. A call equal to `idleKeepaliveMs` (the default `29 * 60 * 1000`, which is `1740000`) stays pending until the test releases it. Releasing one keepalive call fetches nothing and sends no wake. The pending-`10000` rule is only the webhook attempt budget: that call stays pending when the HTTP response should win, and it resolves only in the FR11 timeout case. A reconnect delay, including the doubling step of `10000`, is recorded and then released, except the one call FR12 leaves pending. The password and the notifier secret are inline literals, so `resolve()` does not call this sleeper.

## 6. Acceptance criteria

| ID | Criterion | Check |
|---|---|---|
| AC1 | First start saves every pre-existing message and writes `.snail-state.json` with `notifyBoundary` equal to UIDNEXT. The notifier receives no request. | `npm test` |
| AC2 | With the real imapflow client connected and `IDLE` still open, an untagged `EXISTS` saves one message and sends exactly one wake. A webhook account posts once, with the FR6 keys, numeric `uid` and `uid_validity`, and no body. An OpenClaw account sends one wake whose text is the FR6 sentence and whose payload has no body. | `npm test` |
| AC3 | Resume saves and wakes only the UIDs that were not checkpointed, with no gap from `lastUid + 1` to `UIDNEXT - 1`. A second pass writes no file and sends no wake. A UIDVALIDITY change rewrites the four-field state, saves under the new validity, wakes none of those UIDs, and keeps the old files. A later UID at or above the new boundary wakes once. | `npm test` |
| AC4 | UID `4294967295` arrives after `notifyBoundary` is `4294967295`. State holds `uidValidity` `4294967295` and `lastUid` `4294967295`. The webhook `uid` and `uid_validity` are that number. A scripted `HIGHESTMODSEQ` and `FETCH` `MODSEQ` of `9223372036854775807` are parsed as that BigInt, and the state file, the message file, and the webhook body omit it. UIDVALIDITY `9007199254740993` throws `IMAP integer is not a safe integer` and leaves the mail directory without a new state file or message file. | `npm test` |
| AC5 | Auth failure, and a drop whose following connects fail, pass `5000`, then `10000`, then `20000`. `UNAVAILABLE`, and a drop onto a server that accepts the next connect, each pass `5000`. No delay in those sequences is `0`. A successful connect makes the following failure `5000`. | `npm test` |
| AC6 | A hanging webhook and a `500` webhook each produce one saved file, six attempts, and the FR11 delays. A success path leaves the `10000` sleeper pending and posts once. `bearer` and `raw` headers match FR11. The WebSocket stub records one successful wake. | `npm test` |
| AC7 | With account A's reconnect sleep unresolved, account B saves one live IDLE message and wakes once. | `npm test` |
| AC8 | The harness password and the notifier secret are each at least 8 characters. Captured log lines do not contain them. Every IMAP socket observed by the test uses remote address `127.0.0.1`. | `npm test` |
| AC9 | `npm test` exits 0. | `npm test` |
| AC10 | One keepalive cycle fetches nothing and sends no wake. The cancelled `idle()` wait does not later count as `exists`. | `npm test` |

## 7. Design decisions

**D1 — Embeddable server, imapkit 5.2.0.** The harness uses the `imapkit` npm package as a library inside the test process. Checked 2026-11-01: `npm view imapkit` reports version 5.2.0, license MIT, description "Scriptable, strictly RFC compliant in-memory IMAP server for testing IMAP clients", engines `node >= 20`. Its control API appends a message, resets UIDVALIDITY, and disconnects a session. Its script rules can answer `SELECT` with `NO [UNAVAILABLE]` and can drop a connection. The published rule example is `{ on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again later\r\n' }`. `hoodiecrow-imap` 3.3.1 is the older mock from the same vendor and is not the package this spec uses.

Rejected: a from-scratch scripted stub. imapflow 1.7.8 already sends `CAPABILITY`, optional `ID`, `NAMESPACE`, authentication, optional `ENABLE`, then the mailbox commands (FR2). A stub would be a second IMAP stack that has to stay aligned with that client. The scenario control the brief asks for is the control API and the script rules, which this server already has.

The test server keeps its own mailbox in its process. Snail still fetches one UID at a time through imapflow and still writes one file at a time.

**D2 — Plaintext on `127.0.0.1`.** Checked 2026-11-01 on `7342fed`: `createImapFlowClient` sets `secure` from `account.tls === 'on'` and passes no `tls` options (`snail.js` lines 124–130). imapflow 1.7.8 treats `secure: false` as cleartext and still calls `upgradeToSTARTTLS` unless `doSTARTTLS` is `false` (`lib/imap-flow.js` lines 274–285 and 1716–1732). Snail does not set `doSTARTTLS`. A server that advertises `STARTTLS` would upgrade, and Node would verify the certificate with the default trust store. imapkit can listen with a bundled certificate; that certificate is not in the trust store. `NODE_EXTRA_CA_CERTS` is read at process start, and the CI job is one `npm test` process that also runs the rest of the suite. The harness therefore sets `tls` to `off` and uses a server that does not advertise `STARTTLS`. The socket is still a real TCP connection, which is the path the in-memory fake skipped.

**D3 — `exists` is the IDLE wake.** Checked 2026-11-01 against imapflow 1.7.8. `ImapFlow.idle` runs the `IDLE` command and returns when that command ends (`lib/imap-flow.js` lines 3116–3119, `lib/commands/idle.js`). An `EXISTS` line updates the mailbox and emits `exists` (`untaggedExists`, lines 2100–2130). It does not end `IDLE`. `autoidle` starts its own `IDLE` 15 seconds after the connection is idle unless `disableAutoIdle` is set (lines 2317–2338). Snail's adapter awaits `client.idle()` and does not listen for `exists` (`snail.js` lines 171–174). The fake client resolves `idle()` from `triggerExists` (`src/supervisor.js` lines 761–778). `raceIdle` maps any fulfillment to `'exists'` and, on keepalive, calls `cancelIdle` without awaiting it (`src/supervisor.js` lines 436–466 and 323–326).

The harness phase sets `disableAutoIdle: true`, fulfills the adapter's `idle()` only on the `exists` event while `IDLE` is still open, rejects it when the socket drops, and makes `cancelIdle` finish leaving `IDLE` before `raceIdle` calls `idle()` again. The cancelled promise stays ineligible, including for a late `exists`. The keepalive branch still does not fetch. The fake client stays as it is for the existing tests.

`raceIdle` races `client.idle()` against `sleeper(remaining)` (`src/supervisor.js` lines 440–461). `remaining` comes from `idleKeepaliveMs`, default `IDLE_KEEPALIVE_MS` = `29 * 60 * 1000` (line 18). The same sleeper is the reconnect wait and the webhook attempt budget (`src/notifiers/webhook.js` lines 79–96). The suite's `webhookFriendlySleeper` resolves every delay except `10000` immediately (`test/supervisor.test.js` lines 40–48). Copied into this harness, that keepalive sleep wins `Promise.race` before `exists`, and a resolved `10000` turns one successful POST into a timeout. FR14 is the sleeper this harness uses instead. The live case in FR6 is the coverage for new mail. The v0.1.2 hotfix is a separate unit test that mocks `exists` without a socket. That test is not part of this pull request.

**D4 — Which integers the socket must produce.** Checked 2026-11-01 against imapflow 1.7.8 `lib/commands/select.js` and `lib/tools.js`. `UIDVALIDITY` is `parseBigIntValue` with the default 19-digit bound, so a 32-bit value arrives as a BigInt. `UIDNEXT` and fetch `uid` use `parseUintValue` with a 10-digit bound and must be safe integers. `HIGHESTMODSEQ` and fetch `MODSEQ` are BigInt. `4294967295` and `4294967296` are safe integers. `9007199254740993` is `2^53 + 1`, 16 digits, so the BigInt parser accepts it and `coerceImapInteger` throws. `9223372036854775807` is 19 digits, so the MODSEQ parser accepts it. Snail's `fetchOne` still requests `envelope` and `source` and still does not copy `modseq` (`snail.js` lines 142–169). Checked 2026-11-01 against imapkit 5.2.0 `dist/cjs/plugins/condstore.js` lines 66–74: a stored `MODSEQ` is kept only when `Number.isSafeInteger` accepts it. `9223372036854775807` falls through to `bumpModseq`, which stores a small safe integer and does not throw. Storage that performs that replacement does not satisfy AC4. The phase sends the wide `HIGHESTMODSEQ` and `FETCH` `MODSEQ` with a script rule. The test reads the BigInt off the imapflow mailbox or fetch result. A line the parser drops fails the test. UID `4294967295` is inside the 10-digit UID bound and inside `resetUidValidity`'s `2^32 - 1` ceiling. It is a wake only when `notifyBoundary` was already `4294967295` before the message existed (FR9). A first start that already holds that UID is FR5.

**D5 — Bearer and raw, not HMAC.** Checked 2026-11-01 on `7342fed`. `src/notifiers/webhook.js` sets the header to `Bearer <secret>` or to the secret alone (`webhookAuth === 'raw'`). `intent/portable-mail/spec.md` D5 documents those two and the ten-second budget, the 2xx rule, and the retry delays in `src/notifiers/retry.js`: `1000`, `2000`, `4000`, `8000`, `16000`. There is no HMAC field. The brief's HMAC line is this check: the harness asserts `bearer` and `raw`. Adding a signature would be a notifier change, and this intent does not do that.

OpenClaw stays the client in `src/notifiers/openclaw.js`: challenge, `connect` with `minProtocol` 3 and `maxProtocol` 3, `wake` with `{ text, mode: 'now' }`, text from `formatWakeText`. The stub lives on `127.0.0.1`. FR14 arms one sleeper per case. The webhook attempt budget of `10000` stays pending when the response should win. The reconnect step of `10000` is recorded and released. `WEBHOOK_ATTEMPT_TIMEOUT_MS` is that same `10000` (`src/notifiers/webhook.js` line 17), and the sleeper sees only the milliseconds. The five-minute CI job (`test.yml` `timeout-minutes: 5`) does not run the real 5s, 10s, and 31s schedules. The HTTP server and the WebSocket server are still real listeners.

**D6 — This pull request does not merge.** Checked 2026-11-01. `v0.1.1` points at `7342fedb2740a4e46b42d818d76968d12b0774f8`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` prints `noop` when HEAD already has a semver tag. Otherwise it reads the squash subject `(#N)` and patch-bumps unless the pull request has `release:minor` or `release:major`. A merge of this docs-only pull request would publish the next patch with no harness. While `v0.1.1` is the tip, that patch is `v0.1.2`. The v0.1.2 hotfix is a separate mocked exists unit test. It is not a file in this pull request and not a step in the harness phase. The harness phase waits until that hotfix is on the default branch, then publishes the next patch and contains the live suite from FR6. It does not take the `v0.1.2` tag. The phase pull request carries neither release label.

**D7 — Backoff doubles only while connect itself keeps failing.** Checked 2026-11-01 on `7342fed`. After `connect()` resolves, `runAccountLoop` sets `connectBackoff` to `5000` (lines 269–270). The `catch` then sleeps the current delay and doubles it, capped at `60000` (lines 354–360). Auth failure throws inside `connect()`, so the reset does not run. `SELECT` `NO [UNAVAILABLE]` throws from `mailboxOpen`, after the reset, and the next attempt sleeps `5000` again. A drop during `IDLE` does the same once the next `connect()` succeeds. The doubled chain is the path where `connect()` keeps failing. FR10 follows that. The constants stay as they are.

**D8 — Redaction starts at 8 characters.** Checked 2026-11-01 on `7342fed`. `redactKnownSecrets` skips any string shorter than 8 characters (`src/secrets.js` lines 78–86). The harness password and the notifier secret are each at least 8 characters. AC8 is that floor, and the captured lines do not contain the secrets.

Line numbers above were read on `7342fed`, on imapflow 1.7.8 unpacked from the lockfile tarball, and on imapkit 5.2.0 unpacked from the registry tarball. The phase re-reads them if the default branch has moved.

## 8. Open questions

None.
