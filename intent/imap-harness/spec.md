# spec.md — IMAP integration harness

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 1 |
| Stage | 2 · Design |

## 1. Summary

CI today builds the account loop around `createFakeImapClient`. That fake can hand back a BigInt, and it resolves `idle()` itself. It never runs imapflow's parser over a socket. Production uses imapflow 1.7.8 over a socket. The harness starts an embeddable IMAP server on `127.0.0.1`, passes `createImapFlowClient` into `startSupervisor`, and checks the mail directory, `.snail-state.json`, and a local notifier. The socket is plaintext. Every push to the default branch publishes the next patch tag, so the pull request that only adds this folder stays unmerged (D6).

## 2. Goals and non-goals

**Goals**

- G1. Scenario tests open a real TCP socket to a local IMAP server and use the production imapflow adapter.
- G2. Those tests cover first-start backlog, IDLE arrival, UIDVALIDITY change, resume, large integers, connect failures, webhook auth and failure, OpenClaw wake, and two accounts at once.
- G3. The suite stays on `node --test`. It binds `127.0.0.1` only.
- G4. The adapter surfaces imapflow's `exists` event on the wait the account loop already uses, and a keepalive does not turn into a fetch.

**Non-goals**

- Replacing `createFakeImapClient` or deleting the tests that use it.
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
- P5. A secret used by a harness account does not appear in a log line.
- P6. Fixtures use synthetic account names and `127.0.0.1`. They do not use a personal name, a real mailbox, or a hostname.

## 4. Users and scenarios

An operator's CI job runs `npm test`. New cases start a local IMAP server, then start the supervisor with the production client factory.

On a first start the mailbox already holds mail. Each message is saved. The notifier receives nothing.

While the account is in IDLE, one message arrives. That message is saved, and exactly one wake goes out.

The process stops and starts again with the same state file. Mail that arrived while it was down is saved once. Mail already on disk is not saved again.

The server changes UIDVALIDITY. Snail writes a new state file, saves the current messages under the new validity, and does not wake those messages. Older files stay in the directory.

A mailbox reports a large safe UID and UIDVALIDITY, and a MODSEQ past `Number.MAX_SAFE_INTEGER`. Safe values land as JSON numbers. The wide MODSEQ does not appear in JSON and does not throw. A UIDVALIDITY past the safe-integer limit throws before any state or message file is written, and the account waits before connecting again.

The server drops the socket, rejects the password, or answers `SELECT` with `NO [UNAVAILABLE]`. The account sleeps 5 seconds, then 10, then 20, up to 60, and does not spin.

A local HTTP server records webhook headers. It can time out, return a non-2xx status, and check `bearer` and `raw`. A local WebSocket stub records one OpenClaw wake.

Two accounts run together. One is held in a reconnect sleep. The other still saves a new message and wakes.

## 5. Functional requirements

