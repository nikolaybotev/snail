# Review instructions

## Passes

Run three passes and tag each finding with its pass:

- **Bugs:** sending a body to a notifier; waking backlog or UIDVALIDITY-resync mail; losing or re-saving mail after notifier failure; duplicate saves; skipping catch-up; holding the mailbox in memory; waking before the file is durable; reconnecting unchanged accounts on reload; dropping live config or exiting on rejected reload; one account blocking another.
- **Security:** secrets, tokens, or authorization header values in logs, argv, or files snail writes; group- or world-readable config; config not owned by the service user; secrets on the command line.
- **Compliance:** the change matches `intent/portable-mail/spec.md` and `plan.md`, and the conventions in `AGENTS.md`. A departure from the plan that is not written back into `plan.md` in the same change is a compliance finding.

Also apply the installed **build-practices** skill when reviewing build pull requests.

## What Important means here

Reserve Important for findings that leak secrets or mail content to notifiers or logs, break per-account isolation, save duplicates, wake backlog or resync mail incorrectly, or ship behavior the spec forbids. Style and naming are nits.

## Cap the nits

Report at most five nits per review; summarize the rest as a count.

## Do not report

Formatting the CI already enforces, generated files the repo ignores, and wording inside the verbatim prompt block of any `intent.md`.
