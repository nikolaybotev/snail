# spec.md — IMAP BigInt and service script name

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

imapflow 1.7.8, the version locked in `package-lock.json`, returns `mailbox.uidValidity` as a BigInt. `createImapFlowClient` copies that value unchanged. The first state write calls `JSON.stringify` and throws `TypeError: Do not know how to serialize a BigInt`. The account catches that error, sleeps, and tries again. No state file and no message file are written.

The integer fix converts a safe BigInt to that number on the IMAP fields Snail copies. A BigInt that is not a safe integer throws before any state or message file is written. A regression test whose fake client returns BigInt covers the account loop. A direct call with a stubbed mailbox result covers `createImapFlowClient`. The same phase renames `scripts/run-service.sh` to `scripts/snail-service.sh` so macOS Login Items shows the product name. One merge of that phase publishes `v0.1.1`. This intent pull request stays unmerged, so it does not publish that tag.

## 2. Goals and non-goals

**Goals**

- G1. A safe BigInt `uidValidity` or `uidNext` becomes that number before mailbox state, message JSON, or the webhook payload is built. A BigInt that is not a safe integer throws before any state or message file is written.
- G2. A regression test drives the account loop with the fake client returning BigInt and checks that state, the saved message, and the webhook `uid` and `uid_validity` are numbers. A separate test calls `createImapFlowClient`'s `mailboxOpen` with a stubbed mailbox result and fails while that method still returns a BigInt.
- G3. The service wrapper file name is `scripts/snail-service.sh`. The LaunchAgent template, the systemd unit, the docs, the archive member list, and the tests use that name.
- G4. Both changes land in the single phase in [plan.md](plan.md). That phase's merge, with neither `release:minor` nor `release:major`, publishes `v0.1.1`.

**Non-goals**

- Changing reconnect backoff. The per-account catch already sleeps. D4.
- The launchd exit-2 mapping tracked in `intent/config-error-restart/` (pull request 13). The rename keeps the wrapper body already on the default branch.
- Adding `modseq` or `highestModseq` to the state file, the message file, or the webhook body.
- Editing `intent/portable-mail/` or `intent/config-error-restart/`.
- A `release:minor` or `release:major` label on the phase pull request.

**Release phasing.** Untagged requirements belong to this change. There is one release, `v0.1.1`, and one phase. Nothing in this spec is deferred to a later release.

## 3. Principles

- P1. JSON files and the webhook body store IMAP integers as numbers. A BigInt must not reach `JSON.stringify` for state, a message record, or the webhook payload.
- P2. Coercion happens on the values copied off the IMAP client, before `ensureMailboxState` and before a UID range is built.
- P3. A value that is already a number stays that number. A BigInt that is not a safe integer is not written as a rounded number.
- P4. The wrapper's exit status stays the behavior already in the script. The rename changes the file name and every reference to it.
- P5. Install docs and service templates keep the existing placeholders. This change adds no personal name, email, hostname, or real path.

## 4. Users and scenarios

A mailbox open returns `uidValidity` as a BigInt and `uidNext` as a number, which is what locked imapflow does. Snail writes `.snail-state.json`, saves new mail, and posts a webhook whose `uid` and `uid_validity` are numbers. The account stays in IDLE.

The same account loop, in CI, uses the fake client. The fake returns BigInt for `uidValidity` and `uidNext`. The loop still writes state and wakes the webhook.

On macOS the LaunchAgent's first program argument is the wrapper script. Login Items shows that file's name: `snail-service.sh`.

## 5. Functional requirements