- FR1. The harness server is `imapkit` 5.2.0, MIT, engines `node >= 20`, as a devDependency. Each test listens on `127.0.0.1` and an ephemeral port, one server instance per account. The production factory is `createImapFlowClient` from `snail.js`. Tests call `startSupervisor` with that factory. They do not pass `createFakeImapClient`.
- FR2. The server speaks enough IMAP that imapflow 1.7.8 finishes `connect` and the later `SELECT`, `UID FETCH`, and `IDLE`. Checked 2026-11-01 against unpacked `imapflow@1.7.8` `lib/imap-flow.js`: after the greeting, `startSession` sends `CAPABILITY`, sends `ID` when that capability is present, calls `upgradeToSTARTTLS`, authenticates, sends `NAMESPACE`, then `COMPRESS` unless disabled, then `ENABLE` for capabilities it advertised. Authentication uses `AUTHENTICATE` when `AUTH=PLAIN` or `AUTH=LOGIN` is advertised, and `LOGIN` otherwise (`authenticate`, lines 1959–1970). The phase enables the smallest plugin set in imapkit 5.2.0 that answers those commands and does not advertise `STARTTLS` or `COMPRESS`. `createImapFlowClient` sets `disableAutoIdle: true`.
- FR3. Account `tls` is `off`. The host string passed to imapflow is `127.0.0.1`. The test fails if a socket's remote address is anything else.
- FR4. `createImapFlowClient.idle` fulfills when that connection emits imapflow's `exists` event. A dropped socket or a failed `IDLE` rejects, so the account loop takes the existing `catch`. `cancelIdle` leaves IMAP IDLE and does not by itself fulfill `idle` as new mail. `raceIdle` awaits `cancelIdle` when the call returns a promise, on the keepalive path and the stop path, before the next `idle`.
- FR5. First start, missing `.snail-state.json`, mailbox already holding messages: every existing UID is saved, `notifyBoundary` equals the server `UIDNEXT`, and neither the HTTP receiver nor the WebSocket stub receives a wake.
- FR6. A message appended while `IDLE` is active is saved once. A webhook account sends exactly one `POST`. An OpenClaw account sends exactly one `wake`. The webhook JSON keys are `account`, `from`, `subject`, `date`, `message_id`, `path`, `mailbox`, `uid`, `uid_validity`. `uid` and `uid_validity` are numbers. The wake text is `New email arrived. From: <from> | Subject: <subject> | File: <absolute path>`. The message body is absent from both.
- FR7. Stop the supervisor, leave the directory in place, append one UID, start again. The new UID is saved and woken once. UIDs already on disk are not written again. Every UID from `lastUid + 1` through `UIDNEXT - 1` has a file. A second start with no new mail writes nothing and wakes nothing.
- FR8. `resetUidValidity` (or the same change before the next connect) makes the server UIDVALIDITY differ from `.snail-state.json`. Snail writes a new four-field state before any body fetch, saves the current messages under the new validity, wakes none of them, and leaves the old files in place. A message that arrives after the new `notifyBoundary` is saved and woken once.
- FR9. A safe large mailbox uses UIDVALIDITY `4294967295` and UID `4294967295`, with UIDNEXT `4294967296`. State, the message file, and the webhook `uid` and `uid_validity` are those numbers. The same session's `SELECT` carries `HIGHESTMODSEQ` `9223372036854775807`, and `FETCH` carries `MODSEQ` of that same value, when `CONDSTORE` is on. Those fields are absent from `.snail-state.json`, the message file, and the webhook body, and the save does not throw. A `SELECT` whose UIDVALIDITY is `9007199254740993` makes `coerceImapInteger` throw `IMAP integer is not a safe integer` before any state or message file is written. The parser must accept that response: a canned line that imapflow rejects does not satisfy this requirement. The account then uses the FR10 sleep.
- FR10. A dropped connection, a rejected password, and `SELECT` answered with `NO [UNAVAILABLE]` each log `imap disconnected` and pass `5000`, then `10000`, then `20000` to the injected sleeper, doubling until `60000`. The test fails if any of those waits is `0`. A later successful connect passes `5000` again on the following failure. The sleeper is the one `startSupervisor` already accepts. Wall-clock delays stay out of the test.
- FR11. The webhook target is an HTTP server on `127.0.0.1`. Timeout: the server accepts the body and does not respond; the injected sleeper runs the existing `10000` ms attempt budget; the notifier retries with `1000`, `2000`, `4000`, `8000`, `16000`. Non-2xx: the server returns status `500` six times. Both cases leave one message file, do not write a second file on a later sync, and advance `lastUid`. `bearer` sends header `Authorization` with value `Bearer <secret>`. `raw` sends the configured header name with the secret as the whole value. The OpenClaw stub speaks the current handshake: it sends `connect.challenge`, accepts `connect` at protocol 3, and accepts `wake` with `{ text, mode: "now" }`.
- FR12. Two accounts, two servers, two mail directories. Account A's reconnect sleeper is left pending. Account B still saves an IDLE arrival and sends one wake before A's sleeper resolves.
- FR13. `npm test` runs the new file with the existing suite. The test command stays `node --test`. No workflow file changes. The cases do not open a config file. Inline synthetic secrets are redacted in log lines captured by the test.

## 6. Acceptance criteria

