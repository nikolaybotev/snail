# spec.md — Config-error restart

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

The LaunchAgent wrapper is supposed to turn snail's status 2 into status 0 so launchd does not treat a config error as a crash. The wrapper enables `set -euo pipefail` and runs snail as a simple command, so bash exits on status 2 before the mapping. launchd restarts the agent on the plist's 10-second throttle. The mapping has to run. The systemd unit keeps `RestartPreventExitStatus=2` as its own way to ignore status 2, and the unit's main process must still exit 2. Exit 1 and an unclean signal still restart that unit. `SIGHUP`, `SIGINT`, `SIGTERM`, and `SIGPIPE` leave it down.

## 2. Goals and non-goals

**Goals**

- G1. When the LaunchAgent runs `scripts/run-service.sh` and snail exits 2, the wrapper exits 0.
- G2. A config error does not restart the LaunchAgent or the systemd user service.
- G3. systemd still prevents that restart with `RestartPreventExitStatus=2`, because the service process exits 2.
- G4. Exit 1 restarts the LaunchAgent and the systemd user service. A signal death restarts the LaunchAgent, because the wrapper exits with the child's status and that status is unsuccessful. On systemd, an unclean signal restarts the service. `SIGHUP`, `SIGINT`, `SIGTERM`, and `SIGPIPE` leave the unit down. `Restart=on-failure` stays as it is.

**Non-goals**

- Changing which failures snail reports as status 2 or status 1.
- Changing `KeepAlive`, `ThrottleInterval`, `LimitLoadToSessionType`, `RunAtLoad`, or the plist's program arguments.
- Removing `RestartPreventExitStatus=2`, `Restart=on-failure`, or `RestartSec=10`.
- A live launchd or systemd check in CI, an install, or a deploy.
- Editing `intent/portable-mail/`, skills, or files outside this repo.

**Release phasing.** Every untagged requirement is in the single plan phase. That phase is a later pull request. This pull request only adds this folder. It must not be merged, and it must not be tag `v0.1.1`. Checked 2026-11-01: tag `v0.1.0` is on main, and `scripts/release-version.sh` tags the next patch on a default-branch merge whose subject ends with `(#N)` when neither `release:minor` nor `release:major` is set.

## 3. Principles

- P1. Status 2 means "do not restart": the wrapper turns it into 0 for launchd, and systemd still receives 2 from snail.
- P2. Every child status other than 2 is passed through unchanged. Status 0 stays 0, status 1 stays 1, and a SIGTERM death stays 143.
- P3. The wrapper adds no output of its own and does not hide the child's stdout or stderr.
- P4. The wrapper does not log its arguments and does not write a secret, a token, or a config body.

## 4. Users and scenarios

- **Config error under launchd.** The plist starts `scripts/run-service.sh`. Snail exits 2. The wrapper exits 0. `KeepAlive` with `SuccessfulExit` false does not start another instance.
- **Crash under launchd.** Snail exits 1, or the child dies by a signal. The wrapper exits with that child's status. A SIGTERM death is 143. launchd restarts the agent. `ThrottleInterval` stays 10.
- **Config error under systemd.** The unit's main process is snail. Snail exits 2. `RestartPreventExitStatus=2` prevents `Restart=on-failure` from starting it again.
- **Crash under systemd.** Snail exits 1, or dies by an unclean signal. `Restart=on-failure` restarts the unit after `RestartSec=10`. `SIGHUP`, `SIGINT`, `SIGTERM`, and `SIGPIPE` leave the unit down. `Restart=on-failure` and `Type=simple` stay.

## 5. Functional requirements

- FR1. `scripts/run-service.sh` keeps `set -euo pipefail` and `#!/usr/bin/env bash`. The node and snail arguments stay required. The child is invoked so a non-zero status does not abort the script before the mapping. Status 2 becomes wrapper status 0. The script does not `exec` the child.
- FR2. Wrapper status 0 stays 0. Wrapper status 1 stays 1. A child that dies by SIGTERM yields wrapper status 143. No status other than 2 is mapped to 0.
- FR3. The child's stdout and stderr are the wrapper's stdout and stderr, with nothing added and nothing removed.
- FR4. `snail.service` `ExecStart` is `/ABS/PATH/TO/node /ABS/PATH/TO/HOME/snail/snail.js --config /ABS/PATH/TO/HOME/.config/snail/config.toml`. `Restart=on-failure`, `RestartPreventExitStatus=2`, `RestartSec=10`, and `Type=simple` stay.
- FR5. `launchd/com.snail.agent.plist` still runs `scripts/run-service.sh` with the arguments it has now, and it still sets `KeepAlive` / `SuccessfulExit` to false and `ThrottleInterval` to 10.
- FR6. Status 2 stays the non-restart status for both usage and config load. The wrapper maps on the status alone. It does not inspect stderr for a config-error string.
- FR7. Acceptance runs the wrapper. A source-text match that the file contains `-eq 2` and `exit 0` does not satisfy FR1.

## 6. Acceptance criteria

