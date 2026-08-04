#!/bin/sh

set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

ln -sf "$repo_dir/config" "$HOME/.gitconfig"
ln -sf "$repo_dir/a5.config" "$HOME/.a5.gitconfig"
ln -sf "$repo_dir/ignore" "$HOME/.gitignore_global"
ln -sf "$repo_dir/message" "$HOME/.gitmessage"

mkdir -p "$HOME/.local/bin"
legacy_orchard_name="$HOME/.local/bin/treehouse"
if [ -L "$legacy_orchard_name" ]; then
  legacy_target=$(readlink "$legacy_orchard_name")
  case "$legacy_target" in
    */treehouse/bin/treehouse.mjs) rm "$legacy_orchard_name" ;;
  esac
fi
ln -sf "$repo_dir/orchard/bin/orchard.mjs" "$HOME/.local/bin/orchard"

completion_root=${BASH_COMPLETION_USER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion}
completion_root=${completion_root%%:*}
mkdir -p "$completion_root/completions"
ln -sf "$repo_dir/orchard/completions/orchard.bash" "$completion_root/completions/orchard"
