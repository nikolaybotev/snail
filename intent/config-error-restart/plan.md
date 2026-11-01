# plan.md — Config-error restart

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. The pull request that adds only `intent/config-error-restart/` is not the phase below. Do not start that phase until the build gate has been run and its findings are in the spec and the plan.

## Stops

None. The errexit capture is D1. The systemd split is D2. The executed check is D3.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against the spec. It does not edit.
4. Apply those findings the same way.
5. Build only after both reviews have been applied. The one phase below is one pull request.

Squash-merge that pull request only when every required check has succeeded. Required status checks: `test`, `javascript`. Do not merge while any required check is missing, pending, failed, or cancelled. Do not use an admin override.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` spawns the wrapper on stub exit 2 and on `node` `process.exit(2)` | 0 |
| AC2 | `npm test` spawns the wrapper on stub exits 0 and 1 and on SIGTERM | 0 |
| AC3 | `npm test` reads `snail.service` for the restart directives and an `ExecStart` without the wrapper | 0 |
| AC4 | `npm test` reads the plist for the wrapper, `SuccessfulExit` false, and `ThrottleInterval` 10 | 0 |
| AC5 | `npm test` spawns the wrapper and reads the stub's stdout and stderr markers | 0 |

`npm test` is `node --test`. Healthy: exit 0.

## Phase 0 — Config-error restart

Files: `scripts/run-service.sh`, `snail.service`, `test/install-docs.test.js`, `AGENTS.md`, `REVIEW.md`

1. In `scripts/run-service.sh`, keep the shebang, the comment, `set -euo pipefail`, and the required node and snail arguments. Replace the bare child command and the following status read with `status=0`, then `"$NODE" "$SNAIL" "$@" || status=$?`, then exit 0 when `status` is 2, otherwise `exit "$status"`. Do not `exec` the child. Do not redirect stdout or stderr. Do not print. Do not add a flag.
2. In `snail.service`, remove `scripts/run-service.sh` from `ExecStart` so the line runs the Node binary on `snail.js` with the same `--config` argument and the same placeholder tokens as the rest of that line. Leave `Restart=on-failure`, `RestartPreventExitStatus=2`, and `RestartSec=10` as they are. Leave the plist as it is.
3. Extend `test/install-docs.test.js` so AC1–AC5 spawn the real wrapper or read the unit and plist, as the spec states. Keep the existing source match and the existing secret, `sudo`, and placeholder assertions. A source match alone must not be the only proof of the mapping.
4. In `AGENTS.md`, point the config-error restart work at `intent/config-error-restart/`, and add two prohibitions: the launchd wrapper must not exit 2 when snail exits 2, and the systemd unit must not exit 0 on a config error or name `scripts/run-service.sh` on `ExecStart`. In `REVIEW.md`, add those two failures to the Bugs line, and mention this intent beside portable mail in Compliance.
5. Re-read `README.md`. Edit it only if a sentence would be false after steps 1 and 2. The Linux section cites `RestartPreventExitStatus=2`. The LaunchAgent section cites the wrapper mapping. Those sentences stay true.
6. Do not edit `intent/portable-mail/`. Do not edit `.cursor/install.sh`. Do not edit skills, and do not change files outside this repo. Do not deploy.

DoD: `npm test` exits 0.
