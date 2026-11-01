#!/bin/zsh
set -euo pipefail
skill_dir=${0:A:h:h}
# Requires an explicit, reviewed local configuration and sole-owner maintenance.
# The Node entry point validates plist identity and never kills by process name.
exec node "$skill_dir/scripts/iphone-environment.mjs" service install tunnel "$@"
