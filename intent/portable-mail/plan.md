# plan.md — Portable mail

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 4 |
| Status | Draft 4 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. Do not open build pull requests until the build gate below has been run and its findings are in the spec and the plan. Do not merge the pull request that only adds `intent/portable-mail/`.

The first-run cursor is decided in spec D15. Release scope through all phases is D16. No phase reopens either.

## Models

Fresh-context review of this spec and this plan uses Grok 4.7 High. Every build phase uses Composer 2.5. Do not substitute. If the named model cannot be launched, stop and ask.

## Stops

None. Secret handling is D7. The first-run cursor is D15. Release scope through all phases is D16.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit. Model: Grok 4.7 High.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against `spec.md`. It does not edit. Model: Grok 4.7 High.
4. Apply those findings the same way.
5. Build only after both reviews have been applied. One phase below is one pull request. Model: Composer 2.5. D15 is already decided.

The draft pull request is not a build phase. Squash-merge a build phase only when its checks are green. Never use an admin override. Do not merge a docs-only pull request before the test workflow exists on that branch. Phase 0 contains the test workflow, so it is the first phase that can merge.

After Phase 0 and the CodeQL workflow have merged, the owner adds required status checks named `test` and `javascript`. This plan does not create rulesets, required checks, or other admin settings. Until those checks are required, a phase still has to show `test` and `javascript` green.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` config-path, mode, and owner cases | 1 |
| AC2 | `npm test` subset and schema cases | 1 |
| AC3 | `npm test` two-account isolation case, including two gateway sockets | 5 |
| AC4 | `npm test` later-run new mail, unfinished backlog, and `uidValidity` resync | 5 |
| AC5 | `npm test` directory lookup, including a changed envelope timestamp | 3 |
| AC6 | `npm test` limit cases | 3 |
| AC7 | `npm test` webhook key set, bare address, and `date` | 4 |
| AC8 | `npm test` fake OpenClaw handshake, one connection per account | 4 |
| AC9 | `npm test` failing webhook, immediate first attempt, no redirect, and the outcome line | 4, 5 |
| AC10 | `npm test` inline value, references, redaction, and absence from message and state files | 1, 2, 5 |
| AC11 | `npm test` reload add, change, remove, and comment-only save | 6 |
| AC12 | `npm test` rejected, partial, and identical reload | 6 |
| AC13 | `npm test` unit and plist assertions, including exit 2 | 7 |
| AC14 | `npm test` archive and checksums; `--version` lines once `snail.js` serves them | 0, 5 |
| AC15 | `npm test` release-version cases | 8 |
| AC16 | `npm test` backoff sequence for failed connects and for a failed secret resolve | 2, 5 |
| AC17 | `npm test` first-run boundary, checkpoint, stream, disk full, and a second account | 3, 5 |

`npm test` is `node --test`. Healthy: exit 0. Phase 0's workflow is the CI run required by spec FR14.

## Phase 0 — Guardrails and CI

Files: `AGENTS.md`, `REVIEW.md`, `README.md`, `.github/workflows/test.yml`, `.github/workflows/codeql.yml`, `scripts/build.sh`, `package.json`, `package-lock.json`, `.gitignore`, `test/build.test.js`

1. Write `AGENTS.md` from the skill template. Commands: install `npm ci`; test `npm test` (healthy: exit 0); lint none; build `bash scripts/build.sh`. Point at `intent/portable-mail/`. State that the spec wins and that a plan departure is recorded in this file in the same change.
2. Prohibitions in `AGENTS.md`, and the Bugs and Important lines in `REVIEW.md`: sending a body to a notifier; waking a backlog UID or a UID from a UIDVALIDITY resync; losing or re-saving mail because a notifier failed; a secret on the command line, in a log, or in a file this program writes; loading or reloading a config that is group- or world-readable or not owned by the service user; one account blocking another, including its backlog blocking another account; a duplicate save; skipping catch-up after downtime; holding the mailbox in memory; waking a message whose file is not durable; a reload that reconnects an account whose parsed entry did not change; a rejected reload that drops the live config or exits.
3. `REVIEW.md` uses the three passes from the skill template (Bugs, Security, Compliance). Compliance includes a missing plan-departure note.
4. Keep `README.md` accurate for the imported single-account daemon, and point at `intent/portable-mail/`. Phase 7 replaces the install section. Do not describe live reload or the new secret rules as already shipping.
5. Workflow `test`, job name `test`, `ubuntu-latest`, `timeout-minutes: 5`, Node 26, `npm ci`, `npm test`. It runs on pull requests and on pushes. Workflow `CodeQL`, job name `javascript`, language JavaScript, `timeout-minutes: 15`.
6. `scripts/build.sh` writes the D9 archive from an explicit member list. This phase lists the files already in the tree that D9 names (`package.json`, `package-lock.json`, `README.md`, `LICENSE`, the daemon source that exists, and generated `build-stamp.json`). Each later phase that adds a D9 member updates that list in the same change. Rejected: packing the whole work tree except `node_modules`, `.git`, and `dist/`. That would ship tests, intent drafts, and workflow files, which D9 does not list. `package.json` `engines` is `>=26 <27` and `version` stays `0.0.0`. Commit `package-lock.json`. Ignore `dist/` and `build-stamp.json`.
7. `test/build.test.js` sets `VERSION` and asserts the tarball and `SHA256SUMS`. With `VERSION` unset and no git tag to describe, `scripts/build.sh` exits non-zero. Also `node --check snail.js`. `--version` is not this phase: `snail.js` does not serve it yet.

DoD: `npm test` exits 0.

## Phase 1 — TOML config

Files: `src/toml-subset.js`, `src/config.js`, `snail.example.toml`, `test/toml-subset.test.js`, `test/config.test.js`

1. Port the subset and the `mode & 077 == 0` check from spec D1 and D2. Also refuse a file whose owner uid is not the process uid. Do not add a TOML dependency.
2. Implement the `[[account]]` schema, defaults, and errors from D3. Inline secret strings are valid. `keychain://` and `op://` references are valid. Startup errors and the usage line from FR1 and FR2. Error text does not include the rejected value.
3. Tests cover AC1 and AC2, including boolean, dotted key, inline table, relative `mail_dir`, duplicate name, duplicate `mail_dir`, mode `0644`, a mismatched owner, and no file body in the output. An inline password loads. A planted secret in a schema error is absent from the message.
4. Add `snail.example.toml` to the `scripts/build.sh` member list in this same change.
5. Do not switch `snail.js` off its JSON file in this phase.

