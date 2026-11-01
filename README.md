# Snail — IMAP IDLE daemon

Snail is one Node.js process that watches many IMAP accounts over IDLE. Each account saves new messages as JSON files and wakes its own notifier with metadata only (From, Subject, file path). The email body never goes to a notifier.

Design notes and acceptance criteria live in `intent/portable-mail/`.

## Architecture

```
IMAP (per account) → IDLE → Snail → mail_dir/*.json (full message on disk)
                              → webhook or OpenClaw (metadata only)
```

One TOML config file lists every account. Adding, changing, or removing an account is a **live reload**: the process keeps running, and accounts whose entries did not change stay connected.

## Requirements

- Node.js 26 (`engines` in `package.json`)
- Network access to your IMAP servers
- For Linux `op://` secrets: 1Password CLI (`op`) and a service-account token file (see [Secrets](#secrets))

## Install from a release

1. Download `snail-<version>.tar.gz` and `SHA256SUMS` from the GitHub release for this repo.
2. Verify the checksum, then extract the archive under your home directory (for example `~/snail/`).
3. In that directory run `npm ci` once to install dependencies.

Replace every `/ABS/PATH/TO/HOME` placeholder in the service files with your absolute home path. launchd and systemd do not expand `~`. Replace `/ABS/PATH/TO/node` with the absolute path to your Node 26 binary (`command -v node` after installing Node).

## Config

Copy the example and edit it:

```bash
mkdir -p ~/.config/snail
cp snail.example.toml ~/.config/snail/config.toml
chmod 600 ~/.config/snail/config.toml
```

The file must be mode `0600` and owned by the user who runs the service. Snail refuses group- or world-readable configs and configs owned by another user.

Start Snail with an absolute config path only:

```bash
node snail.js --config /absolute/path/to/config.toml
```

Each `[[account]]` row needs `name`, `host`, `user`, `password`, `mail_dir` (absolute), and `notifier` (`webhook` or `openclaw`). See `snail.example.toml` for webhook and OpenClaw examples, limits, and defaults.

### Live reload

After Snail is running, edit `config.toml` and save. Valid changes apply without restarting the service:

- **Added account** — only that account connects.
- **Changed account** — only that account restarts (including re-resolving secrets when the secret *string* in the file changed).
- **Removed account** — only that account logs out; its mail directory and `.snail-state.json` stay on disk.
- **Comment-only or identical save** — no reconnects and no log line.

A bad rewrite (parse error, permissions, or removing the last account) is rejected: the previous config stays live, Snail logs `config reload rejected:` and keeps running. It does not exit.

### First run, downtime, and mailbox resync

Snail tracks a **notify boundary** in each account’s `.snail-state.json` under `mail_dir`:

- **First run** (missing or unreadable state): before any message body is downloaded, Snail records `UIDNEXT` as the boundary. Every message already in the mailbox is saved to disk but **not** woken. Mail that arrives after that boundary is saved and woken, even while older mail is still being downloaded.
- **After downtime** (same `uidValidity`): Snail catches up mail that arrived while it was down; those messages are saved and woken. Unfinished backlog from an earlier first run is still saved without waking.
- **`UIDVALIDITY` change** (server renumbered the mailbox): treated like a new first run — everything is saved again under the new validity, **none** of those saves wake the agent, and only mail after the new boundary is woken. Old JSON files remain on disk.

## Saved message files

File name pattern (UTC envelope time, then validity and UID):

`{YYYYMMDD}T{HHMMSS}Z_{uidValidity}_{uid}.json` (UID zero-padded to 10 digits)

Example: `20261101T031500Z_42_0000000123.json`

Each file is mode `0600`. Wake text uses only metadata; the JSON file holds the full content for agents to read:

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

`html_body`, `html_truncated`, and `attachments` are omitted when not applicable. Large bodies and attachments are truncated or omitted per `text_limit`, `html_limit`, and `attachment_limit` in the config.

State file: `<mail_dir>/.snail-state.json` (not a message file; do not delete it casually).

## Secrets

Secret fields are `password`, `webhook_secret`, and `openclaw_token`. Each may be an inline string in the mode-`0600` config (fallback) or a reference:

| Form | Platform | Meaning |
|------|----------|---------|
| Inline in `config.toml` | Linux and macOS | Fallback; use read-only mailbox passwords where possible |
| `keychain://<service>/<account>` | macOS | Keychain generic password via `/usr/bin/security` |
| `op://<vault>/<item>/<field>` | Linux | 1Password via `op read` |

References resolve once when an account starts (or restarts after reload). Reconnects and notify retries use the in-memory cache only — Snail does not call `security` or `op` on every IMAP or webhook attempt.

### macOS Keychain

Add an item so the secret is typed at a prompt (`-w` last, with **no** value on the command line):

```bash
security add-generic-password -s snail -a personal-imap -w
```

Then reference `keychain://snail/personal-imap` in the config. Do not put the password on the command line after `-w`.

`op://` is for Linux; the macOS docs path is Keychain, not 1Password references.

### Linux 1Password (`op://`)

Prefer vault and item **ids** in references (for example `op://vault-id/item-id/field`). Reading by name costs about three API requests; reading by id costs about one. A 1Password service account allows about 1,000 requests per day — caching resolved secrets avoids burning that quota on reconnect loops.

Install the 1Password CLI. Put the service-account token in a mode-`0600` file and point Snail at it with either:

- environment variable `SNAIL_OP_TOKEN_FILE` set to that file’s absolute path, or
- systemd `LoadCredential=op-token` so the token appears as `$CREDENTIALS_DIRECTORY/op-token`.

Snail passes the token only to the `op` child as `OP_SERVICE_ACCOUNT_TOKEN` (with `OP_BIOMETRIC_UNLOCK_ENABLED=false`). It is not copied into Snail’s environment, argv, unit files, plist, or logs. If no token file is configured, `op://` resolution fails for that account and backs off like a network error; other accounts continue.

### Threat model note

Against same-user malware, Keychain, `op://`, and a mode-`0600` config file are roughly similar. Keychain and 1Password help with encryption at rest and keeping secrets out of backups and plain files. Snail never logs secrets, never puts them on argv, and never writes them into files it creates.

## User service (Linux)

The example unit is a **user** systemd service (no `User=` line, no root):

1. Edit `snail.service`: replace `/ABS/PATH/TO/HOME` and `/ABS/PATH/TO/node` with your paths (same paths as in the LaunchAgent section).
2. Install the unit:

```bash
mkdir -p ~/.config/systemd/user
cp snail.service ~/.config/systemd/user/snail.service
systemctl --user daemon-reload
systemctl --user enable --now snail.service
```

Logs: `journalctl --user -u snail.service -f`

`Restart=on-failure` with `RestartPreventExitStatus=2`: config errors (exit code 2) do **not** restart the service. Crashes and other failures restart after 10 seconds.

The user service runs while you are logged in (typical user session). Enable lingering only if you explicitly want the user unit to run without an active login.

Optional: deliver the 1Password token with systemd credentials:

```ini
LoadCredential=op-token:/path/to/op-token-file
```

in an override file; Snail reads `$CREDENTIALS_DIRECTORY/op-token`.

## LaunchAgent (macOS)

GUI session only (`LimitLoadToSessionType` `Aqua`), label `com.snail.agent`:

1. Edit `launchd/com.snail.agent.plist`: replace `/ABS/PATH/TO/HOME` and `/ABS/PATH/TO/node`.
2. Create the log directory and install the agent:

```bash
mkdir -p ~/.local/state/snail
cp launchd/com.snail.agent.plist ~/Library/LaunchAgents/com.snail.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.snail.agent.plist
```

Logs append to `~/.local/state/snail/log`.

`scripts/run-service.sh` maps Snail exit 2 to exit 0 so launchd does not treat a config error as a crash. Other exits still restart (`KeepAlive` with `SuccessfulExit` false). The agent runs while you are logged into the GUI session.

Unload:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.snail.agent.plist
```

## Development

```bash
npm ci
npm test
bash scripts/build.sh   # set VERSION=… when not building from a tagged commit
```

## Security

- Notifiers receive metadata only; bodies and attachment bytes stay in JSON files on disk.
- Keep the real `config.toml` out of version control (mode `0600`).
- Rejected reload and parse errors redact secret-shaped substrings in log lines.

## Reconnect behavior

Per account: exponential backoff 5s → 10s → 20s → 40s → 60s (cap), reset after a successful connect. IDLE re-enters every 29 minutes without fetching. One failing account does not block others.
