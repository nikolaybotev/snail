# Review instructions

## Passes

Run three passes and tag each finding with its pass:

- **Bugs:** sending a body to a notifier; waking backlog or UIDVALIDITY-resync mail; losing or re-saving mail after notifier failure; duplicate saves; skipping catch-up; holding the mailbox in memory; waking before the file is durable; reconnecting unchanged accounts on reload; dropping live config or exiting on rejected reload; one account blocking another; `disableAutoIdle` without `maxIdleTime` under imapflow’s 5-minute socket timeout logging `imap disconnected: Socket timeout` about every 10 minutes; launchd wrapper exiting 2 when snail exits 2; wrapper status other than 143 after a SIGTERM child; systemd `ExecStart` not matching the pinned node-and-`snail.js` line from `intent/config-error-restart/spec.md`; dropping a pending notify when lastUid advances; deleting a notify row without notifier success; logging a webhook URL or an authorization header; ending IDLE on an empty redeliver poll; waiting for IMAP sync before retrying a failed ledger write.
- **Security:** secrets, tokens, or authorization header values in logs, argv, or files snail writes; group- or world-readable config; config not owned by the service user; secrets on the command line.
- **Compliance:** the change matches the relevant intent (`intent/portable-mail/`, `intent/config-error-restart/`, or `intent/durable-notify/` spec and plan when notify delivery changes), and the conventions in `AGENTS.md`. A departure from the plan that is not written back into `plan.md` in the same change is a compliance finding.

Also apply the installed **build-practices** skill when reviewing build pull requests.

## What Important means here

Reserve Important for findings that leak secrets or mail content to notifiers or logs, break per-account isolation, save duplicates, wake backlog or resync mail incorrectly, or ship behavior the spec forbids. Style and naming are nits.

## Cap the nits

Report at most five nits per review; summarize the rest as a count.

## Do not report

Formatting the CI already enforces, generated files the repo ignores, and wording inside the verbatim prompt block of any `intent.md`.
