# git

My personal configuration for [git](https://git-scm.com/)
I will do my best to comment the configuration file. Feel free to crib/steal this for your own personal use.

This includes some sensible (for me) settings, aliases, and a git commit message template.

## Usage

Run `./install.sh` to link the configuration files to the proper location

To use the commit message template, simply run `git commit` and it should read the linked `~/.gitmessage` file.

## Orchard

The installer also exposes the baseline `orchard` worktree manager at `~/.local/bin/orchard`.
It registers Bash completion for Orchard commands, active worktree intents, and project-level targets.
Orchard requires Node.js 22 or newer and supports macOS and Linux.
Run `orchard --help` to inspect the available lifecycle commands.
`orchard rebase [worktree]` synchronizes the task's recorded base branch and rebases a clean task branch without delivering it.
Interactive and ordinary machine rebases abort conflicts and restore the original task tip.
An owning harness workflow can use `--resolve-conflicts --json` to retain a real conflict with durable recovery metadata, then use the returned operation ID with `--finalize-operation` after resolution.
`orchard repair [worktree]` restores Orchard metadata only for a quarantined task whose exact path and assigned branch binding are proven, leaving Git state unchanged.
`orchard status --refresh` records durable quarantine evidence for conflicting, stale, duplicate, or misplaced registrations and keeps those slots out of normal task commands.
`orchard deliver [worktree]` shows dirty status, offers an interactive Git commit, then applies the trusted user-level delivery strategy.
Orchard records trunk as the base of acquired tasks and records a converted branch's Git creation base when it can prove that base.
Local delivery rebases and fast-forwards the recorded base branch without pushing.
Pull-request delivery rebases onto the recorded base and selects a non-trunk base when it opens `git pr create --web --fill` only after published history remains fast-forward safe.
Both commands infer the current task inside its worktree or accept a worktree intent from the primary trunk checkout.
A local delivery invoked from the main project directory recycles immediately.
Task-worktree invocation returns through Orchard before cleanup, with `orchard deliver --finalize <worktree>` as the human-readable fallback.
A clean task can also be recycled after its exact feature tip is integrated into its recorded base or an exact-head pull request is merged into any branch.
Synchronization fast-forwards a behind trunk, accepts unpublished local trunk commits ahead of upstream, and refuses histories that have diverged.
