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
`orchard rebase [worktree]` synchronizes tracked trunk and rebases a clean task branch without delivering it.
`orchard deliver [worktree]` shows dirty status, offers an interactive Git commit, then applies the trusted user-level delivery strategy.
It accepts a managed task or the current ordinary feature branch in the primary checkout.
Local delivery rebases and fast-forwards trunk without pushing; a delivered ordinary branch returns on trunk and is removed unless `--keep` is set.
Pull-request delivery rebases and opens exactly `git pr create --web --fill` only when published history remains fast-forward safe, and trusted A5 project classification selects that strategy automatically.
Managed commands infer the current task inside its worktree or accept a worktree intent from the primary trunk checkout.
A managed local delivery invoked from primary trunk recycles immediately; task-worktree invocation returns through Orchard before cleanup, with `orchard deliver --finalize <worktree>` as the human-readable fallback.
Synchronization fast-forwards a behind trunk, accepts unpublished local trunk commits ahead of upstream, and refuses histories that have diverged.
