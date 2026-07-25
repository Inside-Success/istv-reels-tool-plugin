#!/bin/bash
#
# ISTV Reel Tool — uninstaller (macOS). Removes the panel from Premiere's CEP
# extensions folder. The PlayerDebugMode preference is left alone: it is harmless
# and other extensions may rely on it.
#
set -euo pipefail

EXT_ID="com.istv.reeltool"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"

printf '\n'
if [ -e "$DEST" ]; then
  rm -rf "$DEST"
  printf '  Removed %s\n' "$DEST"
else
  printf '  Nothing to remove (%s not found).\n' "$DEST"
fi
printf '  Restart Premiere Pro to complete removal.\n\n'
printf '  Cached transcripts and proxies live in ~/.istv-reel-tool — delete that\n'
printf '  folder too if you want a completely clean slate.\n\n'
read -r -p "  Press return to close." _ || true
