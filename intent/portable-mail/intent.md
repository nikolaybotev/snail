# intent.md — Portable mail

| | |
|---|---|
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |

## Problem

Snail holds one IMAP IDLE connection, writes each new message to a JSON file, and wakes an agent with metadata only. That wake is the prompt-injection guard: the body stays on disk. The daemon is a single Linux systemd service, a single mailbox, and a single wake path (a signed WebSocket to an OpenClaw gateway on localhost). Secrets are `op://` references resolved at startup. One process per mailbox does not scale, and there is no webhook, no macOS service, and no second way to resolve a secret on an unattended Mac.

## Proposed outcome

One user-level service, on Linux and on macOS, reads one config and watches many accounts. Each account has its own mailbox, its own mail folder, its own last-seen state, and its own notifier: the current OpenClaw gateway path, or an HTTPS webhook that receives metadata only. Adding, changing, or removing an account takes effect without restarting the service and without disturbing the other accounts. A stranger can install it from a tagged release and follow the docs. Classifying mail and sending mail stay out.

## Affected users and systems

- **Users:** a person who runs an agent and wants new mail delivered to that agent without pasting the body into the prompt.
- **Systems:** IMAP servers, an OpenClaw gateway, HTTPS webhooks, systemd (user), launchd (LaunchAgent), the 1Password CLI, and the macOS Keychain.

## Constraints and principles

- The body never goes to a notifier. Metadata only, on every wake path.
- A notifier failure must not lose the saved message or cause a second save. The file is saved first. The notify outcome is logged. Retries use backoff.
- One process, many accounts. One account's failure must not stop or delay the others. Each account has its own state and its own log tag.
- The config is one TOML file in the same format and the same location style as [backup-folder](https://github.com/nikolaybotev/backup-folder): a repeated table per account, mode `0600`, path `~/.config/snail/config.toml`, passed with `--config` as an absolute path.
- Live reload is required. Adding, changing, or removing an account takes effect without a restart and without disturbing the other accounts, matching drop-box-watcher in that same repository.
- Secrets never appear on the command line or in logs. The spec decides how the config file holds them.
- The OpenClaw gateway integration keeps working.
- No root. Restart on failure. Clean logs.
- File names stay sortable and unique. The JSON file schema is documented, because agents read the files.
- Out of scope: classifying or triaging mail, and sending mail.

## Open questions (carried into spec.md)

1. When the state file is missing or unusable, catch-up either replays from UID 0 or starts at the mailbox high-water mark. [spec.md](spec.md) leaves both options open (Q1). It decides the TOML config (D1, D2), live reload (D4), secrets (D7), and the release artifact (D9).

## Original prompt (verbatim)

> Snail as a portable mail-to-agent service.
> Snail is a Node.js daemon that holds an IMAP IDLE connection open (push, not polling). It saves each new message as a JSON file (headers, text, HTML, base64 attachments), tracks lastUID so it catches up after downtime, and wakes an agent with metadata only (From, Subject, file path), never the body. That's a deliberate prompt-injection guard and must stay. Today the only wake-up path is a signed WebSocket to an OpenClaw gateway on localhost, it runs only as a Linux systemd service, and secrets are 1Password op:// references resolved at startup.
> Goals:
> 1. Notifier abstraction: keep the current OpenClaw gateway integration working as is, and add a generic webhook notifier (HTTPS POST of a small JSON body: from, subject, date, message id, saved file path, mailbox name; bearer or header auth from a secret). Retry with backoff, and never lose or re-send mail because a notifier failed: the file is saved first and the notify outcome is logged.
> 2. Runs as a service on both Linux (systemd) and macOS (launchd LaunchAgent), with install docs and example unit and plist files. Clean logs, restart on failure, no root needed.
> 3. Secrets: never in a file other users or agents can read, and never on the command line or in logs. Keep 1Password op:// resolution as one option, and add at least one more that suits an unattended Mac (for example macOS Keychain, or environment from a 0600 file). Choose the design in the spec.
> 4. Snail is ONE service handling many accounts, like a mail app holding several accounts under one user login. Separate service instances per mailbox don't scale. Model the configuration on https://github.com/nikolaybotev/backup-folder: one service, one config file, and a repeated table per item (there it's [[folder]]; here it's an account entry). Port its proven config approach, including the config library and loading, validation, defaults and error-reporting style, from Swift to Node.js, so the two tools feel the same to configure. Also study backup-folder's companion drop-box-watcher, which hot-reloads its config. Each account entry names at least the IMAP account (host, user, mailbox, and a secret reference, never an inline secret), its own mail folder (absolute path), and its own notifier: a webhook with its own URL and secret reference, or the OpenClaw gateway. Accounts are independent: one failing account (bad login, network) must not stop or delay the others, and each keeps its own state (lastUID) and logs tagged with the account name. File naming stays sortable and unique. Document the file schema, because agents read these files.
> 5. Robustness and tests: reconnect and backoff, catch-up after downtime, no duplicate saves, size limits on bodies and attachments, and unit tests with a fake IMAP server or mocks running in CI.
> Out of scope for now: classifying or triaging mail, and sending mail.
> Success: a tagged release that installs on macOS as a LaunchAgent and on Linux as a systemd service, delivers new mail to a webhook within seconds with metadata only, keeps the OpenClaw path working, handles many accounts in one service, and has docs a stranger could follow.
