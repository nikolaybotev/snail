# spec.md — macOS keychain passwords

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

v0.1.7 already resolves `keychain://<service>/<account>` with `/usr/bin/security` and `find-generic-password -s/-a/-w`, through `execFile`, with no shell. That resolver stays. This phase adds tests that lock it, and it corrects one README sentence. The shipped threat note already compares the Keychain, `op://`, and a mode-`0600` file against same-user malware. The next sentence gives that at-rest benefit to Keychain and 1Password together. That next sentence changes so the benefit stays the Keychain's.

The mode-`0600` inline value stays the fallback on both operating systems. Linux stays that file and `op://`. Docs keep preferring `keychain://` on macOS. The add example keeps `-w` last and does not show `-A`. Nothing in this phase installs software, creates a keychain item, or edits a config outside the repo.

## 2. Goals and non-goals

**Goals**

- G1. The existing `keychain://` resolver stays the tier 3 macOS source, and tests lock its binary, argument list, and `execFile` call with no shell.
- G2. Docs prefer `keychain://` on macOS, keep the inline mode-`0600` value as the fallback, show `security add-generic-password` with `-w` last, and do not show `-A`.
- G3. The threat note keeps the shipped three-way comparison. The next sentence states that the Keychain's value is encryption at rest and keeping the secret out of backups and plain files.
- G4. The same pull request later holds [plan.md](plan.md) and the doc and test lock. It carries neither `release:minor` nor `release:major`. The squash merge that contains that lock publishes `v0.1.8`.

**Non-goals**

- A new secret store, a second secret file, a native keychain module, or a rewrite of `src/secrets.js`.
- Changing `op://`, the inline fallback, the cache, or the backoff.
- A LaunchDaemon, or an edit to `launchd/com.snail.agent.plist`.
- Installing software, creating a keychain item, spawning `/usr/bin/security` or `op`, or editing anyone's config.
- Editing other intent folders.
- Merging this pull request before the plan and the lock are in it.

**Release phasing.** One phase, on this pull request. This commit adds the spec. [plan.md](plan.md) and the doc and test lock are still to be added here. The pull request stays open and is not closed. Checked 2026-11-02: `v0.1.7` is `50ac3f21a8ab568d813d8c5dcc93a4ed107990f5` on the default branch. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. That merge publishes `v0.1.8`. Merging before the lock is in this pull request would publish that patch without it.

## 3. Principles

- P1. `keychain://<service>/<account>` resolved by `/usr/bin/security find-generic-password -s/-a/-w`, with no shell, is the macOS source. The secret is the child's stdout. It is never an argument.
- P2. The mode-`0600` inline value stays a supported fallback on both operating systems. Linux stays that file and `op://`.
- P3. Against same-user malware, the Keychain, `op://`, and a mode-`0600` file are roughly equal. The Keychain's value is encryption at rest and keeping the secret out of backups and plain files.
- P4. Docs prefer `keychain://` on macOS. The add example puts `-w` last so the secret is typed at a prompt. Docs do not show `-w` followed by the secret, and they do not show `-A`.
- P5. The service stays the user GUI LaunchAgent. Placeholders only. No real secrets in the repo.

## 4. Users and scenarios

- **macOS mailbox password.** The operator follows the macOS section, adds a generic password with `-w` last, and sets `keychain://<service>/<account>` in the mode-`0600` config. The running LaunchAgent resolves it with the existing runner.
- **Fallback.** The same field may still be an inline literal in that config, on macOS or on Linux. The example file still shows that placeholder and says it is the fallback.
- **Linux.** The field stays an inline literal or `op://`. This phase does not point a Linux setup at the Keychain.

## 5. Functional requirements