- FR1. One function converts an IMAP integer. A `bigint` whose `Number` form is a safe integer becomes that number. A `number` is returned unchanged. Any other type is returned unchanged. A `bigint` that is not a safe integer throws before a state file or message file is written.
- FR2. `createImapFlowClient` in `snail.js` applies FR1 to `uidValidity` and `uidNext` on the object returned from `mailboxOpen` (the return at line 137 on `d70d54d`). It keeps returning only those mailbox fields it returns today. It does not copy `highestModseq`. `fetchOne` keeps its explicit field list and does not copy `uid` or `modseq` from the imapflow message. A test passes a stub in place of imapflow. The stub's `mailboxOpen` resolves a BigInt `uidValidity` or `uidNext`. Calling the adapter's `mailboxOpen` returns numbers. That call does not open a network connection. The assertion fails while the return still copies `box.uidValidity` unchanged.
- FR3. `runAccountLoop` applies the same function to `uidValidity` and `uidNext` from every `mailboxOpen` result before those values are used. On `d70d54d` that is the open at lines 254–255 and the exists-path open at lines 305–308. The UID list, `ensureMailboxState`, the saved record, and the webhook `uid` / `uid_validity` are built from the converted numbers.
- FR4. The webhook body keeps the existing keys. `uid` and `uid_validity` are numbers. `modseq` is not a key. A BigInt `modseq` left on a fetched message by the fake client is ignored.
- FR5. `scripts/run-service.sh` is renamed to `scripts/snail-service.sh`. The script body is unchanged, including the existing exit-2 status. References update in `launchd/com.snail.agent.plist` (line 11), `snail.service` (line 8), `README.md` (line 191), `scripts/build.sh` (line 40), `test/install-docs.test.js` (lines 62 and 70–74), and `test/build.test.js` (line 55). Placeholders `/ABS/PATH/TO/HOME` and `/ABS/PATH/TO/node` stay. The archive contains `scripts/snail-service.sh` and does not contain `scripts/run-service.sh`.
- FR6. The phase pull request carries neither `release:minor` nor `release:major`. Its squash-merge to the default branch is the push that publishes `v0.1.1`.

## 6. Acceptance criteria

| ID | Criterion | Check |
|---|---|---|
| AC1 | The fake client's `mailboxOpen` returns `uidValidity` and `uidNext` as BigInt. The account loop writes `.snail-state.json`. `uidValidity`, `notifyBoundary`, `backlogUid`, and `lastUid` are numbers, and the new message file's `uid` and `uid_validity` are numbers. | `npm test` |
| AC2 | That run's webhook body stringifies. `uid` and `uid_validity` are numbers. A BigInt `modseq` on the fake fetch result is absent from the message file and the webhook body. | `npm test` |
| AC3 | FR1's helper maps a safe BigInt to that number, leaves a number as that number, and throws on a BigInt that is not a safe integer. The unsafe value is not written into a state file. | `npm test` |
| AC4 | `npm test` reads the unit `ExecStart` and `README.md` and finds `snail-service.sh`. It finds `scripts/snail-service.sh` in the tree and the tarball, and finds `scripts/run-service.sh` in neither. The plist uses `snail-service.sh`. The wrapper still exits 0 when the child exits 2. Placeholders stay `/ABS/PATH/TO/HOME` and `/ABS/PATH/TO/node`. | `npm test` |
| AC5 | `npm test` exits 0. | `npm test` |
| AC6 | `createImapFlowClient`'s `mailboxOpen`, given a stub whose mailbox result has a BigInt `uidValidity` or `uidNext`, returns those fields as the same numbers. The call does not open a network connection. | `npm test` |

## 7. Design decisions

