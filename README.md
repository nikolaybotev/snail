# 🐌 Snail — IMAP IDLE Daemon

Snail monitors an IMAP mailbox via IDLE and wakes an OpenClaw agent when new email arrives. New messages are saved to disk as JSON files — the email body never touches the OpenClaw wake payload (prompt injection protection).

## Architecture

```
IMAP Server → IDLE push → Snail → saves mail/YYYY-MM-DD_uid-NNN.json
                                 → wakes the OpenClaw gateway with metadata only (From, Subject, file path)
                                 → OpenClaw wakes and reads the file
```

## Setup

### 1. Install dependencies
```bash
cd /path/to/snail
npm install
```

### 2. Create config
```bash
cp snail-config.example.json snail-config.json
nano snail-config.json
```

Fill in:
- `imap.host` — your IMAP server
- `imap.user` / `imap.pass` — credentials (app password recommended). `op://` references are resolved at startup
- `gatewayUrl` — OpenClaw gateway (default `http://127.0.0.1:18789`)
- `gatewayToken` — OpenClaw gateway token. `op://` references are resolved at startup

### 3. Test run
```bash
node snail.js
```

### 4. Install as systemd service
```bash
sudo cp snail.service /etc/systemd/system/snail.service
sudo systemctl daemon-reload
sudo systemctl enable snail
sudo systemctl start snail
sudo journalctl -u snail -f
```

## Files

| File | Description |
|------|-------------|
| `snail.js` | Main daemon |
| `snail-config.json` | Your config (gitignored) |
| `snail-config.example.json` | Template |
| `snail-state.json` | Last-seen UID (auto-managed) |
| `snail.service` | systemd unit file |
| `../mail/` | Saved email JSON files |

## Security

- Email body is **never** included in the OpenClaw wake payload — only a file path
- This prevents prompt injection attacks via malicious email content
- Keep `snail-config.json` out of version control. `op://` references in it are resolved at startup

## Reconnect behavior

- Exponential backoff: 5s → 10s → 20s → ... → 60s max
- Catches up on missed emails after reconnect
- IDLE re-enters automatically after 29 min (IMAP keepalive)
