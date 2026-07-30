ISTV Reel Tool - Premiere Pro panel
===================================

You need: Adobe Premiere Pro 2021 (15.0) or newer, and the access token
from your admin. Nothing else - FFmpeg is already bundled.

Your zip contains the installer for YOUR platform only. If you see
install.bat, follow the Windows steps. If you see install.command, follow
the macOS steps.


INSTALL - WINDOWS (64-bit)
--------------------------

  1. Close Premiere Pro.
  2. Unzip this download (right-click > Extract All).
     Run it from the extracted folder, not from inside the zip.
  3. Double-click  install.bat
     - If Windows SmartScreen warns: "More info" > "Run anyway".
     - A black window opens, prints two steps, and waits for a keypress.
  4. Open Premiere Pro.
  5. Menu:  Window  >  Extensions  >  ISTV Reel Tool
  6. The panel asks for an access token. Paste the one your admin gave you
     and click "Save & verify".

  Installs to: %APPDATA%\Adobe\CEP\extensions\com.istv.reeltool
  No admin rights needed.


INSTALL - MAC, APPLE SILICON (M1/M2/M3/M4)
------------------------------------------

  Use the mac-arm64 download. To check which Mac you have:
  Apple menu > About This Mac - "Apple M..." means Apple Silicon.

  1. Close Premiere Pro.
  2. Unzip this download (double-click the zip).
  3. Double-click  install.command
     - If macOS says it "cannot be opened because it is from an
       unidentified developer": right-click install.command > Open >
       Open. You only need to do this once.
     - A Terminal window opens, prints three steps, and waits for you
       to press return.
  4. Open Premiere Pro.
  5. Menu:  Window  >  Extensions  >  ISTV Reel Tool
  6. The panel asks for an access token. Paste the one your admin gave you
     and click "Save & verify".

  Installs to: ~/Library/Application Support/Adobe/CEP/extensions/com.istv.reeltool
  No admin rights needed.


INSTALL - MAC, INTEL
--------------------

  Use the mac-x64 download. To check: Apple menu > About This Mac -
  "Intel" means Intel.

  Steps are identical to Apple Silicon above.


USING IT
--------

  1. Open your interview in a sequence (drop the clip on a timeline).
  2. In the panel, type the speaker's name and choose how many reels,
     then click "Generate the reels".
  3. When the reels appear, click "Build the reels" (or build them one at
     a time). Each becomes a ready-to-edit 9:16 sequence in an
     "ISTV Reels" bin, with the cuts, vertical reframe and captions
     already in place.
  4. Optional: open a reel's caption editor to fix wording or timing, or
     switch caption style, then rebuild that reel.
  5. Tweak on the timeline and export as usual
     (File > Export / Media Encoder).

  Your video never leaves your computer. Only a small audio-only MP3 is
  uploaded, for transcription.


TO REMOVE IT
------------

  Windows:  double-click  uninstall.bat
  macOS:    double-click  uninstall.command


TROUBLE?
--------

  The panel is missing from the Extensions menu:
    - Make sure you FULLY quit and reopened Premiere after installing.
    - Re-run the installer.
    - Make sure you extracted the zip first and ran the installer from
      the extracted folder.

  "Backend access required" / the panel asks for a token again:
    - The token is wrong, or it was changed. Ask your admin for the
      current one. Your token is saved per-machine, so you only enter it
      once unless it changes.

  "Backend not reachable":
    - The transcription service is not responding. Contact your admin.
      Nothing is wrong with your install.

  "Could not run ffmpeg" / audio extraction fails:
    - The message names the platform this bundle was built for. If that
      does not match your machine, you have the wrong download - get the
      one for your platform (Windows / Apple Silicon / Intel).

  macOS: install.command will not open at all:
    - Right-click it > Open > Open. If that fails, open Terminal, type
      "bash " (with the space), drag install.command into the window,
      and press return.
