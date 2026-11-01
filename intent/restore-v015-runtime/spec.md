# spec.md — Restore v0.1.5 runtime

| | |
|---|---|
| Derived from | [intent.md](intent.md) (2026-11-01) |
| Status | Draft 2 |
| Stage | 2 · Design |

## 1. Summary

Tag `v0.1.6` (`48d152e`, squash of pull request 21) is the default branch. Tag `v0.1.5` is `fa91b2f`. The only runtime change in that squash is `createImapFlowClient` in `snail.js`: the constant it uses, the options it sets, the third-argument overrides, and the export of that constant.

On `v0.1.5` the factory sets `disableAutoIdle: true` and `maxIdleTime` to `IDLE_REFRESH_MS` (`4 * 60 * 1000`). A third argument may set `maxIdleTime` and `socketTimeout`. Startup calls the factory with account and password only. `v0.1.6` removes those options and the export. The third argument accepts `socketTimeout` only.

This release puts that factory surface back to tag `v0.1.5`. The harness file that locks those options matches the tag. The `AGENTS.md` and `REVIEW.md` sentences that describe the client match the tag. `intent/auto-idle/` stays. The one phase adds that restore to this pull request. The pull request carries neither `release:minor` nor `release:major`. It stays unmerged until the client change is in it. That merge publishes the next patch.

## 2. Goals and non-goals

**Goals**

- G1. `createImapFlowClient` matches tag `v0.1.5`, including `IDLE_REFRESH_MS`, `disableAutoIdle`, `maxIdleTime`, the third-argument overrides, and the export.
- G2. `test/imap-harness.test.js` matches that tag, so the tests that lock those options match it.
- G3. The IDLE sentences in `AGENTS.md` and `REVIEW.md` match that tag.
- G4. The later phase publishes the next patch. While `v0.1.6` is the latest semver tag, that patch is `v0.1.7`.

**Non-goals**

- Any runtime change besides the `createImapFlowClient` surface in G1.
- Keychain migration. `keychain://` resolution, `src/secrets.js`, and the keychain docs stay as they are.
- Rewriting `intent/auto-idle/` or any other intent folder.
- Bumping imapflow, or editing `package.json` or the lockfile.
- Editing `src/supervisor.js`, the service unit, or the launchd wrapper.
- A config key, CLI flag, or documented user setting for the interval.
- Merging this pull request before the restored client is in it.
- A `release:minor` or `release:major` label on the later phase pull request.
- Deploy.

**Release phasing.** This release is the single phase in [plan.md](plan.md). That phase adds the restored client to this pull request. The pull request stays unmerged until that change is in it. The squash-merge then publishes the next patch, with neither `release:minor` nor `release:major`. Nothing in this intent is postponed. Keychain migration is a cut: it is out of scope, and it does not continue on this intent.

## 3. Principles

- P1. Runtime behavior is the `v0.1.5` `createImapFlowClient` surface.
- P2. The squash `48d152e` has one runtime change, and this release undoes that change.
- P3. Tests that lock the IDLE options match the tag. The handbook sentences match the tag in the same change.
- P4. The later phase publishes the next patch, with neither `release:minor` nor `release:major`.
- P5. Placeholders only. No personal names, emails, phone numbers, addresses, hostnames, machine names, or real mailbox names.

## 4. Users and scenarios

A running service watches a mailbox over IMAP. On `v0.1.6` the production client leaves auto-IDLE on and sets no `maxIdleTime`. After this change the production client is the `v0.1.5` client: `disableAutoIdle: true`, and `maxIdleTime` of 4 minutes. Startup still passes account and password only.

## 5. Functional requirements

- FR1. **Baseline.** Checked 2026-11-01.
  - `git diff --name-only fa91b2f 48d152e` is `AGENTS.md`, `REVIEW.md`, `intent/auto-idle/intent.md`, `intent/auto-idle/plan.md`, `intent/auto-idle/spec.md`, `snail.js`, and `test/imap-harness.test.js`.
  - The `snail.js` delta is `IDLE_REFRESH_MS`, the body and JSDoc of `createImapFlowClient`, and the export of `IDLE_REFRESH_MS`. No other runtime file changes.
  - On `v0.1.5`, `IDLE_REFRESH_MS` is `4 * 60 * 1000` (`snail.js` line 9). The factory sets `disableAutoIdle: true` and `maxIdleTime: IDLE_REFRESH_MS` (lines 135–136). A third argument may set `maxIdleTime`, including `false`, and `socketTimeout` (lines 140–147). It does not clear `disableAutoIdle`. Startup calls the factory with account and password only (line 297). The module exports `IDLE_REFRESH_MS` (line 315).
  - On `v0.1.6` those options and the export are absent. The third argument accepts `socketTimeout` only.
  - `src/supervisor.js` calls `imapFactory(account, password)` on both tags (`v0.1.5` line 263). That call is outside the runtime delta.
  - imapflow stays 1.7.8 (`package-lock.json`).

- FR2. **Production client.** `snail.js` matches tag `v0.1.5`. `createImapFlowClient(account, password)` sets `disableAutoIdle: true` and `maxIdleTime: IDLE_REFRESH_MS`, and omits `socketTimeout`. `IDLE_REFRESH_MS` is `4 * 60 * 1000` and is exported. An optional third argument may set `maxIdleTime` (including `false`) and `socketTimeout`. Startup keeps the two-argument call. The value is not read from config, argv, or the environment.

