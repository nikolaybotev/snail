# spec.md — Portable mail

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 1 |
| Stage | 2 · Design |

## 1. Summary

Snail is one Node.js process that watches many IMAP accounts over IDLE. Each account saves new messages as JSON files and wakes its own notifier with metadata only. The config is one TOML file in the same format and the same location style as [backup-folder](https://github.com/nikolaybotev/backup-folder). Adding, changing, or removing an account is a live reload: the process does not restart, and accounts whose entries did not change keep their IMAP sessions.

## 2. Goals and non-goals

**Goals**

- G1. Keep the imported OpenClaw gateway wake path working, and add a webhook notifier. Each account chooses one. The body never leaves the saved file.
- G2. One process, many accounts, one config file. A failing account does not stop or delay the others.
- G3. Live reload. An added, changed, or removed account takes effect without a service restart and without disturbing the other accounts.
- G4. User-level systemd service and user-level launchd LaunchAgent. No root. Restart on failure.
- G5. Secret references only. `op://` stays. An unattended Mac can use the Keychain. Resolved secrets are not logged, not passed on the command line, and not written into the config.
- G6. A tagged GitHub release whose artifact installs on both systems, with docs a stranger can follow.
- G7. Tests for reconnect and backoff, catch-up, duplicate saves, size limits, account isolation, notifier failure, and live reload.

**Non-goals**

- Classifying, triaging, or sending mail.
- Replacing the imported OpenClaw handshake with a newer gateway protocol.
- Publishing to a package registry, shipping a container image, or shipping a per-OS binary.
- Hot reload of an in-memory secret when the config text did not change. Rotating the value behind the same reference applies on that account's next connect.

**Release phasing.** Untagged requirements belong to the first release, including live reload. There is no later release in this spec.

## 3. Principles

- P1. Every wake path sends metadata only. The body, HTML, and attachment bytes never go to a notifier.
- P2. The message file is saved, and last-seen state is advanced, before notify. A notifier failure does not delete, rewrite, or save the message again.
- P3. One account must not stop or delay another, including during secret resolution, reconnect backoff, notify retry, and config reload.
- P4. The config holds references only. A resolved secret is not a command-line argument, not a log line, and not a file this program writes.
- P5. A rejected reload keeps the live config. The process does not exit.
- P6. An account whose config entry is unchanged is not reconnected, relogged, or re-notified by a reload.
- P7. The spec wins over the plan.

## 4. Users and scenarios

- An operator copies the example TOML to `~/.config/snail/config.toml`, sets mode `0600`, and runs one user service with `--config` and that absolute path.
- The operator adds a `[[account]]` block and saves. The new account connects. Accounts already in IDLE stay in IDLE.
- The operator removes one block. That account logs out. The others stay connected. Mail files and state already on disk are left in place.
- One IMAP login fails. The other account still saves and notifies.
- A webhook returns an error. One file exists for that message. A later catch-up does not write a second file.
- An agent or a webhook receiver learns From, Subject, date, message id, path, and mailbox, then reads the JSON file itself.

## 5. Functional requirements

- FR1. The process is started as `snail --config /absolute/path.toml`. A missing argument, or a path that does not begin with `/`, exits 2 and prints `usage: snail --config /abs/config.toml`. `--version` prints the stamp and exits 0. `--version --verbose` includes the full git SHA and the UTC build time.
- FR2. The config file is TOML, parsed by the port of backup-folder's subset described in D1. Mode bits must include nothing for group or other (`mode & 077 == 0`). Otherwise the process exits 2 at startup with `config permissions too open` and does not print the file. A read error at startup exits 2 with `config io error: ` plus the message. A parse error at startup exits 2 with `config parse error: ` plus the parser message.
- FR3. The file is a list of `[[account]]` tables plus optional top-level limit keys. The schema, defaults, and errors are D3. At least one account is required (`missing account`).
- FR4. Each account has its own IMAP connection, its own mail directory (absolute), its own state file, its own notifier, and its own reconnect loop. The loops start together. Secret resolution and network I/O for one account happen inside that account's loop.
- FR5. On a successful mailbox open, the account catches up from its saved `lastUid` before entering IDLE, and it does this again after every reconnect. A changed `uidValidity` sets `lastUid` back to 0 so catch-up runs. IDLE is the imported shape: wait for exists, close, or error, then fetch.
- FR6. Reconnect backoff starts at 5 seconds, doubles, and caps at 60 seconds. It resets to 5 seconds after a successful connect. Tests inject the sleeper. The delays are per account.
- FR7. Saving a message follows D6 and D11. Names are sortable and unique. An existing file for the same `uidValidity` and UID is not written again and is not notified again.
- FR8. Bodies and attachments obey D12.
- FR9. Notifiers obey D5. Notify retry is five attempts, delays 1s, 2s, 4s, 8s, 16s, inside that account's loop. The outcome log is `notify ok` or `notify failed` with the account name, UID, and attempt count. It does not include the payload, the secret, or the authorization header.
- FR10. Live reload obeys D4.
- FR11. Logs are UTC ISO-8601 timestamps, prefixed `[snail] [<account>]` once the account is known. Startup lines that are not for one account use `[snail]`. Logs do not contain the message body, HTML, attachment bytes, resolved secrets, or authorization header values.
- FR12. Install examples obey D8. The README documents both installs, the TOML file, the secret references, the live-reload behavior, and the saved-message schema.
- FR13. The release obeys D9 and D10.
- FR14. Tests are Node's built-in `node:test`. IMAP is a mock client with `connect`, `mailboxOpen`, `fetch`, `idle`, and `logout`. CI does not need a network IMAP server. Notifier tests use a local fake WebSocket and a local fake HTTP server.

## 6. Saved-message schema

This schema is the JSON file agents read. It is not the TOML config.

File name: `{YYYYMMDD}T{HHMMSS}Z_{uidValidity}_{uid}` with the UID zero-padded to 10 digits, then `.json`. The timestamp is the message's envelope date in UTC. If that date is missing, the timestamp is the save time and `date_source` is `saved`; otherwise `date_source` is `message`.

Example name: `20261101T031500Z_42_0000000123.json`.

The file is written to a temporary name in the same directory and renamed into place. Mode is `0600`. Leftover `*.tmp-*` files in that account's mail directory are removed when that account's loop starts.

```json
{
  "uid": 123,
  "uid_validity": 42,
  "message_id": "<id@example.com>",
  "from": "Ada <ada@example.com>",
  "to": "Box <box@example.com>",
  "subject": "Hello",
  "date": "2026-11-01T03:15:00.000Z",
  "date_source": "message",
  "body": "plain text",
  "text_truncated": false,
  "html_body": "<p>plain text</p>",
  "html_truncated": false,
  "attachments": [
    {
      "filename": "note.txt",
      "content_type": "text/plain",
      "size": 12,
      "content": "aGVsbG8=",
      "omitted": false
    }
  ]
}
```

`html_body` and `html_truncated` are omitted when the message has no HTML. `attachments` is omitted when there are none. `content` is omitted and `omitted` is true when the attachment exceeds the limit. `message_id` is an empty string when the message has none. There is no password field.

State file: `<mail_dir>/.snail-state.json`, mode `0600`, shape `{ "uidValidity": <number>, "lastUid": <number> }`. It is not a message file. Agents match the name pattern above. Removing an account does not delete the mail directory or the state file. Adding that name and directory again resumes `lastUid`.

## 7. Acceptance criteria

| ID | Check |
|---|---|
| AC1 | A TOML file of two `[[account]]` entries loads; a JSON config is rejected. `--config` requires an absolute path. Mode `0644` exits 2 with `config permissions too open` and the file body is absent from the output. |
| AC2 | The subset errors in D1 match, including `line N: boolean`, `line N: dotted key`, and `line N: inline table`. Unknown keys and a relative `mail_dir` fail with `line N:` messages. |
| AC3 | Two accounts in one process use two mail directories. A hung connect on one does not stop the other from saving. The test finishes in under a second with the injected sleeper. |
| AC4 | After a saved `lastUid`, only higher UIDs are fetched. A new `uidValidity` fetches from the start and does not overwrite old files. |
| AC5 | A second delivery of the same UID and `uidValidity` does not write a second file and does not notify. |
| AC6 | Over-long text and HTML are truncated and flagged. An over-size attachment stores metadata with `omitted: true` and no `content`. |
| AC7 | The webhook JSON has only the keys in D5. A test fails if `body`, `html_body`, or attachment content is present. |
| AC8 | The OpenClaw fake server records protocol 3, payload v2, method `wake`, and the metadata sentence in D5. The sentence's path is absolute. |
| AC9 | A webhook that always fails leaves one file, advances `lastUid`, logs `notify failed`, and a later catch-up does not write again. |
| AC10 | A planted secret string is absent from logs, from snail's argv, and from the written config and message files. `password = "inline"` is a config error. |
| AC11 | Rewriting the TOML to add an account starts that account only. Changing one account restarts that account only. Removing one account logs only that account out. The other account's mock connection id is unchanged and `logout` was not called on it. |
| AC12 | A bad rewrite while running logs `config reload rejected:` , keeps the previous accounts connected, does not exit, and does not contain a planted secret. An identical rewrite logs nothing and reconnects nothing. |
| AC13 | The example unit and plist restart on failure, run as the invoking user, pass `--config` with an absolute placeholder path, and contain no secret literal. |
| AC14 | `bash scripts/build.sh` with `VERSION` set writes the tarball and `SHA256SUMS`. `--version --verbose` prints that version, the full SHA, and a `built` timestamp. |
| AC15 | The version script prints `v0.1.0` when no semver tag exists, a patch bump by default, and the minor or major bump for one label. Both labels make it exit non-zero. |

## 8. Design decisions

**D1 — TOML subset, ported.** The config language is the TOML subset implemented in `Sources/ToolConfig/TomlSubset.swift` in [backup-folder](https://github.com/nikolaybotev/backup-folder), checked 2026-11-01. Snail ships that parser as a Node module. Values are strings, integers, arrays of strings, tables, and arrays of tables. Comments are `#`. Keys are bare. Basic strings accept `\\` and `\"` only.

The port rejects, with the same `line N:` reasons: `bad table header`, `dotted key`, `duplicate key <name>`, `expected key = value`, `invalid key`, `expected a value`, `multiline string`, `literal string`, `inline table`, `bad escape`, `unterminated string`, `unterminated array`, `expected a string in the array`, `expected a comma in the array`, `array elements must be basic strings`, `invalid integer`, `float`, `boolean`, `date`, `unsupported value`, `unexpected trailing characters`.

Rejected: the current `snail-config.json` next to the script; `smol-toml` and `@iarna/toml`. A third-party parser accepts booleans, floats, inline tables, and dotted keys, and its errors are not these lines. The two tools would not feel the same. JSON has no comments and no `[[table]]` rows.

**D2 — Same config-file and location conventions.** Checked 2026-11-01 against these files in backup-folder:

- `backup-folder.example.toml` — repo-root example. The header says to copy it to `~/.config/backup-folder/config.toml`, mode `0600`, and not to commit the real file. Rows are `[[folder]]`.
- `docs/backup-job.md` — one config, one agent; adding an item is another table row, not another agent.
- `docs/setup.md` and `launchd/backup-folder.plist.template` — the process is started with `--config` and an absolute path. The template's placeholder is `/ABS/PATH/TO/HOME/.config/backup-folder/config.toml`. launchd does not expand `~`.
- `Sources/backup-folder/main.swift` — a config path that does not start with `/` is usage, exit 2. Permissions are checked with `configPermissionsAcceptable` before the file is parsed. Failure prints `config permissions too open` and returns 2. A read failure prints `config io error`.

Snail matches that shape:

- Example committed at `snail.example.toml`. Header: copy to `~/.config/snail/config.toml`, mode `0600`, replace placeholders, do not commit the real file.
- The service arguments use the absolute placeholder `/ABS/PATH/TO/HOME/.config/snail/config.toml`. Docs tell the operator to replace `/ABS/PATH/TO/HOME`.
- Invocation is `snail --config <absolute path>` only. There is no two-directory shortcut and no default path, because backup-folder does not invent a config path either.
- Permissions and startup errors are FR2. The check is the same bitwise test (`mode & 077 == 0`).

drop-box-watcher takes a positional config path (`usage: drop-box-watcher <config-path>` in `drop-box-watcher/main.swift`) and stores its file at `~/.config/drop-box-watcher/config.toml`. Snail follows backup-folder's `--config` flag, and the same `~/.config/<tool>/config.toml` location style both tools use.

**D3 — `[[account]]` schema.** backup-folder's rows are flat keys on `[[folder]]` (`source`, `dest`, optional `retention`) because the subset reports `line N: dotted key` and attaches every `[name]` header to the root. Snail stays inside that subset. Notifier fields are flat keys on the row, not a nested table.

```toml
# Example only. Copy to ~/.config/snail/config.toml, use mode 0600, and replace placeholders.
# Do not commit the real file.

text_limit = 10000
html_limit = 100000
attachment_limit = 10485760

[[account]]
name = "work"
host = "imap.example.com"
port = 993
tls = "on"
user = "you@example.com"
password = "op://Vault/Item/field"
mailbox = "INBOX"
mail_dir = "/ABS/PATH/TO/mail/work"
notifier = "webhook"
webhook_url = "https://example.invalid/hook"
webhook_secret = "keychain://snail/work-hook"
webhook_auth = "bearer"
webhook_header = "Authorization"

[[account]]
name = "home"
host = "imap.example.com"
user = "you@example.com"
password = "keychain://snail/home-imap"
mailbox = "INBOX"
mail_dir = "/ABS/PATH/TO/mail/home"
notifier = "openclaw"
openclaw_url = "http://127.0.0.1:18789"
openclaw_token = "op://Vault/Item/field"
```

Required on every row: `name`, `host`, `user`, `password`, `mail_dir`, `notifier`. Defaults: `port` 993, `tls` `on`, `mailbox` `INBOX`, and `openclaw_url` `http://127.0.0.1:18789` when the notifier is `openclaw`. Top-level `text_limit`, `html_limit`, and `attachment_limit` default to 10000, 100000, and 10485760. The same keys on a row override the top level for that account. This is the same layering as backup-folder's file-level `retention` and per-folder `retention`.

`name` matches `[A-Za-z0-9_-]+`. `tls` is the string `on` or `off` (the subset's `line N: boolean` rejects `true` and `false`). `notifier` is `webhook` or `openclaw`. `password`, `webhook_secret`, and `openclaw_token` are secret references (D7), never raw secrets. Webhook keys are required for `webhook` and are errors on an `openclaw` row (`line N: <key> is only valid when notifier is webhook`). OpenClaw token is required for `openclaw` and is an error on a webhook row. `webhook_auth` is `bearer` (default) or `raw`. `webhook_header` defaults to `Authorization` and must be a single token with no spaces or line breaks.

Errors use backup-folder's style: `missing <key>`, `line N: unknown key <key>`, `line N: expected a string for <key>`, `line N: expected an integer for <key>`, `line N: expected an array of tables for account`, `line N: <key> must be an absolute path`, `line N: duplicate name`, `line N: duplicate mail_dir`. Limits are integers greater than or equal to 1. `port` is an integer from 1 to 65535. Duplicate `mail_dir` is lexical after stripping a trailing slash, the same idea as `line N: duplicate dest` in `BackupConfig.swift`. Symlink-identical directories are not detected.

`webhook_url` follows `webhookURLAllowed` in `drop-box-watcher/Config.swift`: `https` is allowed; `http` is allowed only for host `127.0.0.1` or `localhost` with an explicit port; otherwise `line N: webhook url not allowed`. `openclaw_url` is `http` or `https` and must not contain userinfo (`line N: openclaw_url must not contain credentials`). The client rewrites the leading `http` to `ws`, which is the imported behavior and also turns `https` into `wss`.

The watcher's schema rejects integers and arrays of tables (`integer value is not allowed`, `array of tables is not allowed` in `Config.swift`). Snail does not copy those two schema bans: backup-folder's own config uses integers (`concurrency`) and `[[folder]]`. Snail uses integers for `port` and the limits, and `[[account]]` for the repeated rows.

**D4 — Live reload is required.** Checked 2026-11-01. drop-box-watcher is not a separate repository. The backup-folder README points at it inside the same repo. The behavior ported is:

- `drop-box-watcher/main.swift` loads the config once, exits 2 on a bad startup file, then constructs `ConfigWatch`, calls `start()`, then `reloadNow()`, and does not exit the process (`dispatchMain()`).
- `drop-box-watcher/ConfigWatch.swift` watches the config file's parent directory, ignores events whose file name is not the config file, re-reads by the configured path, and does not exit. If the watch cannot be created it logs an error and keeps serving. `reloadNow` reads once more after the watch is armed.
- `drop-box-watcher/ConfigReload.swift` returns `keepAndLog`, `unchanged`, or `applyAndLog`. A failed re-read keeps the live config and logs `config reload rejected: ` plus `config permissions too open`, `config parse error: <message>`, or `config io error`. The in-memory webhook key is replaced with `[redacted]` in that line. An equal config is a no-op with no log line. A new config logs `config reloaded` and then swaps.
- `applyReloadedConfig` in `main.swift` retargets the single watch folder. That is correct for one folder. It is not correct for many accounts.

Snail's running process uses that decision function and that watch sequence. The apply step is an account diff, because a full retarget would disturb accounts that did not change:

- Compare rows by `name`. Comparison uses the config text (including secret references), not resolved secret values.
- Equal row: do not logout, connect, resolve, or notify. The mock connection id stays the same (AC11).
- Added name: start that account's loop only.
- Removed name: logout that account only. Leave its mail directory and `.snail-state.json` on disk.
- Changed row: stop and start that account only.
- Bookkeeping is synchronous. Secret resolution and IMAP for a started or restarted account run inside that account's loop, so a slow resolver cannot delay the others (P3).
- A rejected reload does not stop any loop and does not exit (AC12).
- Startup still exits 2. Reload never exits. The reload I/O reason is `config io error` with no OS text, matching `ConfigReload.swift`. Startup may append the OS message, matching `main.swift`.
- Every resolved secret currently in memory is replaced with `[redacted]` in a rejection line. Parser errors must not echo the offending value.
- The log line `config reloaded` is written before the diff is applied.

The watch API is Node `fs.watch` on the parent directory. On macOS that is FSEvents, which is the same facility `FSEventStreamCreate` uses in `ConfigWatch.swift`. On Linux it is inotify. CoreServices is not available on Linux, and this service has to reload on both systems. Events whose filename is present and is not the config basename are ignored. A missing filename still re-reads; an equal result is `unchanged`. If `fs.watch` cannot start, log `config watch failed` and keep the loaded config, matching the watcher's non-fatal `FSEventStreamCreate` failure. Tests call the reread function directly, and one test writes the file through `fs.watch`.

Rejected: deferring reload until a restart; reloading by exiting so systemd or launchd starts a new process; retargeting every account on any edit.

**D5 — Notifiers.** Each account has one notifier.

Webhook: HTTPS POST, or the local `http` exception in D3. The JSON object has exactly these keys: `account`, `from`, `subject`, `date`, `message_id`, `path`, `mailbox`, `uid`, `uid_validity`. `path` is the absolute saved file. `webhook_auth` `bearer` sends `Authorization: Bearer <secret>` (or the configured header name). `raw` sends the secret as that header's value. The secret is resolved at notify time and is not logged.

OpenClaw: the imported client stays. Checked against `snail.js` on the default branch and against the public gateway docs on 2026-11-01 (`https://docs.openclaw.ai/concepts/architecture`, `https://docs.openclaw.ai/gateway/protocol/handshake`). The docs describe protocol 4 and a v3 device payload. The imported client speaks protocol 3 (`minProtocol` 3, `maxProtocol` 3), device-auth payload `v2` (`v2|deviceId|cli|cli|role|scopes|signedAt|token|nonce`), scopes `operator.read`, `operator.write`, and `operator.admin`, client id `cli`, platform `linux`, and `wake` with `{ text, mode: "now" }`. A new Ed25519 key is generated per connection. The default URL is `http://127.0.0.1:18789`, which the architecture page lists as the gateway default. The first release keeps that client, including `platform: linux` on macOS, so the wake path stays the one that already runs. A handshake upgrade is out of scope.

The wake text stays the imported sentence, with an absolute path: `New email arrived. From: <from or unknown> | Subject: <subject or (no subject)> | File: <absolute path>`. No body.

**D6 — Save, then notify.** Order for one new UID: if the final file already exists, advance `lastUid` if needed and do not notify. Otherwise write the temp file, rename, write `.snail-state.json`, then notify. Retry does not write the file again and does not move `lastUid` backward. After the attempt budget, log `notify failed` and continue. The next process start does not notify that UID again. A crash after rename and before state save is caught by the existing-file rule: no second file, no second notify. Receivers treat `account`, `mailbox`, `uid`, and `uid_validity` as the idempotency key.

The imported daemon already saves and advances `lastUid` before `wake`, and a failed wake is only logged. This decision adds in-process retry and the existing-file guard. It does not rewind state.

**D7 — Secrets.** Two reference schemes. Anything else, including a raw password, is `line N: <key> must be a secret reference`.

- `op://<rest>` with no whitespace. Resolved by `op read --no-newline <reference>`. The reference is the argument. The secret is stdout and is never logged. Non-zero exit fails that account.
- `keychain://<service>/<account>` with one slash and both parts non-empty. Resolved on macOS by `security find-generic-password -w -s <service> -a <account>`. The secret is stdout, not an argument. On Linux, resolution fails that account with `secret resolution failed` and the others continue. CI fakes both runners and does not call `op` or `security`.

The example unit and plist set no secret environment variables. This program does not read a token from argv and does not log child stderr. `op` must already be authenticated for the user. The Keychain item is the unattended-Mac path: the LaunchAgent runs in the logged-in GUI session, where the login keychain is unlocked, and the item's ACL allows the read without a prompt. Docs describe creating the item once. They do not put the secret in the plist.

Rejected: an inline secret, including the watcher's `key = "REPLACE-WITH-ROUTINE-KEY"` pattern in `drop-box-watcher.example.toml` (that file is mode `0600` and still holds the secret; this config must not); a `0600` env file of secret values (same-user agents can read it); process arguments that are the secret; the imported helper that lives outside this repository. The public resolver is the `op` CLI.

**D8 — User services, no root.** Linux: a systemd user unit, `Restart=on-failure`, `RestartSec=10`, `WantedBy=default.target`, no `User=` line. macOS: a LaunchAgent, label `com.snail.agent`, `RunAtLoad` true, `KeepAlive` with `SuccessfulExit` false, so a non-zero exit restarts and a clean exit stays down. Both pass absolute paths for the Node binary, `snail.js`, and `--config`. Placeholders are `/ABS/PATH/TO/HOME` and `/ABS/PATH/TO/node`. Standard output and error on macOS go to `/ABS/PATH/TO/HOME/.local/state/snail/log`, matching the watcher's `.local/state/<tool>/log` paths in `launchd/drop-box-watcher.plist.template`. Linux uses the user journal. Docs use `systemctl --user` and `launchctl bootstrap gui/$(id -u)`. They do not use `sudo`. The service runs while the user is logged in.

The imported `snail.service` is a system unit and its README uses `sudo`. The example unit replaces that. The imported `ExecStart` passes a config path that `snail.js` ignores; the new process honors `--config`.

**D9 — Release artifact.** `scripts/build.sh` writes `dist/snail-<version>.tar.gz` and `dist/SHA256SUMS` in `sha256sum` format (hash, two spaces, filename). The tarball's top directory is `snail-<version>/` and contains the daemon sources, `package.json`, `package-lock.json`, the example TOML, the unit and plist, `README.md`, `LICENSE`, and a generated `build-stamp.json`. It does not contain `node_modules` or `.git`. The stamp holds the version, the full SHA, and UTC build time `YYYY-MM-DDTHH:MMZ`. `--version` prints `snail <version> (<12-char sha>)`. `--version --verbose` prints `snail <version> (<full sha>) built <timestamp>`.

`package.json` `"version"` stays `0.0.0`. That field is not the product version. If `VERSION` is unset and `git describe --tags --dirty` fails, the script exits non-zero and does not invent a version.

Rejected: an npm publish (a registry version beside the git tag); a container image (the install is a user service, and Keychain and user IMAP are a poor fit); a Node single-executable per OS (the dependencies are JavaScript, and a binary would freeze a Node build for no gain); a `node_modules` archive.

Checked 2026-11-01: backup-folder's `scripts/build.sh` stamps version, SHA, and UTC time, and `.github/workflows/release.yml` publishes the binaries plus `SHA256SUMS`. Snail stamps the same three facts and publishes a source tarball because it is not a Swift binary. The release job runs on `ubuntu-latest`. macOS code signing is not used.

**D10 — Git tags only.** On every push to the default branch after the release workflow exists, the workflow runs `scripts/release-version.sh`. The script's label rules match `scripts/release-version.sh` in backup-folder, checked 2026-11-01: a semver tag already on HEAD prints `noop`; the squash subject must end with `(#N)`; `release:minor` and `release:major` select the bump; both labels is an error; otherwise patch. Difference, chosen here: when no semver tag exists, the next tag is `v0.1.0`. backup-folder's script instead treats a missing tag as `v0.1.0` and then increments the patch, so the first tag would be `v0.1.1`. That first-tag quirk is rejected.

The workflow then builds with `VERSION` set to the tag, attaches the tarball and `SHA256SUMS` to a GitHub release, and pushes the tag. It does not run on pull requests. Nobody tags by hand.

**D11 — Names, state, and the imported baseline.** The imported file name is `{today}_uid-{uid padded to 6}.json` using the save date, one shared `snail-state.json`, and a relative `mailDir`. D11 replaces that with section 6 so names stay unique across a `uidValidity` change and sort by message time. The imported text slice of 2000 characters is not kept; the imported default of `textLimit` 10000 is the default that is actually applied (D12). HTML default 100000 matches the imported `htmlLimit`.

**D12 — Size limits.** `text_limit` and `html_limit` are JavaScript string lengths. `attachment_limit` is decoded bytes. Truncation sets `text_truncated` or `html_truncated`. An attachment over the limit keeps `filename`, `content_type`, and `size`, sets `omitted` true, and drops `content`. The message file is still saved.

**D13 — Node.js 26.** Checked 2026-11-01 against the Node.js release schedule. Node.js 26 entered LTS on 2026-10-28 as v26.13.0. `engines` is `>=26 <27`. Any other major logs `snail: requires Node.js 26` and exits 1. CI uses Node 26.

**D14 — Models.** Spec, plan, and fresh-context review use Grok 4.7 High. Build phases use Composer 2.5. Do not substitute. If the named model cannot be launched, stop and ask.

## 9. Open questions

None.

## 10. What was checked

Checked 2026-11-01, public sources only.

Imported daemon on the default branch: `snail.js`, `snail-config.example.json`, `snail.service`, `README.md`, `package.json`. One JSON config beside the script, one mailbox, relative mail directory, OpenClaw wake only, `op://` resolved at startup, system-wide systemd example.

[backup-folder](https://github.com/nikolaybotev/backup-folder): `Sources/ToolConfig/TomlSubset.swift`, `Sources/backup-folder/BackupConfig.swift`, `Sources/backup-folder/main.swift`, `backup-folder.example.toml`, `docs/backup-job.md`, `docs/setup.md`, `launchd/backup-folder.plist.template`, `scripts/build.sh`, `scripts/release-version.sh`, `.github/workflows/release.yml`.

drop-box-watcher, found from that repository's README (there is no separate drop-box-watcher repository): `drop-box-watcher/main.swift`, `drop-box-watcher/Config.swift`, `drop-box-watcher/ConfigReload.swift`, `drop-box-watcher/ConfigWatch.swift`, `drop-box-watcher.example.toml`, `launchd/drop-box-watcher.plist.template`.

OpenClaw gateway docs: architecture (default `127.0.0.1:18789`) and the handshake page (protocol 4). The imported client is protocol 3 / payload v2, and D5 keeps it.

Node.js release schedule: 26.x LTS as of 2026-10-28.

## 11. Models

Spec, plan, and fresh-context review: Grok 4.7 High. Build phases: Composer 2.5. Do not substitute. If one of those models cannot be launched, stop and ask.
