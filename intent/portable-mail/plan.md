# plan.md — Portable mail

| | |
|---|---|
| Implements | [spec.md](spec.md) Draft 1 |
| Status | Draft 1 |
| Stage | 3 · Build |

Spec wins. Update this file in the same change whenever implementation departs from it.

This file is the draft. Do not open build pull requests until the build gate below has been run and its findings are in the spec and the plan. Do not merge the pull request that only adds `intent/portable-mail/`.

## Models

Fresh-context review of this spec and this plan uses Grok 4.7 High. Every build phase uses Composer 2.5. Do not substitute. If the named model cannot be launched, stop and ask.

## Stops

None.

## Build gate

1. A fresh-context review reads `spec.md` against `intent.md`. It does not edit. Model: Grok 4.7 High.
2. Apply the findings that are right. Re-check any external fact the review disputes.
3. A fresh-context review reads `plan.md` against `spec.md`. It does not edit. Model: Grok 4.7 High.
4. Apply those findings the same way.
5. Build only after both reviews have been applied and nothing in them still needs a decision. One phase below is one pull request. Model: Composer 2.5.

The draft pull request is not a build phase. Squash-merge a build phase only when its checks are green. Never use an admin override. Do not merge a docs-only pull request before the test workflow exists on that branch. Phase 0 contains the test workflow, so it is the first phase that can merge.

After Phase 0 and the CodeQL workflow have merged, the owner adds required status checks named `test` and `javascript`. This plan does not create rulesets, required checks, or other admin settings. Until those checks are required, a phase still has to show `test` and `javascript` green.

## Acceptance-criteria coverage

| AC | Check | Phase |
|---|---|---|
| AC1 | `npm test` config-path and mode cases | 1 |
| AC2 | `npm test` subset and schema cases | 1 |
| AC3 | `npm test` two-account isolation case | 5 |
| AC4 | `npm test` catch-up and `uidValidity` cases | 5 |
| AC5 | `npm test` existing-file case | 3 |
| AC6 | `npm test` limit cases | 3 |
| AC7 | `npm test` webhook key set | 4 |
| AC8 | `npm test` fake OpenClaw handshake | 4 |
| AC9 | `npm test` failing webhook case | 5 |
| AC10 | `npm test` secret redaction and reference cases | 2, 5 |
| AC11 | `npm test` reload add, change, and remove | 6 |
| AC12 | `npm test` rejected and identical reload | 6 |
| AC13 | `npm test` unit and plist assertions | 7 |
| AC14 | `npm test` build script case | 0 |
| AC15 | `npm test` release-version cases | 8 |

`npm test` is `node --test`. Healthy: exit 0.

## Phase 0 — Guardrails and CI

Files: `AGENTS.md`, `REVIEW.md`, `README.md`, `.github/workflows/test.yml`, `.github/workflows/codeql.yml`, `scripts/build.sh`, `package.json`, `package-lock.json`, `.gitignore`, `test/build.test.js`

1. Write `AGENTS.md` from the skill template. Commands: install `npm ci`; test `npm test` (healthy: exit 0); lint none; build `bash scripts/build.sh`. Point at `intent/portable-mail/`. State that the spec wins and that a plan departure is recorded in this file in the same change.
2. Prohibitions in `AGENTS.md`, and the Bugs and Important lines in `REVIEW.md`: sending a body to a notifier; losing or re-saving mail because a notifier failed; a secret in a file, on the command line, or in a log; one account blocking another; a duplicate save; skipping catch-up after downtime; a reload that reconnects an account whose entry did not change; a rejected reload that drops the live config or exits.
3. `REVIEW.md` uses the three passes from the skill template (Bugs, Security, Compliance). Compliance includes a missing plan-departure note.
4. Keep `README.md` accurate for the imported single-account daemon, and point at `intent/portable-mail/`. Phase 7 replaces the install section. Do not describe live reload as already shipping.
5. Workflow `test`, job name `test`, `ubuntu-latest`, `timeout-minutes: 5`, Node 26, `npm ci`, `npm test`. Workflow `CodeQL`, job name `javascript`, language JavaScript, `timeout-minutes: 15`.
6. `scripts/build.sh` implements spec D9 for the tree as it exists in this phase. `package.json` `engines` is `>=26 <27` and `version` stays `0.0.0`. Commit `package-lock.json`. Ignore `dist/` and `build-stamp.json`.
7. `test/build.test.js` sets `VERSION` and asserts the tarball, `SHA256SUMS`, and `node --check snail.js`.

DoD: `npm test` exits 0.

## Phase 1 — TOML config

Files: `src/toml-subset.js`, `src/config.js`, `snail.example.toml`, `test/toml-subset.test.js`, `test/config.test.js`