DoD: `npm test` exits 0.

**Phase 1 departures (implemented):**

- Parse-error redaction replaces only inline secret literals of at least 8 characters, so short placeholder values in tests and minimal configs do not corrupt `line N:` messages that happen to contain the same substring.
- Invalid `name` values that fail `[A-Za-z0-9_-]+` use `line N: expected a string for name` (spec names the pattern but not a dedicated error string).

## Phase 2 — Secret resolvers

Files: `src/secrets.js`, `test/secrets.test.js`

1. Implement D7. `keychain://` uses `execFile` on `/usr/bin/security` with the argument list in the spec. No shell. Read the `op` token from `SNAIL_OP_TOKEN_FILE` or from `$CREDENTIALS_DIRECTORY/op-token`, and pass those bytes only as the `op` child's `OP_SERVICE_ACCOUNT_TOKEN`, with `OP_BIOMETRIC_UNLOCK_ENABLED=false`. Do not copy them into snail's environment or argv. Discard the child's stderr. Tests inject both runners and do not spawn `op` or `security`.
2. Cache a successful resolve for the life of that account until a reload restarts it. A second call in the same life returns the cache and does not call the runner. A failure uses the FR6 delays, 5s then 10, 20, 40, and 60, under the injected sleeper, and does not delay another account.
3. Cover the resolver half of AC10 and the resolver half of AC16: inline values need no runner; both reference forms parse; a Linux `keychain://` runner failure stays on that account; a planted secret is absent from logs and from every argv the resolver builds; stderr from the runner is absent from the log; redaction replaces the secret with `[redacted]`.

DoD: `npm test` exits 0.

## Phase 3 — Mail store

Files: `src/mail-store.js`, `test/mail-store.test.js`

1. Implement section 6, D6, D11, D12, and D15's state record. The first-run and resync record is one write of all four fields before any body: `uidValidity`, `notifyBoundary` = `UIDNEXT`, `backlogUid` = 0, `lastUid` = `UIDNEXT - 1`. A missing, empty, or unreadable file uses that write. Do not use the imported `{ lastUID: 0 }` fallback. After that, stream one message to a temporary file and rename it. Persist `backlogUid` only after a durable backlog file, and do not wake that UID. Persist `lastUid` for a UID at or above `notifyBoundary` only after the notify outcome. That later write must not drop `notifyBoundary` or move `lastUid` below it, or the next run would treat backlog as new mail. Create `mail_dir` if missing. Directory lookup is on `uidValidity` and UID. Apply the size limits. Do not accumulate messages in a list.
2. Tests cover AC5, AC6, and the store half of AC17. No network. The four-field write happens before a body is offered. A UID below `notifyBoundary` is not woken even when `lastUid` is still 0. A failed write leaves `backlogUid` unchanged and does not wake. An existing file is not rewritten. A new UID whose `lastUid` is still below it, and which is at or above the boundary, is woken once.

