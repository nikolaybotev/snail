# spec.md — Config-error restart

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 1 |
| Stage | 2 · Design |

## 1. Summary

The LaunchAgent wrapper is supposed to turn snail's status 2 into status 0 so launchd does not treat a config error as a crash. The wrapper enables `set -euo pipefail` and runs snail as a simple command, so bash exits on status 2 before the mapping. launchd restarts the agent on the plist's 10-second throttle. The mapping has to run. The systemd unit keeps `RestartPreventExitStatus=2` as its own way to ignore status 2, and the unit's main process must still exit 2.

## 2. Goals and non-goals

**Goals**

- G1. When the LaunchAgent runs `scripts/run-service.sh` and snail exits 2, the wrapper exits 0.
- G2. A config error does not restart the LaunchAgent or the systemd user service.
- G3. systemd still prevents that restart with `RestartPreventExitStatus=2`, because the service process exits 2.
- G4. A crash, a fatal exit 1, and a signal death still restart on both supervisors.

**Non-goals**

- Changing which failures snail reports as status 2 or status 1.
- Changing `KeepAlive`, `ThrottleInterval`, `LimitLoadToSessionType`, `RunAtLoad`, or the plist's program arguments.
- Removing `RestartPreventExitStatus=2`, `Restart=on-failure`, or `RestartSec=10`.
- A live launchd or systemd check in CI, an install, or a deploy.
- Editing `intent/portable-mail/`, skills, or files outside this repo.

**Release phasing.** One release. Every untagged requirement is in the single plan phase.

## 3. Principles

- P1. Status 2 means "do not restart": the wrapper turns it into 0 for launchd, and systemd still receives 2 from snail.
- P2. Every other child status is passed through, including 0, 1, and a signal death.
- P3. The wrapper adds no output of its own and does not hide the child's stdout or stderr.
- P4. The wrapper does not log its arguments and does not write a secret, a token, or a config body.

## 4. Users and scenarios

- **Config error under launchd.** The plist starts `scripts/run-service.sh`. Snail exits 2. The wrapper exits 0. `KeepAlive` with `SuccessfulExit` false does not start another instance.
- **Crash under launchd.** Snail exits 1, or the child dies by signal. The wrapper exits with that same non-zero status. launchd restarts the agent. `ThrottleInterval` stays 10.
- **Config error under systemd.** The unit's main process is snail. Snail exits 2. `RestartPreventExitStatus=2` prevents `Restart=on-failure` from starting it again.
- **Crash under systemd.** Snail exits 1 or dies by a signal. `Restart=on-failure` restarts it after `RestartSec=10`.

## 5. Functional requirements

- FR1. `scripts/run-service.sh` keeps `set -euo pipefail` and `#!/usr/bin/env bash`. The node and snail arguments stay required. The child is invoked so a non-zero status does not abort the script before the mapping. Status 2 becomes wrapper status 0. The script does not `exec` the child.
- FR2. Wrapper status 0 stays 0. Wrapper status 1 stays 1. A child that dies by SIGTERM yields a non-zero wrapper status. No status other than 2 is mapped to 0.
- FR3. The child's stdout and stderr are the wrapper's stdout and stderr, with nothing added and nothing removed.
- FR4. `snail.service` `ExecStart` is the Node binary, then `snail.js`, then the existing arguments, including `--config` and the config path. The line does not name `scripts/run-service.sh`. `Restart=on-failure`, `RestartPreventExitStatus=2`, and `RestartSec=10` stay. The existing placeholder tokens stay.
- FR5. `launchd/com.snail.agent.plist` still runs `scripts/run-service.sh` with the arguments it has now, and it still sets `KeepAlive` / `SuccessfulExit` to false and `ThrottleInterval` to 10.
- FR6. Status 2 stays the non-restart status for both usage and config load. The wrapper maps on the status alone. It does not inspect stderr for a config-error string.
- FR7. Acceptance runs the wrapper. A source-text match that the file contains `-eq 2` and `exit 0` does not satisfy FR1.

## 6. Acceptance criteria