1. Port the subset and the `mode & 077 == 0` check from spec D1 and D2. Do not add a TOML dependency.
2. Implement the `[[account]]` schema, defaults, and errors from D3. Startup errors and the usage line from FR1 and FR2.
3. Tests cover AC1 and AC2, including boolean, dotted key, inline table, relative `mail_dir`, duplicate name, duplicate `mail_dir`, inline password, and mode `0644` with no file body in the output.
4. Do not switch `snail.js` off its JSON file in this phase.

DoD: `npm test` exits 0.

## Phase 2 — Secret resolvers

Files: `src/secrets.js`, `test/secrets.test.js`

1. Implement D7 with injected runners. Tests do not spawn `op` or `security`.
2. Cover AC10: raw password rejected, both schemes accepted, Linux keychain runner fails that account, a planted secret is absent from logs and from argv of the snail process.
3. Redaction helper used later by reload: replace every in-memory secret with `[redacted]`.

DoD: `npm test` exits 0.

## Phase 3 — Mail store

Files: `src/mail-store.js`, `test/mail-store.test.js`

1. Implement section 6 and D11 and D12: atomic rename, mode `0600`, state file, existing-file guard, truncation, omitted attachments.
2. Tests cover AC5 and AC6 with fixture messages. No network.

DoD: `npm test` exits 0.

## Phase 4 — Notifiers

Files: `src/notifiers/openclaw.js`, `src/notifiers/webhook.js`, `test/notifiers.test.js`

1. Move the imported handshake into the OpenClaw module without changing it (D5). Webhook module posts exactly the D5 keys.
2. Retry delays come from an injected sleeper (FR9).
3. Tests cover AC7 and AC8 against local fakes. A test fails if the webhook body has any other key.

DoD: `npm test` exits 0.

## Phase 5 — One process, many accounts

Files: `snail.js`, `src/supervisor.js`, `test/supervisor.test.js`

1. `snail.js` loads `--config`, checks Node 26 (D13), and starts one loop per account. Delete the inlined gateway code and the ignored positional config path.
2. Each loop resolves its own secrets and owns its backoff and notify retry (FR4, FR5, FR6, D6).
3. Fake IMAP client. Tests cover AC3, AC4, and AC9. The isolation test uses the injected sleeper and finishes in under a second. A test asserts this process's argv is only the Node binary, the script, `--config`, and the absolute path.
4. Config is read once at startup in this phase. Phase 6 adds reload. Do not advertise reload in the README yet.

DoD: `npm test` exits 0.

## Phase 6 — Live reload

Files: `src/config-reload.js`, `src/config-watch.js`, `test/config-reload.test.js`, `snail.js`

1. Port `decideConfigReload` from `drop-box-watcher/ConfigReload.swift` (spec D4): `keepAndLog`, `unchanged`, and `applyAndLog`. Rejection strings and `[redacted]` replacement match the spec.
2. Watch the config file's parent with `fs.watch`. Ignore other filenames. Re-read by path. Do not exit. One extra read after the watch is armed. A watch setup failure logs `config watch failed` and keeps the loaded config.
3. Apply is an account diff. Equal rows are not reconnected. Added, changed, and removed rows touch only those accounts. Removed accounts leave mail and state on disk.
4. Tests cover AC11 and AC12 by calling the reread function, plus one test that writes the file and sees `fs.watch` trigger a reload. The planted secret is absent from the rejection log.

DoD: `npm test` exits 0.

## Phase 7 — Service install and README

Files: `snail.service`, `launchd/com.snail.agent.plist`, `README.md`, `test/install-docs.test.js`

1. Replace the system unit and the `sudo` install with D8. Example plist label `com.snail.agent`. Placeholders only: `/ABS/PATH/TO/HOME`, `/ABS/PATH/TO/node`.
2. Rewrite `README.md` so a stranger can copy `snail.example.toml` to `~/.config/snail/config.toml`, set mode `0600`, install the user service on Linux and the LaunchAgent on macOS, and see the saved-message schema. Document both secret references, both notifiers, and that saving the TOML reloads one account without restarting the others.
3. Tests cover AC13. Assert the files contain `--config`, `Restart=on-failure` or `SuccessfulExit`, and no `sudo`, no `op://` real-looking secret, and no raw password.

DoD: `npm test` exits 0.

## Phase 8 — Release workflow

Files: `.github/workflows/release.yml`, `scripts/release-version.sh`, `test/release-version.test.js`

1. Implement D10. The workflow runs on push to the default branch, job name `publish`, `timeout-minutes: 15`, `ubuntu-latest`. It does not run on pull requests.
2. Tests cover AC15, including the first tag `v0.1.0`, patch, minor, major, both labels, and `noop` when HEAD is already tagged. Label lookup is injectable so the test does not call the network.
3. Do not push a tag from the build pull request. The workflow pushes the tag only on the default branch, after a green build of that commit.

DoD: `npm test` exits 0.

## Owner step after the workflows merge

The owner adds required status checks for the stable job names `test` and `javascript` after Phase 0's test workflow and CodeQL workflow are on the default branch. Later phases squash-merge only when the checks that apply to them are green. No admin override.