DoD: `npm test` exits 0.

## Phase 4 — Notifiers

Files: `src/notifiers/openclaw.js`, `src/notifiers/webhook.js`, `test/notifiers.test.js`

1. One OpenClaw client per account. Port the handshake from spec D5. Do not keep the process-global socket. The socket connect-on-drop behavior is Phase 5. Webhook posts exactly the D5 keys, `application/json`, no redirects, success only on 2xx inside 10 seconds. A response that arrives after 10 seconds is a failure. `bearer` is `<webhook_header>: Bearer <secret>`. `raw` is the secret as that header's value.
2. The first attempt is immediate. Later delays come from an injected sleeper (FR9). Retries use the secret passed in. They do not call the resolver.
3. Tests cover AC7 and AC8 against local fakes, and the immediate-attempt and no-redirect parts of AC9. The injected clock reaches 10 seconds with no response, counts a failure, and shows that a redirect during that wait is not followed. A test fails if the webhook body has any other key.

DoD: `npm test` exits 0.

## Phase 5 — One process, many accounts

Files: `snail.js`, `src/supervisor.js`, `test/supervisor.test.js`

1. `snail.js` serves FR1 before anything else. `--version` and `--version --verbose` need no config, exit 0, and run when the Node major is not 26. Any other start missing `--config` exits 2. Then the Node 26 check (D13) exits 1 for another major. On loop start, delete that account's leftover `*.tmp-*` files and leave finished `.json` files. Delete the inlined process-global gateway and the ignored positional config path. Assert both version lines against a built stamp, and assert a planted `*.tmp-*` is gone.
2. Each loop resolves its own secrets once, then owns its backoff and notify retry (FR4, FR5, FR6, D6, D7). Reconnect and notify use the cache. Connect that account's OpenClaw socket when the loop starts and again when the socket drops, with the cached token, without calling the resolver and without waiting for the next message. A drop on one account does not move another account's socket.
3. Logs follow FR11: a UTC ISO-8601 timestamp, then `[snail]` or `[snail] [<account>]`. The notify outcome is `notify ok` or `notify failed` with the account name, UID, and attempt count (FR9). A test plants a secret and an authorization header value and fails if either appears. The message file and `.snail-state.json` from that run also fail AC10 if the secret appears.
4. Fake IMAP client that can report `UIDNEXT`, `UIDVALIDITY`, and one message at a time. `idle()` fulfilling re-enters IDLE without a fetch. An injected clock fires the 29-minute re-entry and asserts no fetch. `exists` fetches. Close and error use the backoff. Tests cover AC3, AC4, AC9, AC16, and AC17. The isolation test uses the injected sleeper and finishes in under a second: one account's backlog does not delay the other's save and wake. A test asserts this process's argv is only the Node binary, the script, `--config`, and the absolute path.
5. A missing, empty, or unreadable state file, and a `UIDVALIDITY` change, each persist all four D15 fields in one write before the first body fetch. Reset `backlogUid` to 0 and `lastUid` to `UIDNEXT - 1` on that write. Do not keep the previous mailbox's cursors, and do not fall back to `{ lastUID: 0 }`. A later run, including a clean restart, fetches both ranges: backlog from `backlogUid + 1` through `notifyBoundary - 1` is saved and not woken; every UID above `lastUid` is saved and woken. A wake is UID versus `notifyBoundary` only. A crash resumes from `backlogUid`. A full disk stops that account's backlog, keeps the checkpoint, and lets the other account continue.
6. Config is read once at startup in this phase. Phase 6 adds reload. Do not advertise reload in the README yet.

DoD: `npm test` exits 0.

**Phase 5 departures (implemented):**

- `scripts/build.sh` copies the `src/` tree in this phase because `snail.js` loads modules from it; phase 7 still expands the D9 member list for service install files.
- The FR6 connect-backoff acceptance check in `test/supervisor.test.js` simulates the per-failure delay sequence directly with an injected sleeper (same 5s→60s cap as `runAccountLoop`) instead of spinning a long-lived failing IMAP connect loop in-process.
- The 29-minute IDLE keepalive check exercises `raceIdle` with an injected clock and fake IMAP `cancelIdle`, not a full `runAccountLoop` integration run.

## Phase 6 — Live reload

Files: `src/config-reload.js`, `src/config-watch.js`, `test/config-reload.test.js`, `snail.js`

