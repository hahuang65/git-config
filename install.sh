#!/bin/sh

set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

ln -sf "$repo_dir/config" "$HOME/.gitconfig"
ln -sf "$repo_dir/a5.config" "$HOME/.a5.gitconfig"
ln -sf "$repo_dir/ignore" "$HOME/.gitignore_global"
ln -sf "$repo_dir/message" "$HOME/.gitmessage"

mkdir -p "$HOME/.local/bin"
ln -sf "$repo_dir/treehouse/bin/treehouse.mjs" "$HOME/.local/bin/treehouse"
