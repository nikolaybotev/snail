# plan.md — macOS keychain passwords

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 2 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. An amendment that keeps the goals is written into the spec in the same commit, and the coverage row moves in that commit. An amendment that drops a goal is a cut. A procedure fix that does not contradict the spec is recorded in this plan only. A closed plan shows | Status | Finished | in the header table.

## Stops

None. The resolver, the fallback, the threat sentences, and the release boundary are decided in the spec.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` calls `keychainExecArgs('my-service', 'my-account')` and requires `file` `/usr/bin/security` and the FR1 args | 1 |
| AC2 | `npm test` calls `defaultKeychainRunner` with an injected exec implementation and requires the FR2 options and the trimmed stdout | 1 |
| AC3 | `npm test` reads `src/secrets.js` for the `execFileAsync` default and reads `package.json` for the absent native modules | 1 |
| AC4 | `npm test` reads the three threat sentences in `README.md` | 1 |
| AC5 | `npm test` reads the add command, the third comment line of `snail.example.toml`, and both password examples | 1 |
| AC6 | `npm test` reads every `*.plist` for `LimitLoadToSessionType` `Aqua` | 1 |

`npm test` is `node --test`. Healthy: exit 0.

## Publishing

Checked 2026-11-02. `v0.1.7` is `50ac3f21a8ab568d813d8c5dcc93a4ed107990f5` on the default branch. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither `release:minor` nor `release:major`. That merge publishes `v0.1.8`.

This pull request is the squash merge that publishes `v0.1.8`. The phase content is the README sentence and the tests in Phase 1, on this branch. Squash-merge this pull request only after that content is in it and the required checks `test` and `javascript` have succeeded. A missing, pending, failed, or cancelled check has not succeeded. Do not use an admin override. Do not add `release:minor` or `release:major`. Do not close this pull request. Do not open another pull request for the lock. Merging before the README sentence and the tests are in this pull request publishes `v0.1.8` without them.

## Phase 1 — Lock the resolver and the threat sentence

Files: `README.md`, `test/secrets.test.js`, `test/install-docs.test.js`

`src/secrets.js` is not in that list. Checked 2026-11-02: it matches `v0.1.7` and already satisfies FR1, FR2, and FR3. Do not edit it while the new tests pass against that file. If AC1, AC2, or AC3 fails on the unmodified file, the file is already wrong. The only edit then is the smallest change that makes FR1, FR2, and FR3 true. Do not change the cache, the backoff, or `op://`, and do not add a reference form.

1. In `README.md`, replace only the second threat sentence. Leave the first sentence as "Against same-user malware, Keychain, `op://`, and a mode-`0600` config file are roughly similar." Replace "Keychain and 1Password help with encryption at rest and keeping secrets out of backups and plain files." with "The Keychain's value is encryption at rest and keeping the secret out of backups and plain files." Leave "Snail never logs secrets, never puts them on argv, and never writes them into files it creates." Leave the add command `security add-generic-password -s snail -a personal-imap -w`, the sentence "Do not put the password on the command line after `-w`.", and the sentence "`op://` is for Linux; the macOS docs path is Keychain, not 1Password references."
2. In `test/secrets.test.js`, add `defaultKeychainRunner` to the existing require. Add new `test()` calls for AC1, AC2, and AC3. Leave every existing `test()` title and body unchanged. AC1 calls `keychainExecArgs('my-service', 'my-account')` and requires `file` `/usr/bin/security` and args `['find-generic-password', '-s', 'my-service', '-a', 'my-account', '-w']`. AC2 calls `defaultKeychainRunner` with an injected function that returns `{ stdout: 'secret-value\n' }`. That function is called once with `/usr/bin/security`, those args, and `{ encoding: 'utf8', maxBuffer: 1048576 }`. The returned string is `secret-value`. The args do not contain `secret-value`. The test does not spawn `/usr/bin/security`. AC3 reads `src/secrets.js` and requires `const { execFile } = require('node:child_process')`, `const execFileAsync = promisify(execFile)`, and `defaultKeychainRunner(service, account, execImpl = execFileAsync)`. The source does not match `exec(` and does not set `shell`. `package.json` `dependencies` and `devDependencies` do not include `keytar` or `@napi-rs/keyring`.
3. In `test/install-docs.test.js`, add new `test()` calls for AC4, AC5, and AC6. Leave every existing `test()` title and body unchanged, including the tests already titled AC1, AC2, AC3, AC4, AC5, and AC13. AC4 reads `README.md` and requires the three sentences from step 1, and requires that the Keychain-and-1Password sentence is absent. AC5 reads `README.md` and `snail.example.toml`. It requires the add command from step 1, both of `password = "REPLACE-WITH-MAILBOX-PASSWORD"` and `password = "keychain://snail/personal-imap"`, no `-A` flag, and no `-w` followed by a token. The first line of `snail.example.toml` stays `# Example only. Copy to ~/.config/snail/config.toml, mode 0600, owned by the service user.` The second stays `# Replace placeholders. Do not commit the real file.` The third stays `# Inline values are the fallback. Prefer keychain:// on macOS and op:// on Linux.` AC6 lists every `*.plist` in the tree and requires each to contain `<key>LimitLoadToSessionType</key>` followed by `<string>Aqua</string>`. `launchd/com.snail.agent.plist` is one of those files.
4. Do not edit `snail.example.toml`, `launchd/com.snail.agent.plist`, `package.json`, `AGENTS.md`, `REVIEW.md`, or any other intent folder. Do not install software. Do not spawn `/usr/bin/security` or `op`. Do not create a keychain item. Do not edit a config outside the repo.

DoD: `npm test` exits 0.
