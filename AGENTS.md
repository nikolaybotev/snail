# Snail

Snail is a Node.js IMAP IDLE daemon that saves new mail as JSON files and wakes a notifier with metadata only. Portable-mail design and build phases live under `intent/portable-mail/`. The spec wins over the plan; record any plan departure in `intent/portable-mail/plan.md` in the same commit as the code.

## Commands

- Install: `npm ci`
- Test: `npm test` (healthy: exit 0)
- Lint: none
- Build: `bash scripts/build.sh`

## Merge gate

Squash-merge a pull request only when every required check has succeeded. Required status checks: `test`, `javascript`. Do not merge while any required check is missing, pending, failed, or cancelled. Do not use an admin override merge.

## Conventions

- For build and build-review, load and follow the installed **build-practices** skill; do not copy its text into this repo.
- Follow `intent/portable-mail/spec.md` and `intent/portable-mail/plan.md` when building portable mail.

## Architecture

- `snail.js` — current single-account daemon (JSON config beside the script).
- `intent/portable-mail/` — portable-mail intent, spec, and phased plan (on branches that include that tree).

## Prohibitions

Do not introduce behavior that:

- sends a message body to a notifier;
- wakes a backlog UID or a UID from a UIDVALIDITY resync;
- loses or re-saves mail because a notifier failed;
- puts a secret on the command line, in a log, or in a file this program writes;
- loads or reloads a config that is group- or world-readable or not owned by the service user;
- lets one account block another, including backlog on one account blocking another;
- performs a duplicate save;
- skips catch-up after downtime;
- holds the mailbox in memory;
- wakes a message whose file is not durable;
- reconnects an account on reload when its parsed entry did not change;
- drops the live config or exits on a rejected reload.

## Things agents get wrong

- Treating `package.json` `"version"` as the product version — release version comes from git tags and `VERSION` at build time, not from `"0.0.0"`.
