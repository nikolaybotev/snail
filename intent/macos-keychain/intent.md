# intent.md — macOS keychain passwords

| | |
|---|---|
| Author | Snail maintainers |
| Captured | 2026-11-01 |
| Status | Draft |
| Stage | 1 · Plan |
| Feeds | [spec.md](spec.md) → [plan.md](plan.md) |
| Builds on | [Portable mail](../portable-mail/intent.md) |

## Problem

v0.1.7 already resolves a macOS mailbox password from `keychain://<service>/<account>`. The shipped resolver is the tier 3 macOS source. The mode-`0600` config value is still a supported fallback on both operating systems, and on Linux it remains the path beside `op://`.

That choice is not locked. `README.md` and `snail.example.toml` still lead a reader to an inline password, and the threat paragraph treats Keychain and 1Password as one claim. `test/secrets.test.js` checks the `find-generic-password` argument list and does not check that the binary is `/usr/bin/security` or that the call is `execFile` with no shell. Nothing in the suite fails if a later change adds a native keychain module, a second secret file, a LaunchDaemon, or a documented `-w` value or `-A` flag.

## Proposed outcome

macOS mailbox passwords stay on the existing `keychain://<service>/<account>` form. Docs prefer that form on macOS and keep the inline value as the fallback. Linux stays the mode-`0600` file and `op://`. The service stays the user GUI LaunchAgent already shipped.

The resolver in `src/secrets.js` is already complete for this decision. Checked 2026-11-01 on `v0.1.7` (`50ac3f21a8ab568d813d8c5dcc93a4ed107990f5`):

- `keychainExecArgs` returns file `/usr/bin/security` and args `find-generic-password`, `-s`, service, `-a`, account, `-w`.
- `defaultKeychainRunner` calls `child_process.execFile` (no shell). The secret is the child's stdout with one trailing newline removed. It is never an argument.
- `createAccountSecretResolver` accepts `keychain://` on `darwin`, rejects that form on any other platform for that account, caches the value in memory, and backs off from 5 seconds to 60 seconds. A new resolver is built when that account's run starts and again when its config entry changes. Reconnects in the same run reuse the cache.
- `package.json` depends on no keychain native module.
- `launchd/com.snail.agent.plist` is a LaunchAgent with `LimitLoadToSessionType` `Aqua`. The tree has no LaunchDaemon.
- `README.md` already shows `security add-generic-password -s snail -a personal-imap -w` and says not to put the password on the command line after `-w`. It does not show `-A`.

The phase does not add a mechanism and does not rewrite that resolver. It locks the resolver and the docs with tests. Docs keep `-w` last, so the secret is typed at a prompt. They state that against same-user malware the keychain and a mode-`0600` file are roughly equal, and that the keychain's value is encryption at rest and keeping the secret out of the file and backups.

An unattended user-GUI LaunchAgent already completed add, find, and delete through `/usr/bin/security` with no dialog and no timeout. That proof stays outside this repo. This phase does not install anything, does not create a keychain item, and does not edit a config. Those steps are done by hand, outside this repo, and only with explicit approval.

This pull request starts as this file. The phase content is added here before any merge: [spec.md](spec.md), [plan.md](plan.md), and the doc and test lock. The pull request stays open until that content is in it. It is not closed. With neither `release:minor` nor `release:major`, the squash merge that contains the phase publishes `v0.1.8`.

## Affected users and systems

- **Users:** a person who runs Snail as a GUI LaunchAgent and stores the mailbox password in the login keychain, and a person who keeps the password in the mode-`0600` config.
- **Systems:** `src/secrets.js`, `test/secrets.test.js`, `test/install-docs.test.js`, `README.md`, `snail.example.toml`, `launchd/com.snail.agent.plist`, and the release workflow on the default branch.

## Constraints and principles

- The design is closed. `keychain://<service>/<account>` resolved by `/usr/bin/security find-generic-password -s/-a/-w`, with no shell, is the tier 3 macOS source. The mode-`0600` inline value stays a supported fallback on both operating systems. Linux stays that file and `op://`.
- No second secret file. No native keychain module. The service stays a user GUI LaunchAgent, not a LaunchDaemon.
- Docs prefer `keychain://` on macOS. The add example puts `-w` last and does not follow it with the secret. Docs do not show `-A`.
- Against same-user malware, the keychain and a mode-`0600` file are roughly equal. The keychain's value is encryption at rest and keeping the secret out of the file and backups.
- The phase does not install software, create a keychain item, or edit anyone's config. No real secrets in the repo. Placeholders only.
- A code change belongs in the phase only to lock the existing resolver and the docs. The resolver is already complete, so the phase is those docs and the tests that lock them and the resolver.
- This pull request carries neither `release:minor` nor `release:major`. Checked 2026-11-01: `v0.1.7` is `50ac3f21a8ab568d813d8c5dcc93a4ed107990f5` on the default branch. `.github/workflows/release.yml` runs on every push to `main`. `scripts/release-version.sh` patch-bumps a squash merge that has neither label, so that merge publishes `v0.1.8`. Merging this file alone would publish that patch without the lock. The pull request stays open until the phase content is in it, and it is not closed.
- No personal names, emails, phone numbers, addresses, hostnames, or real resource identifiers.
- This is a new intent. Other intent folders stay as they are.

## Open questions (carried into spec.md)

None. The secret form, the resolver, the fallback, the doc rules, and the release boundary above are decided. [spec.md](spec.md) records them and the tests that lock them.

## Original prompt (verbatim)

> Draft only the intent for one ai-native phase on https://github.com/nikolaybotev/snail (current release v0.1.7). Read the installed ai-native-sdlc skill, AGENTS.md, REVIEW.md, and the existing secret resolver. Follow these private notes and do not copy them into the repo.
>
> Closed design, already decided. Do not reopen it and do not invent a new secret store.
>
> macOS mailbox passwords should be read with the existing keychain://service/account form, resolved by /usr/bin/security find-generic-password -s/-a/-w, no shell. That is the tier 3 macOS source. An unattended user-GUI LaunchAgent already completed add, find, and delete through /usr/bin/security with no dialog and no timeout. The mode-0600 config stays a supported fallback on both operating systems, and it stays the Linux path along with op://. No second secret file. No native keychain module. The service stays a user GUI LaunchAgent, not a LaunchDaemon.
>
> Docs must prefer keychain:// on macOS and keep the inline value as the fallback. Show adding an item with -w last, so the secret is typed at a prompt. Do not document -w followed by the secret, and do not document -A. Be honest that against same-user malware the keychain and a 0600 file are roughly equal; the keychain's value is encryption at rest and keeping the secret out of the file and backups.
>
> This phase does not install anything, does not create a keychain item, and does not edit anyone's config. Those steps are done by hand, outside this repo, and only with explicit approval. No real secrets in the repo. A code change belongs in the phase only to lock the existing resolver and the docs. If the resolver is already complete, say that and keep the phase to the docs and tests that lock it. Do not add a new mechanism.
>
> Do not add release:minor or release:major. Do not merge. A squash merge to main publishes the next patch, so this pull request stays open until the phase content is in it. Do not close the pull request. No personal names, emails, phone numbers, addresses, hostnames, or real resource identifiers in repo text.
>
> Stop after the intent pull request exists. Do not write a spec, a plan, or code. Reply with the pull request URL and the intent path.
