# intent.md — IMAP integration harness

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md), [IMAP BigInt](../imap-bigint/intent.md) |

## Problem

Today's tests drive the supervisor through an in-memory fake client. That is how a BigInt from imapflow reached production. The tests never open a socket, so they never run the client that production runs.

## Proposed outcome

A local, scripted IMAP server is started by the tests, and the real imapflow client runs over a real socket. Scenario tests check what lands in the mail directory, the state file, and the notifier. The suite runs in CI with `node --test` and does not touch a real account or the network.

## Affected users and systems

- **Users:** a person whose mail is watched by the service, who needs a regression of this kind to fail in CI.
- **Systems:** the per-account IMAP loop, imapflow, the mail directory and `.snail-state.json`, the webhook notifier, the OpenClaw wake path, and `node --test` in CI.

## Constraints and principles

- The body never goes to a notifier. Metadata only, on every wake path.
- A notifier failure must not lose the saved message or cause a second save.
- One account's failure, including its reconnect wait, must not stop or delay another account.
- The harness does not wake a backlog UID or a UID from a UIDVALIDITY resync.
- The harness does not wake a message whose file is not durable.
- Secrets stay off the command line, out of logs, and out of files this program writes.
- No personal names, emails, hostnames, or real account names.
- No deploy. This intent does not edit `intent/portable-mail/`, `intent/config-error-restart/`, or `intent/imap-bigint/`.
- The build waits until a fresh-context review says to build.

## Open questions (carried into spec.md)

None. [spec.md](spec.md) chooses the server (D1), the plaintext socket (D2), the IDLE signal (D3), the integers (D4), the notifier checks (D5), and the release tag (D6).

## Original prompt (verbatim)

> Draft only. Do not implement the harness. Do not merge. Do not deploy. Do not edit local-skills.
>
> Read /cursor/stores/bc-f079d122-ca2f-512a-8a00-2445a0e2928b/internal/imap-harness-brief.md and follow it. On nikolaybotev/snail main (which now includes v0.1.1), open one pull request whose only files are intent/imap-harness/intent.md, spec.md, and plan.md. Follow the installed ai-native-sdlc templates. Choose a scripted stub or an embeddable server in the spec and record why. No personal names, emails, hostnames, or real account names.
>
> Do not edit intent/portable-mail/, intent/config-error-restart/, or intent/imap-bigint/. Do not start the build phase. This pull request must not be merged if merging it would publish another release tag before the harness itself is ready; say so in the plan if every push to main tags. Reply with the pull request URL.

## Source transcript (verbatim)

The prompt names `internal/imap-harness-brief.md`. Its text:

> # IMAP integration harness
>
> Start this only after v0.1.1 is published. New intent. Do not edit intent/portable-mail/ or intent/config-error-restart/ or intent/imap-bigint/. Do not deploy. No personal names, emails, hostnames, or real account names.
>
> Today's tests drive the supervisor through an in-memory fake client. That is how a BigInt from imapflow reached production. The goal is a local, scripted IMAP server started by the tests, so the real imapflow client runs over a real socket. Scenario tests check what lands in mail_dir, the state file, and the notifier. Use TLS where practical, or document the plaintext test path. Choose a scripted stub or an embeddable server in the spec and record why.
>
> Coverage:
>
> - First start with existing mail: messages are saved and no wake-up is sent.
> - New mail during IDLE: the message is saved and exactly one webhook or OpenClaw wake-up goes out with the documented payload.
> - UIDVALIDITY change, and restart and resume from saved state, with no duplicates and no gaps.
> - Large UID, UIDVALIDITY, and MODSEQ values, so BigInt paths run end to end.
> - Dropped connections, auth failures, and server UNAVAILABLE: backoff instead of a tight reconnect loop.
> - Webhook timeout, non-2xx replies, and bearer and HMAC headers, using a local HTTP receiver. OpenClaw wake-up uses a local WebSocket stub.
> - Multiple accounts side by side.
>
> The harness runs in CI with `node --test` and does not touch real accounts or the network. Take it through intent, spec, and plan first. Do not start the build until a fresh-context review says to build.