- FR3. **Tests that lock the client.** `test/imap-harness.test.js` matches tag `v0.1.5`. That tag's harness requires:
  - `AC1 idle refresh: broken maxIdleTime logs Socket timeout`: third argument `{ socketTimeout: 400, maxIdleTime: false }`, recorded `maxIdleTime === false` and `socketTimeout === 400`, then `imap disconnected: Socket timeout` after one `IDLE`, a `DONE`, and a `NOOP`, and before a second `IDLE`.
  - `AC2 idle refresh: maxIdleTime under socketTimeout stays connected`: third argument `{ socketTimeout: 500, maxIdleTime: 150 }`, a second `IDLE` after `DONE`, no `Socket timeout` line across the wait, and one later `EXISTS` that saves one message and sends one webhook with no body.
  - `AC3 idle refresh: production IDLE_REFRESH_MS and two-argument options`: `IDLE_REFRESH_MS === 240000`, that number is less than `5 * 60 * 1000` and less than `10 * 60 * 1000`, and the two-argument options have `maxIdleTime === IDLE_REFRESH_MS`, `disableAutoIdle === true`, and no `socketTimeout` property.
  - The direct `ImapFlow` constructor in the wide-UID case sets `disableAutoIdle: true`.
  - The `v0.1.6` cases `AC2 auto-idle: production two-argument options omit IDLE overrides`, `AC1 auto-idle: short clock proof`, and `AC3 auto-idle: snail.js and test sources omit disableAutoIdle` do not remain.

- FR4. **Handbook.** `AGENTS.md` and `REVIEW.md` match tag `v0.1.5`. The Things agents get wrong bullet is:

  ```markdown
  - Setting `disableAutoIdle: true` on the imapflow client without `maxIdleTime` under the library’s 5-minute socket timeout — the account loop logs `imap disconnected: Socket timeout` about every 10 minutes while TCP stays up.
  ```

  The Bugs clause is `` `disableAutoIdle` without `maxIdleTime` under imapflow’s 5-minute socket timeout logging `imap disconnected: Socket timeout` about every 10 minutes ``. The apostrophe in `library’s` and `imapflow’s` is U+2019. The dash after `timeout` in the `AGENTS.md` bullet is U+2014.

- FR5. **What stays.** `intent/auto-idle/` stays the text on `v0.1.6`. `src/supervisor.js` stays the two-argument `imapFactory` call. `src/secrets.js` and the keychain docs stay. No other product file changes. This intent folder holds [plan.md](plan.md). The phase may add build notes there.

- FR6. **Release.** This pull request carries neither `release:minor` nor `release:major`. The client change lands on this pull request before merge. Its squash-merge to the default branch publishes the next patch. Checked 2026-11-01: `v0.1.6` is `48d152e` on the default branch, `.github/workflows/release.yml` runs on every push to that branch, and `scripts/release-version.sh` patch-bumps a squash merge that has neither label. The next patch after `v0.1.6` is `v0.1.7`. Do not merge while `snail.js` still matches `v0.1.6`. Merging before the client change would publish `v0.1.7` without the restore.

## 6. Acceptance criteria

| AC | What | Check |
|---|---|---|
| AC1 | `snail.js` matches tag `v0.1.5`. | `git diff --exit-code v0.1.5 -- snail.js` |
| AC2 | `test/imap-harness.test.js` matches tag `v0.1.5`. | `git diff --exit-code v0.1.5 -- test/imap-harness.test.js` |
| AC3 | `AGENTS.md` and `REVIEW.md` match tag `v0.1.5`. | `git diff --exit-code v0.1.5 -- AGENTS.md REVIEW.md` |
| AC4 | `npm test` exits 0. The keepalive case still passes with no fetch on that path. | `npm test` |
| AC5 | `intent/auto-idle/`, `src/supervisor.js`, and `src/secrets.js` match `v0.1.6`. | `git diff --exit-code v0.1.6 -- intent/auto-idle src/supervisor.js src/secrets.js` |

`npm test` is `node --test`. Healthy: exit 0. AC1–AC3 and AC5 run on this pull request's branch. Its merge base is `v0.1.6`.

## 7. Design decisions

**D1 — The runtime undo is the `v0.1.5` factory surface.** Checked 2026-11-01. The only runtime file in `48d152e` is `snail.js`, and the only change there is `createImapFlowClient` together with `IDLE_REFRESH_MS` and its export. Restoring `snail.js` to `fa91b2f` is that undo. Rejected: leaving auto-IDLE on. That is the `v0.1.6` client. Rejected: a different interval. The tag's interval is `4 * 60 * 1000`.

**D2 — The harness file matches the tag.** The intent's outcome includes the tests that lock those options. On `v0.1.5` those are the three idle-refresh cases and the direct constructor's `disableAutoIdle: true`. The `v0.1.6` auto-idle cases lock the client this release removes. They do not remain. The rest of the harness file is unchanged between the tags, so matching the file is the same requirement.

**D3 — The handbook matches the tag in the same change.** `REVIEW.md` on `v0.1.6` treats `disableAutoIdle` or `maxIdleTime` on the production client as a bug. The restored client would fail that review. The `v0.1.5` sentences are the ones that describe the restored client. The only handbook delta in the squash is those sentences, so the files match the tag.

**D4 — This pull request publishes the next patch after the client is in it.** Checked 2026-11-01, as FR6 records. Neither `release:minor` nor `release:major` is a patch bump. Both labels make `scripts/release-version.sh` exit non-zero. The next patch after `v0.1.6` is `v0.1.7`. The client change lands on this pull request. The pull request stays unmerged until `snail.js` matches tag `v0.1.5`.

**D5 — Keychain migration is out of scope.** `48d152e` does not change secret resolution. This release does not migrate `keychain://` references, change `src/secrets.js`, or edit the keychain docs. That work does not continue on this intent.

## 8. Open questions

None.