1. Port `decideConfigReload` from `drop-box-watcher/ConfigReload.swift` (spec D4): `keepAndLog`, `unchanged`, and `applyAndLog`. Compare parsed rows by `name`, including the `password`, `webhook_secret`, and `openclaw_token` strings. Equality is that text, not the resolved secret. A changed secret string is a changed row. Rejection strings and `[redacted]` replacement match the spec. Owner and mode failures reject the reload. Log `config reloaded` before the diff is applied.
2. Watch the config file's parent with `fs.watch`. Ignore other filenames. Re-read by path. Do not exit. One extra read after the watch is armed. A watch setup failure logs `config watch failed` and keeps the loaded config.
3. The watch callback records the diff and returns without waiting for a logout or a reconnect. Apply runs inside the affected account's loop, so a hung logout cannot delay another account or the reload decision. Equal rows, including a comment-only save, are not reconnected and are not resolved again. Added, changed, and removed rows touch only those accounts. A changed or removed account finishes the current UID through D6 if the rename has already started, and otherwise aborts before any write, including the temporary file. Removed accounts leave mail and state on disk. Removing the last account is `missing account` and keeps the live config.
4. Tests cover AC11 and AC12 by calling the reread function, plus one test that writes the file and sees `fs.watch` trigger a reload. The planted secret is absent from the rejection log. A changed secret string restarts only that account. `config reloaded` is logged before the other account's connection id changes. One test holds a logout until after another account has saved.

DoD: `npm test` exits 0.

## Phase 7 — Service install and README

Files: `snail.service`, `launchd/com.snail.agent.plist`, `scripts/run-service.sh`, `README.md`, `test/install-docs.test.js`

1. Replace the system unit and the `sudo` install with D8. `Restart=on-failure` and `RestartPreventExitStatus=2`. Example plist label `com.snail.agent`, `LimitLoadToSessionType` `Aqua`, `KeepAlive` `SuccessfulExit` false. `scripts/run-service.sh` exits 0 when node exits 2. Placeholders only: `/ABS/PATH/TO/HOME`, `/ABS/PATH/TO/node`. No LaunchDaemon.
2. Rewrite `README.md` so a stranger can copy `snail.example.toml` to `~/.config/snail/config.toml`, set mode `0600`, own it as the service user, install the user service on Linux and the LaunchAgent on macOS, and see the saved-message schema. Document live reload, and document D15: a first run and a UIDVALIDITY resync save the mailbox without waking, and a later run wakes mail that arrived during downtime. Document D16: the release that completes this plan includes every phase, inline secrets in that mode-`0600` config, and the `keychain://` and `op://` paths from D7. Document D7 in full: Keychain on macOS via `/usr/bin/security`, `op://` ids on Linux, the 1,000-request daily limit and the about-3 versus 1 request costs, inline read-only mailbox passwords as the fallback, the token only in the `op` child's environment, read from `SNAIL_OP_TOKEN_FILE` or `$CREDENTIALS_DIRECTORY/op-token`, and the same-user threat note from D7. Show `security add-generic-password` with `-w` last and no secret after it. Do not show `-w` followed by a secret, and do not show `-A`. Say the service runs while that user is logged in, and that exit 2 does not restart.
3. Add the unit, the plist, and `scripts/run-service.sh` to the `scripts/build.sh` member list. Assert the archive contains those files, `snail.example.toml`, `README.md`, `LICENSE`, `package.json`, `package-lock.json`, and `build-stamp.json`, and does not contain `node_modules` or `.git`.
4. Tests cover AC13. Assert the unit and plist contain `--config`, `RestartPreventExitStatus=2` or the wrapper's exit-2 mapping, and no `sudo`, no token, and no secret literal. The example TOML may contain `REPLACE-WITH-` placeholders.

DoD: `npm test` exits 0.

## Phase 8 — Release workflow

Files: `.github/workflows/release.yml`, `scripts/release-version.sh`, `test/release-version.test.js`

1. Implement D10. The workflow runs on push to the default branch, job name `publish`, `timeout-minutes: 15`, `ubuntu-latest`. It does not run on pull requests.
2. Tests cover AC15, including the first tag `v0.1.0`, patch, minor, major, both labels, and `noop` when HEAD is already tagged. A fixture whose subject does not end with `(#N)` exits non-zero and does not print a tag. Label lookup is injectable so the test does not call the network.
3. Do not push a tag from the build pull request. The workflow pushes the tag only on the default branch, after a green build of that commit.

DoD: `npm test` exits 0.

## Owner step after the workflows merge

The owner adds required status checks for the stable job names `test` and `javascript` after Phase 0's test workflow and CodeQL workflow are on the default branch. Later phases squash-merge only when the checks that apply to them are green. No admin override.