**D1 — Coerce at the client boundary, once, in both callers.** The production boundary is `createImapFlowClient` (`snail.js` lines 134–137 on `d70d54d`), which today returns `box.uidValidity` and `box.uidNext` unchanged. The account-loop tests pass `createFakeImapClient` (`src/supervisor.js` lines 669–720) to `runAccountLoop`, and `mailboxOpen` returns the stored values (line 720). That fake never enters `snail.js`, so AC1 stays red until the loop coerces, and it stays green if line 137 still returns a BigInt. AC6 calls the adapter's `mailboxOpen` with a stubbed mailbox result, so that return path has its own failure. Both callers use the FR1 function. `Number` is exact for a safe integer. Checked 2026-11-01: `JSON.stringify` of a BigInt throws `TypeError: Do not know how to serialize a BigInt`. `Number(42n)` is `42`. `Number(2n ** 53n + 1n)` is not a safe integer. A 32-bit UIDVALIDITY is a safe integer, and that is what this release saves. A wider value is what imapflow's 19-digit parser round-trips. Saving it with `Number` would store a different integer. The state writer at `src/mail-store.js` line 111 has no `catch`. That throw is the disconnect loop. The message-file `JSON.stringify` at line 416 is the first statement of the `try` that starts at line 415. The `catch` at line 419 absorbs that throw: the save fails, and the account stays up. A BigInt in a message record does not by itself disconnect the account. A rounded number is still a number, so `readSnailState` (lines 85–89) would load it and the mailbox identity would be the wrong one. Those lines reject a non-number, such as a string. The FR1 throw is what keeps the rounded value out of the file.

**D2 — Locked imapflow 1.7.8 field types.** Checked 2026-11-01 against `imapflow@1.7.8` `lib/commands/select.js` and `lib/tools.js`, the version in `package-lock.json`. `uidValidity` is `parseBigIntValue` (BigInt, up to 19 digits, `MAX_NUMBER64_DIGITS`). A 32-bit value is a safe integer. A value past `Number.MAX_SAFE_INTEGER` is inside that 19-digit bound, and FR1 throws for it instead of writing a rounded identity. `highestModseq` is BigInt. `uidNext` is `parseUintValue` with a 10-digit bound (a safe number). Fetch `uid` is the same 10-digit number. Fetch `modseq` is BigInt. Snail's `fetchOne` does not read `uid` or `modseq`. The UID Snail stores is the one it requested after FR3. `modseq` and `highestModseq` stay uncopied, so a 63-bit modseq is never passed through `Number` and never thrown on. The fake-client test still returns a BigInt `modseq` and asserts it is absent from JSON. `uidNext` is a number in this library; the test returns it as BigInt so the helper is what the loop relies on.

**D3 — Rename the wrapper, keep its body.** Login Items shows the file name of the LaunchAgent's first program argument (`launchd/com.snail.agent.plist` line 11). That name becomes `snail-service.sh`. The systemd `ExecStart` (`snail.service` line 8) and `scripts/build.sh` line 40 use the same file. The script's exit-2 handling stays the lines already in `scripts/run-service.sh`. This intent does not take work from `intent/config-error-restart/`.

**D4 — Backoff stays.** Checked on `d70d54d`. After `connect()` succeeds, `runAccountLoop` sets `connectBackoff` back to `CONNECT_INITIAL_BACKOFF_MS` (`src/supervisor.js` lines 247–252). That constant is `INITIAL_BACKOFF_MS`, 5000 (`src/secrets.js` lines 11–12). The state stringify throws after that reset. The `catch` at lines 318–324 logs `imap disconnected` and sleeps `connectBackoff`, then doubles it up to `MAX_BACKOFF_MS` (60000). The next iteration connects again and resets the delay, so the sleep stays 5000 ms. That is the reconnect about every 6 seconds. The catch already backs off. This intent does not change the delay, the reset, or the cap. Removing the throw ends the cycle.

**D5 — One merge publishes v0.1.1.** Checked 2026-11-01. `v0.1.0` points at `d70d54d93d10ec39956ffca2a060b3918ee7f066`. `.github/workflows/release.yml` runs on every push to the default branch. `scripts/release-version.sh` patch-bumps when the merged subject ends with `(#N)` and the pull request has neither `release:minor` nor `release:major`. The next tag after `v0.1.0` is `v0.1.1`. Both labels together make the script exit non-zero. The intent-only pull request stays unmerged: a merge of it would also push the default branch and publish a patch that lacks the fix. The phase pull request is the merge that publishes `v0.1.1`.

Line numbers above were read on `d70d54d`. The phase re-reads them if the default branch has moved.

## 8. Open questions

None.