| ID | Check |
|---|---|
| AC1 | `npm test` spawns `scripts/run-service.sh` with a stub child that exits 2, and the wrapper exits 0. The same test spawns it with `node` and `process.exit(2)`, and the wrapper exits 0. |
| AC2 | The same test: a stub exit of 0 yields wrapper 0; a stub exit of 1 yields wrapper 1; a stub that kills itself with SIGTERM yields wrapper 143. |
| AC3 | The same test reads `snail.service` and finds `Restart=on-failure`, `RestartPreventExitStatus=2`, `RestartSec=10`, and `Type=simple`. `ExecStart` is `/ABS/PATH/TO/node /ABS/PATH/TO/HOME/snail/snail.js --config /ABS/PATH/TO/HOME/.config/snail/config.toml`. |
| AC4 | The same test reads the plist and finds `run-service.sh`, `SuccessfulExit` false, and `ThrottleInterval` 10. |
| AC5 | A stub writes a fixed marker to stdout and another to stderr. Both markers appear on the wrapper's matching stream. |

`npm test` is `node --test`. Healthy: exit 0. The checks above live in `test/install-docs.test.js` and run in that command.

## 7. Design decisions

**D1 — Capture the child status under errexit.** Keep `set -euo pipefail`. Set `status=0`, run the child as `"$NODE" "$SNAIL" "$@" || status=$?`, then exit 0 when `status` is 2 and exit with `status` otherwise. The child's standard streams stay inherited.

Checked 2026-11-01 against `scripts/run-service.sh` on main. The script sets `set -euo pipefail`, runs the child as a simple command, then assigns `status=$?` and maps 2 to 0. Reproduced that shape on bash 5.2.21: child status 0 yields wrapper 0, and child statuses 1 and 2 yield wrappers 1 and 2. The mapping line does not run. The `status=0` / `|| status=$?` shape on the same bash yields wrapper 0 for child 2, wrapper 1 for child 1, wrapper 0 for child 0, and wrapper 143 when the child kills itself with SIGTERM. The same shape with `node` and `process.exit` yields wrapper 0, 1, and 0 for node statuses 2, 1, and 0. The `||` list is POSIX and is the errexit exception bash documents for a command that is not the last in an AND/OR list. It does not need a bash-5 feature.

Rejected: removing `set -e` or the whole `set -euo pipefail` line. The next line would run, and nounset and pipefail would go with it. Rejected: `exec` of the child. The shell would be gone before the mapping. Rejected: mapping only when stderr contains a config phrase. Usage and config load already share status 2, and a phrase match can miss a status-2 failure.

**D2 — The unit runs snail; the wrapper stays on the LaunchAgent.** `snail.service` `ExecStart` is `/ABS/PATH/TO/node /ABS/PATH/TO/HOME/snail/snail.js --config /ABS/PATH/TO/HOME/.config/snail/config.toml`. systemd observes snail's status. `RestartPreventExitStatus=2` still matches a config error. `Restart=on-failure` and `Type=simple` stay. Exit 1 and an unclean signal restart after `RestartSec=10`. `SIGHUP`, `SIGINT`, `SIGTERM`, and `SIGPIPE` are clean exits for `Type=simple` and leave the unit down. The plist is unchanged and keeps calling the wrapper, so the mapping in D1 is what launchd sees, including status 143 for SIGTERM.

For the service restart contract, this spec replaces the portable-mail D8 sentences that say any signal restarts on Linux and that the shipped unit runs `scripts/run-service.sh`. The Linux main process is the Node binary on `snail.js`, and those four clean signals do not restart. The LaunchAgent still uses the wrapper. `AGENTS.md` points that contract at `intent/config-error-restart/`. The portable-mail folder stays unchanged.

Checked 2026-11-01. The systemd.service manual says `Restart=on-failure` restarts on a non-zero exit code and on a signal, excluding `SIGHUP`, `SIGINT`, `SIGTERM`, and `SIGPIPE`. Those four are clean exits for every type except `Type=oneshot`. The unit on main is `Type=simple`. Its `ExecStart` is the wrapper, then `/ABS/PATH/TO/node`, then `/ABS/PATH/TO/HOME/snail/snail.js`, then `--config`, then `/ABS/PATH/TO/HOME/.config/snail/config.toml`. `assertCleanArgv` in `snail.js` expects exactly those four arguments in that order: the Node binary, this script, `--config`, and the config path. A longer list exits 2. The plist's `KeepAlive` dictionary sets `SuccessfulExit` false, and `ThrottleInterval` is 10, which is the about-10-second relaunch. `loadSnailConfig` returns `exitCode` 2 for a non-absolute path, an io error, mode, owner, and parse failure (`src/config.js`). `snail.js` exits 2 on usage and on that load failure. It exits 1 for a missing build stamp, a wrong Node major, and a fatal exception. The existing `test/install-docs.test.js` check "maps exit 2 to 0" only asserts that the script source matches `-eq 2` and `exit 0`, so it passes while D1's bug is present.

Rejected: leaving `ExecStart` on the wrapper after D1. The main process would exit 0, `RestartPreventExitStatus=2` would not match, and the Linux path would be the launchd mapping. Rejected: keeping the wrapper path in the argument list ahead of the Node binary. `assertCleanArgv` would see the wrong length and exit 2, and the unit would stay down on status 2 without watching mail. Rejected: a new plist flag to turn the mapping on. The plist already invokes the wrapper with the arguments that must map. Rejected: changing `Restart=` so a clean signal restarts. Rejected: editing `intent/portable-mail/` to rewrite D8.

**D3 — Prove it by running the wrapper.** AC1 and AC2 spawn `scripts/run-service.sh`. AC5 spawns it again for the two markers. The source match may stay in the file. It is not the acceptance check.

## 8. Open questions

None.