- FR1. `keychainExecArgs` returns file `/usr/bin/security` and args `find-generic-password`, `-s`, the service, `-a`, the account, `-w`. The test asserts the file and the args.
- FR2. `defaultKeychainRunner` calls its exec implementation with that file, that args list, and the options object `{ encoding: 'utf8', maxBuffer: 1048576 }`. That object has no `shell` property. Stdout `'secret-value\n'` is returned as `'secret-value'`. The secret is not an argument. The test injects the exec implementation and does not spawn `/usr/bin/security`.
- FR3. `src/secrets.js` imports `execFile` from `node:child_process`. `execFileAsync` is `promisify(execFile)`. `defaultKeychainRunner`'s default third parameter is `execFileAsync`. The file does not call `exec(` and does not set `shell`. `package.json` `dependencies` and `devDependencies` do not include `keytar` or `@napi-rs/keyring`.
- FR4. In `README.md`, the threat note's first sentence stays: "Against same-user malware, Keychain, `op://`, and a mode-`0600` config file are roughly similar." The next sentence becomes: "The Keychain's value is encryption at rest and keeping the secret out of backups and plain files." The sentence "Keychain and 1Password help with encryption at rest and keeping secrets out of backups and plain files." is removed. The sentence "Snail never logs secrets, never puts them on argv, and never writes them into files it creates." stays.
- FR5. `README.md` keeps this add command, with `-w` last and no value after it: `security add-generic-password -s snail -a personal-imap -w`. It keeps "Do not put the password on the command line after `-w`." and "`op://` is for Linux; the macOS docs path is Keychain, not 1Password references." `README.md` and `snail.example.toml` contain no `-A` flag and no `-w` followed by a token. In `snail.example.toml` the preference sentence is the third comment line: "Inline values are the fallback. Prefer keychain:// on macOS and op:// on Linux." The first comment line is the copy-to header. The second says not to commit the real file. The file keeps `password = "REPLACE-WITH-MAILBOX-PASSWORD"` and `password = "keychain://snail/personal-imap"`.
- FR6. Every `*.plist` in the tree contains `LimitLoadToSessionType` with the value `Aqua`. `launchd/com.snail.agent.plist` is one of those files. This phase does not edit it.
- FR7. This phase does not change resolver behavior. `createAccountSecretResolver`, `op://`, the in-memory cache, and the 5-second-to-60-second backoff stay as they are on `v0.1.7`. No new reference form is added.
- FR8. This phase does not install software, create a keychain item, spawn `/usr/bin/security` or `op`, or edit a config outside the repo. The unattended add, find, and delete proof stays outside the repo and is not repeated here.

## 6. Acceptance criteria

| ID | Check |
|---|---|
| AC1 | `npm test` calls `keychainExecArgs('my-service', 'my-account')` and requires `file` `/usr/bin/security` and args `['find-generic-password', '-s', 'my-service', '-a', 'my-account', '-w']`. |
| AC2 | The same test calls `defaultKeychainRunner` with an injected exec implementation that returns stdout `secret-value\n`. The implementation is called once with `/usr/bin/security`, the AC1 args, and `{ encoding: 'utf8', maxBuffer: 1048576 }`. The returned string is `secret-value`. The args do not contain that string. |
| AC3 | The same test reads `src/secrets.js` and requires `execFile` imported from `node:child_process`, `execFileAsync` assigned `promisify(execFile)`, and `defaultKeychainRunner`'s default third parameter `execFileAsync`. The source does not call `exec(` and does not set `shell`. `package.json` dependencies and devDependencies do not include `keytar` or `@napi-rs/keyring`. |
| AC4 | The same test reads `README.md` and finds the FR4 first sentence unchanged, the FR4 second sentence in place of the Keychain-and-1Password sentence, and the unchanged "never logs secrets" sentence. |
| AC5 | The same test reads `README.md` and `snail.example.toml` and finds the FR5 command, both password examples, no `-A` flag, and no `-w` followed by a token. The preference sentence is the third comment line of `snail.example.toml`. The first two comment lines stay the copy-to header and the do-not-commit line. |
| AC6 | The same test requires every `*.plist` in the tree to contain `LimitLoadToSessionType` with the value `Aqua`. `launchd/com.snail.agent.plist` is one of those files. |

`npm test` is `node --test`. Healthy: exit 0. AC1 through AC3 live in `test/secrets.test.js`. AC4 through AC6 live in `test/install-docs.test.js`. Both files run in that command. Existing tests in those files stay.

## 7. Design decisions