| ID | Criterion | Check |
|---|---|---|
| AC1 | First start saves every pre-existing message and writes `.snail-state.json` with `notifyBoundary` equal to UIDNEXT. The notifier receives no request. | `npm test` |
| AC2 | One message appended during IDLE is saved once. A webhook account posts once, with the FR6 keys, numeric `uid` and `uid_validity`, and no body. An OpenClaw account sends one wake whose text is the FR6 sentence and whose payload has no body. | `npm test` |
| AC3 | Resume saves and wakes only the UIDs that were not checkpointed, with no gap from `lastUid + 1` to `UIDNEXT - 1`. A second pass writes no file and sends no wake. A UIDVALIDITY change rewrites the four-field state, saves under the new validity, wakes none of those UIDs, and keeps the old files. A later UID at or above the new boundary wakes once. | `npm test` |
| AC4 | UIDVALIDITY `4294967295` and UID `4294967295` are numbers in state, the message file, and the webhook body. MODSEQ `9223372036854775807` does not appear in those JSON documents and does not throw. UIDVALIDITY `9007199254740993` throws `IMAP integer is not a safe integer` and leaves the mail directory without a new state file or message file. | `npm test` |
| AC5 | Drop, bad password, and `NO [UNAVAILABLE]` pass the FR10 delays to the sleeper. No delay in that sequence is `0`. A successful connect restores a following delay of `5000`. | `npm test` |
| AC6 | A hanging webhook and a `500` webhook each produce one saved file, six attempts, and the FR11 delays. `bearer` and `raw` headers match FR11. The WebSocket stub records one successful wake. | `npm test` |
| AC7 | With account A's reconnect sleep unresolved, account B saves one IDLE message and wakes once. | `npm test` |
| AC8 | Captured log lines do not contain the synthetic password or notifier secret. Every IMAP socket observed by the test uses remote address `127.0.0.1`. | `npm test` |
| AC9 | `npm test` exits 0. | `npm test` |

## 7. Design decisions

**D1 — Embeddable server, imapkit 5.2.0.** The harness uses the `imapkit` npm package as a library inside the test process. Checked 2026-11-01: `npm view imapkit` reports version 5.2.0, license MIT, description "Scriptable, strictly RFC compliant in-memory IMAP server for testing IMAP clients", engines `node >= 20`. Its control API appends a message, resets UIDVALIDITY, and disconnects a session. Its script rules can answer `SELECT` with `NO [UNAVAILABLE]` and can drop a connection. The published rule example is `{ on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again later\r\n' }`. `hoodiecrow-imap` 3.3.1 is the older mock from the same vendor and is not the package this spec uses.

Rejected: a from-scratch scripted stub. imapflow 1.7.8 already sends `CAPABILITY`, optional `ID`, `NAMESPACE`, authentication, optional `ENABLE`, then the mailbox commands (FR2). A stub would be a second IMAP stack that has to stay aligned with that client. The scenario control the brief asks for is the control API and the script rules, which this server already has.

The test server keeps its own mailbox in its process. Snail still fetches one UID at a time through imapflow and still writes one file at a time.

**D2 — Plaintext on `127.0.0.1`.** Checked 2026-11-01 on `7342fed`: `createImapFlowClient` sets `secure` from `account.tls === 'on'` and passes no `tls` options (`snail.js` lines 124–130). imapflow 1.7.8 treats `secure: false` as cleartext and still calls `upgradeToSTARTTLS` unless `doSTARTTLS` is `false` (`lib/imap-flow.js` lines 274–285 and 1716–1732). Snail does not set `doSTARTTLS`. A server that advertises `STARTTLS` would upgrade, and Node would verify the certificate with the default trust store. imapkit can listen with a bundled certificate; that certificate is not in the trust store. `NODE_EXTRA_CA_CERTS` is read at process start, and the CI job is one `npm test` process that also runs the rest of the suite. The harness therefore sets `tls` to `off` and uses a server that does not advertise `STARTTLS`. The socket is still a real TCP connection, which is the path the in-memory fake skipped.

