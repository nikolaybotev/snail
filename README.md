# 🐌 Snail — IMAP IDLE Daemon

Snail monitors an IMAP mailbox via IDLE and wakes an agent when new email arrives. New messages are saved to disk as JSON files — the email body never touches the inject payload (prompt injection protection).

## Architecture

```
IMAP Server → IDLE push → Snail → saves mail/YYYY-MM-DD_uid-NNN.json
                                 → wakes the agent with metadata only (From, Subject, file path)
                                 → Agent wakes and reads the file
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
- `imap.user` / `imap.pass` — credentials (app password recommended)
- `gatewayToken` — from 1Password: `op read op://Vault/Item/field`

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

- Email body is **never** included in the wake payload — only a file path
- This prevents prompt injection attacks via malicious email content
- Credentials live in `snail-config.json` — keep it out of version control
- Better: load credentials from 1Password at startup (future improvement)

## Reconnect behavior

- Exponential backoff: 5s → 10s → 20s → ... → 60s max
- Catches up on missed emails after reconnect
- IDLE re-enters automatically after 29 min (IMAP keepalive)
