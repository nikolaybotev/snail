# plan.md — Config-error restart

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 2 |
| Status | Draft 3 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. The pull request that adds only `intent/config-error-restart/` is not the phase below. Do not merge that pull request. Checked 2026-11-01: tag `v0.1.0` is on main, and a default-branch merge of this pull request would publish tag `v0.1.1`. Do not start the phase below until the build gate has been run and its findings are in the spec and the plan.

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
| AC2 | `npm test` spawns the wrapper on stub exits 0 and 1, and expects 143 for SIGTERM | 0 |
| AC3 | `npm test` reads the whole `ExecStart=` value from step 2. A line that still begins with `scripts/run-service.sh` fails | 0 |
| AC4 | `npm test` reads the plist for the wrapper, `SuccessfulExit` false, and `ThrottleInterval` 10 | 0 |
| AC5 | `npm test` spawns the wrapper and reads the stub's stdout and stderr markers | 0 |

`npm test` is `node --test`. Healthy: exit 0.

## Phase 0 — Config-error restart

Files: `scripts/run-service.sh`, `snail.service`, `test/install-docs.test.js`, `AGENTS.md`, `REVIEW.md`

1. In `scripts/run-service.sh`, keep the shebang, the comment, `set -euo pipefail`, and the required node and snail arguments. Replace the bare child command and the following status read with `status=0`, then `"$NODE" "$SNAIL" "$@" || status=$?`, then exit 0 when `status` is 2, otherwise `exit "$status"`. Do not `exec` the child. Do not redirect stdout or stderr. Do not print. Do not add a flag.
2. In `snail.service`, set `ExecStart` to `/ABS/PATH/TO/node /ABS/PATH/TO/HOME/snail/snail.js --config /ABS/PATH/TO/HOME/.config/snail/config.toml`. Leave `Type=simple`, `Restart=on-failure`, `RestartPreventExitStatus=2`, and `RestartSec=10` as they are. Leave the plist as it is.
3. Extend `test/install-docs.test.js` so AC1–AC5 spawn the real wrapper or read the unit and plist, as the spec states. The SIGTERM stub must yield wrapper status 143. The AC3 assertion is the whole `ExecStart=` value from step 2. The unit on main is that same argument list with `scripts/run-service.sh` in front, and an unanchored match of the four-argument tail succeeds on it. A line that still begins with `scripts/run-service.sh` fails the test. Keep the existing source match and the existing secret, `sudo`, and placeholder assertions. A source match alone must not be the only proof of the mapping.
4. In `AGENTS.md`, point the service restart contract at `intent/config-error-restart/`. That contract replaces portable-mail D8 for the Linux main process and for clean signals. Under Prohibitions, add the behavior to avoid: the launchd wrapper exits 2 when snail exits 2; a SIGTERM child leaves the wrapper with a status other than 143; `ExecStart` is any value other than the line in step 2. In `REVIEW.md`, add those three failures to the Bugs line. Compliance uses this spec for the service restart contract, the same replacement D2 gives `AGENTS.md`. Portable mail stays the authority for everything else.
5. Re-read `README.md`. Edit it only if a sentence would be false after steps 1 and 2. The Linux section cites `RestartPreventExitStatus=2` and says crashes and other failures restart. A clean signal is not one of those failures. The LaunchAgent section cites the wrapper mapping. Those sentences stay true.
6. Do not edit `intent/portable-mail/`. Do not edit `.cursor/install.sh`. Do not edit skills, and do not change files outside this repo. Do not deploy.

DoD: `npm test` exits 0.
