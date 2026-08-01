# git

My personal configuration for [git](https://git-scm.com/)
I will do my best to comment the configuration file. Feel free to crib/steal this for your own personal use.

This includes some sensible (for me) settings, aliases, and a git commit message template.

## Usage

Run `./install.sh` to link the configuration files to the proper location

To use the commit message template, simply run `git commit` and it should read the linked `~/.gitmessage` file.

## Orchard

The installer also exposes the baseline `orchard` worktree manager at `~/.local/bin/orchard`.
Orchard requires Node.js 22 or newer and supports macOS and Linux.
Run `orchard --help` to inspect the available lifecycle commands.
`orchard merge` rebases a clean task branch onto synchronized trunk, automatically aborts conflicts, and advances trunk only by fast-forward without pushing.