**D1 — Lock the existing runner. Do not replace it.** Checked 2026-11-02. On this branch, `src/secrets.js`, `README.md`, `snail.example.toml`, `package.json`, `launchd/com.snail.agent.plist`, `test/secrets.test.js`, and `test/install-docs.test.js` match `v0.1.7` (`50ac3f21a8ab568d813d8c5dcc93a4ed107990f5`). `keychainExecArgs` returns file `/usr/bin/security` and args `find-generic-password`, `-s`, service, `-a`, account, `-w`. `defaultKeychainRunner(service, account, execImpl = execFileAsync)` calls `execImpl(file, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 })` and returns `stdout.replace(/\n$/, '')`. `1024 * 1024` is 1048576, the `maxBuffer` value in the FR2 options object. `execFileAsync` is `promisify(execFile)` from `node:child_process`. The current args test destructures `args` only, so a change of binary would still pass. `package.json` depends on `imapflow`, `mailparser`, `ws`, and devDependency `imapkit`.

The new test injects `execImpl` for AC2, so that call does not use the default. AC3 requires the default: `execFileAsync` is `promisify(execFile)`, and `defaultKeychainRunner`'s default third parameter is `execFileAsync`. A later `promisify(exec)` default fails AC3. `exec` runs through a shell. The test does not spawn `/usr/bin/security`. The resolver's parse, cache, backoff, and Linux rejection tests stay. This phase does not edit `src/secrets.js`.

Rejected: a native module, a second secret file, a shell string, and any new reference form.

**D2 — Correct the second threat sentence only.** Checked 2026-11-02. `README.md` under "Threat model note" is three sentences. The first is "Against same-user malware, Keychain, `op://`, and a mode-`0600` config file are roughly similar." That is the shipped three-way comparison, and it stays, including the words "roughly similar" and "config file". The second is "Keychain and 1Password help with encryption at rest and keeping secrets out of backups and plain files." That sentence is the one to replace with "The Keychain's value is encryption at rest and keeping the secret out of backups and plain files." The third sentence, beginning "Snail never logs secrets", stays. [Portable mail](../portable-mail/spec.md) D7 already states the three-way equality and the Keychain's at-rest value. This spec does not edit that folder.

Rejected: rewriting the first sentence, and leaving the at-rest benefit shared with 1Password.

**D3 — Preference and `-w` are already written. Tests lock them.** Checked 2026-11-02. `snail.example.toml` line 1 is the copy-to header: "Example only. Copy to ~/.config/snail/config.toml, mode 0600, owned by the service user." Line 2 says not to commit the real file. The preference sentence is the third comment line: "Inline values are the fallback. Prefer keychain:// on macOS and op:// on Linux." AC5 finds it there. A check that the file starts with that sentence fails, and moving the line would retitle the header. The header order stays. The first password is `REPLACE-WITH-MAILBOX-PASSWORD`. The personal account password is `keychain://snail/personal-imap`. `README.md` shows `security add-generic-password -s snail -a personal-imap -w`, says not to put the password on the command line after `-w`, and says the macOS docs path is Keychain. Neither file shows `-A`. The inline placeholder stays, because the fallback stays. The `keychain://` example stays, because that is the macOS form the docs prefer. This phase adds the tests in AC5. It does not retitle the example or remove either password.

Rejected: deleting the inline placeholder, documenting `-w` followed by the secret, and documenting `-A`.

**D4 — The service file stays.** Every `*.plist` in the tree contains `LimitLoadToSessionType` with the value `Aqua`. `launchd/com.snail.agent.plist` is one of those files. This phase does not edit it. A plist without that key and value fails AC6. The outside proof that an unattended user-GUI LaunchAgent completed add, find, and delete through `/usr/bin/security` with no dialog and no timeout is not repeated in CI.

**D5 — This pull request publishes `v0.1.8` only when the lock is in it.** Checked 2026-11-02. `v0.1.7` points at `50ac3f21a8ab568d813d8c5dcc93a4ed107990f5`. A squash merge to `main` with neither `release:minor` nor `release:major` publishes `v0.1.8`. This spec commit is not that merge. [plan.md](plan.md) and the changes in FR4, AC1, AC2, AC3, AC4, AC5, and AC6 land on this same pull request before a merge. The pull request stays open and is not closed.

## 8. Open questions

None.