| ID | Check |
|---|---|
| AC1 | `npm test` spawns `scripts/run-service.sh` with a stub child that exits 2, and the wrapper exits 0. The same test spawns it with `node` and `process.exit(2)`, and the wrapper exits 0. |
| AC2 | The same test: a stub exit of 0 yields wrapper 0; a stub exit of 1 yields wrapper 1; a stub that kills itself with SIGTERM yields a non-zero wrapper status. |
| AC3 | The same test reads `snail.service` and finds `Restart=on-failure`, `RestartPreventExitStatus=2`, and `RestartSec=10`. `ExecStart` contains `snail.js` and `--config` and does not contain `run-service.sh`. |
| AC4 | The same test reads the plist and finds `run-service.sh`, `SuccessfulExit` false, and `ThrottleInterval` 10. |
| AC5 | A stub writes a fixed marker to stdout and another to stderr. Both markers appear on the wrapper's matching stream. |

`npm test` is `node --test`. Healthy: exit 0. The checks above live in `test/install-docs.test.js` and run in that command.

## 7. Design decisions

**D1 — Capture the child status under errexit.** Keep `set -euo pipefail`. Set `status=0`, run the child as `"$NODE" "$SNAIL" "$@" || status=$?`, then exit 0 when `status` is 2 and exit with `status` otherwise. The child's standard streams stay inherited.

Checked 2026-11-01 against `scripts/run-service.sh` on main. The script sets `set -euo pipefail`, runs the child as a simple command, then assigns `status=$?` and maps 2 to 0. Reproduced that shape on bash 5.2.21: child status 0 yields wrapper 0, and child statuses 1 and 2 yield wrappers 1 and 2. The mapping line does not run. The `status=0` / `|| status=$?` shape on the same bash yields wrapper 0 for child 2, wrapper 1 for child 1, wrapper 0 for child 0, and wrapper 143 when the child kills itself with SIGTERM. The same shape with `node` and `process.exit` yields wrapper 0, 1, and 0 for node statuses 2, 1, and 0. The `||` list is POSIX and is the errexit exception bash documents for a command that is not the last in an AND/OR list. It does not need a bash-5 feature.

Rejected: removing `set -e` or the whole `set -euo pipefail` line. The next line would run, and nounset and pipefail would go with it. Rejected: `exec` of the child. The shell would be gone before the mapping. Rejected: mapping only when stderr contains a config phrase. Usage and config load already share status 2, and a phrase match can miss a status-2 failure.

**D2 — The unit runs snail; the wrapper stays on the LaunchAgent.** `snail.service` stops calling `scripts/run-service.sh`. systemd then observes snail's status. `RestartPreventExitStatus=2` still matches a config error. The plist is unchanged and keeps calling the wrapper, so the mapping in D1 is what launchd sees.

Checked 2026-11-01 on main. The unit `ExecStart` is the wrapper, then the Node binary, then `snail.js`, then `--config`. The plist's `KeepAlive` dictionary sets `SuccessfulExit` false, and `ThrottleInterval` is 10, which is the about-10-second relaunch. `loadSnailConfig` returns `exitCode` 2 for a non-absolute path, an io error, mode, owner, and parse failure (`src/config.js`). `snail.js` exits 2 on usage and on that load failure. It exits 1 for a missing build stamp, a wrong Node major, and a fatal exception. The existing `test/install-docs.test.js` check "maps exit 2 to 0" only asserts that the script source matches `-eq 2` and `exit 0`, so it passes while D1's bug is present.

Rejected: leaving `ExecStart` on the wrapper after D1. The main process would exit 0, `RestartPreventExitStatus=2` would not match, and the Linux path would be the launchd mapping. `Restart=on-failure` would also leave a 0 down, so the service would not flap, and the separate path would still be broken. Rejected: a new plist flag to turn the mapping on. The plist already invokes the wrapper with the arguments that must map.

**D3 — Prove it by running the wrapper.** AC1 and AC2 spawn `scripts/run-service.sh`. AC5 spawns it again for the two markers. The source match may stay in the file. It is not the acceptance check.

## 8. Open questions

None.
