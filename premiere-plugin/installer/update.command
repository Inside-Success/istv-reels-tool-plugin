#!/bin/bash
#
# ISTV Reel Tool - updater (macOS). Reuses the installer because updating is
# just replacing the installed CEP extension with this package.
#
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/install.command"
