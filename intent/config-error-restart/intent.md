# intent.md — Config-error restart

| | |
|---|---|
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md) |

## Problem

`scripts/run-service.sh` uses `set -euo pipefail`. When snail exits 2 on a config error, the script quits before its exit-2 to exit-0 mapping runs. launchd then treats a config error as a crash and restarts about every 10 seconds.

## Proposed outcome

The mapping runs. A config error does not restart the service. On macOS that is the wrapper exiting 0, so the LaunchAgent stays down. On Linux, systemd's `RestartPreventExitStatus=2` remains its own path and still sees status 2.

## Affected users and systems

- **Users:** a person who runs the LaunchAgent or the systemd user service.
- **Systems:** `scripts/run-service.sh`, the LaunchAgent plist, and the systemd user unit.

## Constraints and principles

- The exit-2 to exit-0 mapping must run.
- A config error must not restart the service.
- systemd's `RestartPreventExitStatus=2` is a separate path. Do not break it.
- The plan has one phase, and that phase is the fix. It comes after a fresh-context review.

## Open questions (carried into spec.md)

None. [spec.md](spec.md) decides the errexit capture (D1), the systemd split (D2), and the executed check (D3).

## Original prompt (verbatim)

> Draft only. Do not implement the code fix. Do not merge. Do not deploy. Do not edit local-skills.
>
> On nikolaybotev/snail main, open one pull request whose only files are intent/config-error-restart/intent.md, spec.md, and plan.md. Follow the installed ai-native-sdlc templates. No personal names, emails, hostnames, or machine paths.
>
> The bug: scripts/run-service.sh uses `set -euo pipefail`. When snail exits 2 on a config error, the script quits before its exit-2 to exit-0 mapping runs. launchd then treats a config error as a crash and restarts about every 10 seconds. The mapping must run. A config error should not restart the service. systemd's RestartPreventExitStatus=2 is a separate path; do not break it. One phase in the plan is the fix, after a fresh-context review. Do not start that phase.
>
> Reply with the pull request URL.
