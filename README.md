# 🐌 Snail — IMAP IDLE Daemon

Snail monitors an IMAP mailbox via IDLE and wakes an OpenClaw agent when new email arrives. New messages are saved to disk as JSON files — the email body never touches the OpenClaw wake payload (prompt injection protection).

Portable-mail requirements (multi-account TOML config, live reload, user services, and release tarball) are specified in `intent/portable-mail/` on branches that include that tree. This README describes the single-account daemon currently in the tree.

## Architecture

```
IMAP Server → IDLE push → Snail → saves mail/YYYY-MM-DD_uid-NNN.json
                                 → wakes the OpenClaw gateway with metadata only (From, Subject, file path)
                                 → OpenClaw wakes and reads the file
```

## Setup

### 1. Install dependencies

```bash
npm ci
```

Requires Node.js 26 (`engines` in `package.json`).

### 2. Create config

```bash
cp snail-config.example.json snail-config.json
```

Edit `snail-config.json` with IMAP credentials and OpenClaw gateway settings (see the example file).

### 3. Test run

```bash
node snail.js
```

### 4. Install as systemd service (imported example)

The checked-in `snail.service` is a system-wide unit example. Portable mail replaces this with a user-level unit; see `intent/portable-mail/spec.md` when that work lands.

```bash
sudo cp snail.service /etc/systemd/system/snail.service
sudo systemctl daemon-reload
sudo systemctl enable snail
sudo systemctl start snail
```

## Files

| File | Description |
|------|-------------|
| `snail.js` | Main daemon |
| `snail-config.json` | Your config (gitignored) |
| `snail-config.example.json` | Template |
| `snail-state.json` | Last-seen UID (auto-managed) |
| `snail.service` | systemd unit file (legacy system-wide example) |
| `../mail/` | Saved email JSON files |

## Security

- Email body is **never** included in the OpenClaw wake payload — only a file path
- Keep `snail-config.json` out of version control

## Reconnect behavior

- Exponential backoff: 5s → 10s → 20s → ... → 60s max
- Catches up on missed emails after reconnect
- IDLE re-enters automatically after 29 min (IMAP keepalive)
