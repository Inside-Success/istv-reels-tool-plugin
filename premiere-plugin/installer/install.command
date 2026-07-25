#!/bin/bash
#
# ISTV Reel Tool — editor installer (macOS, Apple Silicon and Intel).
#
# Double-click this file in Finder. It:
#   1. enables unsigned CEP extensions (defaults write com.adobe.CSXS.N)
#   2. copies the panel into ~/Library/Application Support/Adobe/CEP/extensions
#   3. makes the bundled ffmpeg/ffprobe executable and clears Gatekeeper's
#      download quarantine flag from them
#
# Pure shell on purpose: no Node, no Python, no Homebrew, no Adobe tools. Nothing
# here needs admin rights — everything lands in the user's own Library.
#
set -euo pipefail

EXT_ID="com.istv.reeltool"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$DEST_ROOT/$EXT_ID"

printf '\n  Installing ISTV Reel Tool for Premiere Pro\n'
printf '  -------------------------------------------\n'

# --- 0) Locate the extension payload -----------------------------------------
# In a release bundle the payload sits next to this script. The dev fallback is
# for running installer/install.command straight out of the repo.
SOURCE="$HERE/$EXT_ID"
if [ ! -d "$SOURCE" ]; then
  SOURCE="$(cd "$HERE/.." && pwd)"
fi
if [ ! -f "$SOURCE/CSXS/manifest.xml" ]; then
  printf '\n  ERROR: could not find the extension payload.\n'
  printf '  Expected %s/CSXS/manifest.xml\n' "$SOURCE"
  printf '  Re-unzip the package and keep install.command next to the %s folder.\n\n' "$EXT_ID"
  read -r -p "  Press return to close." _ || true
  exit 1
fi

# --- 1) Allow unsigned extensions to load ------------------------------------
# The macOS equivalent of Windows' HKCU\Software\Adobe\CSXS.N\PlayerDebugMode.
# Written as a string because that is what CEP's plist reader expects.
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode -string "1" 2>/dev/null || true
done
# Flush the preferences daemon so Premiere sees the change without a logout.
killall cfprefsd >/dev/null 2>&1 || true
printf '  [1/3] CEP extensions enabled.\n'

# --- 2) Copy the panel in ----------------------------------------------------
mkdir -p "$DEST_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"
# -R with /. copies contents; exclude VCS/build cruft in case this is a dev run.
( cd "$SOURCE" && tar -cf - \
    --exclude='.git' --exclude='dist' --exclude='node_modules' \
    --exclude='installer' --exclude='tools' --exclude='test' \
    --exclude='.debug' --exclude='.gitignore' --exclude='package-lock.json' \
    . ) | ( cd "$DEST" && tar -xf - )
printf '  [2/3] Panel copied to:\n        %s\n' "$DEST"

# --- 3) Make the bundled FFmpeg runnable -------------------------------------
# Two separate problems, both fatal to "Extract audio" if skipped:
#   • the exec bit (a zip built on Windows cannot carry it), and
#   • com.apple.quarantine, which Gatekeeper stamps on anything downloaded and
#     which makes the binary refuse to launch with an opaque error.
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TARGET="darwin-arm64" ;;
  x86_64) TARGET="darwin-x64" ;;
  *) TARGET="darwin-x64" ;;
esac

FOUND_BIN=0
if [ -d "$DEST/vendor/ffmpeg" ]; then
  find "$DEST/vendor/ffmpeg" -type f \( -name 'ffmpeg' -o -name 'ffprobe' \) -exec chmod +x {} \; 2>/dev/null || true
  FOUND_BIN=1
fi
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true

if [ "$FOUND_BIN" -eq 1 ] && [ -x "$DEST/vendor/ffmpeg/$TARGET/ffmpeg" ]; then
  printf '  [3/3] Bundled FFmpeg ready for %s (%s).\n' "$TARGET" "$ARCH"
else
  printf '  [3/3] WARNING: no bundled FFmpeg found for %s.\n' "$TARGET"
  printf '        This package may have been built for a different platform.\n'
  printf '        The panel will fall back to an ffmpeg on your PATH if you have one.\n'
fi

printf '\n  Done. Restart Premiere Pro, then open:\n'
printf '        Window > Extensions > ISTV Reel Tool\n\n'
printf '  To remove it later: double-click uninstall.command\n\n'
read -r -p "  Press return to close." _ || true