**D3 — `exists` is the IDLE wake.** Checked 2026-11-01 against imapflow 1.7.8. `ImapFlow.idle` runs the `IDLE` command and returns when that command ends (`lib/imap-flow.js` lines 3116–3119, `lib/commands/idle.js`). An `EXISTS` line updates the mailbox and emits `exists` (`untaggedExists`, lines 2100–2130). It does not end `IDLE`. `autoidle` starts its own `IDLE` 15 seconds after the connection is idle unless `disableAutoIdle` is set (lines 2317–2338). Snail's adapter awaits `client.idle()` and does not listen for `exists` (`snail.js` lines 171–174). The fake client resolves `idle()` from `triggerExists` (`src/supervisor.js` lines 761–778). `raceIdle` maps any fulfillment to `'exists'` and, on keepalive, calls `cancelIdle` without awaiting it (`src/supervisor.js` lines 436–466 and 323–326).

The harness phase sets `disableAutoIdle: true`, fulfills the adapter's `idle()` only on the `exists` event, rejects it when the socket drops, and makes `cancelIdle` finish leaving `IDLE` before `raceIdle` calls `idle()` again. The keepalive branch still does not fetch. The fake client stays as it is for the existing tests.

**D4 — Which integers the socket must produce.** Checked 2026-11-01 against imapflow 1.7.8 `lib/commands/select.js` and `lib/tools.js`. `UIDVALIDITY` is `parseBigIntValue` with the default 19-digit bound, so a 32-bit value arrives as a BigInt. `UIDNEXT` and fetch `uid` use `parseUintValue` with a 10-digit bound and must be safe integers. `HIGHESTMODSEQ` and fetch `MODSEQ` are BigInt. `4294967295` and `4294967296` are safe integers. `9007199254740993` is `2^53 + 1`, 16 digits, so the BigInt parser accepts it and `coerceImapInteger` throws. `9223372036854775807` is 19 digits, so the MODSEQ parser accepts it. Snail's `fetchOne` still requests `envelope` and `source` and still does not copy `modseq` (`snail.js` lines 142–169). The phase uses imapkit storage or `resetUidValidity` when that API accepts the value. When 5.2.0 refuses a value, the phase uses a script `send` that imapflow parses as that field. A line the parser drops does not count as AC4.

**D5 — Bearer and raw, not HMAC.** Checked 2026-11-01 on `7342fed`. `src/notifiers/webhook.js` sets the header to `Bearer <secret>` or to the secret alone (`webhookAuth === 'raw'`). `intent/portable-mail/spec.md` D5 documents those two and the ten-second budget, the 2xx rule, and the retry delays in `src/notifiers/retry.js`: `1000`, `2000`, `4000`, `8000`, `16000`. There is no HMAC field. The brief's HMAC line is this check: the harness asserts `bearer` and `raw`. Adding a signature would be a notifier change, and this intent does not do that.

OpenClaw stays the client in `src/notifiers/openclaw.js`: challenge, `connect` with `minProtocol` 3 and `maxProtocol` 3, `wake` with `{ text, mode: 'now' }`, text from `formatWakeText`. The stub lives on `127.0.0.1`. The injected sleeper drives webhook timeouts and reconnect waits so the five-minute CI job (`test.yml` `timeout-minutes: 5`) does not spend the real 5s, 10s, and 31s schedules. The HTTP server and the WebSocket server are still real listeners.

**D6 — This pull request does not merge.** Checked 2026-11-01. `v0.1.1` points at `7342fedb2740a4e46b42d818d76968d12b0774f8`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` prints `noop` when HEAD already has a semver tag. Otherwise it reads the squash subject `(#N)` and patch-bumps unless the pull request has `release:minor` or `release:major`. A merge of this docs-only pull request would publish `v0.1.2` with no harness. The harness phase is the merge that publishes the next patch, and that patch contains this folder and the passing suite. If another tag lands first, that patch is the next one after the tag on the default branch at merge time, still one patch, still with the harness. The phase pull request carries neither release label.

Line numbers above were read on `7342fed` and on imapflow 1.7.8 unpacked from the lockfile tarball. The phase re-reads them if the default branch has moved.

## 8. Open questions

None.
