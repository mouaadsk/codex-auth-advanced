#!/usr/bin/env zsh
set -euo pipefail

script_dir=${0:A:h}
exec node "${script_dir}/install-macos.mjs" "$@"
