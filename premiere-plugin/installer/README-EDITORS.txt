ISTV Reel Tool - Premiere Pro panel
===================================

You only need this zip. Nothing else to download or install.


INSTALL - Windows
-----------------

  1. Close Premiere Pro.
  2. Double-click  install.bat
     (If Windows SmartScreen warns: "More info" > "Run anyway".)
  3. Open Premiere Pro.
  4. Menu:  Window  >  Extensions  >  ISTV Reel Tool


INSTALL - Mac
-------------

  1. Close Premiere Pro.
  2. Double-click  install.command
     - If macOS says it "cannot be opened because it is from an
       unidentified developer": right-click the file, choose Open, then
       click Open in the dialog.
     - If it opens in TextEdit instead of running: open Terminal, type
       "chmod +x " (with the trailing space), drag install.command into
       the window, press Return, then double-click it again.
  3. Open Premiere Pro.
  4. Menu:  Window  >  Extensions  >  ISTV Reel Tool

  Make sure you have the right zip for your Mac:
    Apple menu > About This Mac
      "Apple M1/M2/M3/M4..."  ->  ISTV-Reel-Tool-mac-arm64.zip
      "Intel..."              ->  ISTV-Reel-Tool-mac-x64.zip


FIRST RUN - ENTER YOUR ACCESS TOKEN (once)
------------------------------------------

  The first time you open the panel it asks for an access token. Ask
  whoever runs the ISTV service for it, paste it in, and click
  "Save & connect".

  You only do this once. It is saved on your own machine, not inside the
  download - which is why the download can be public while the service
  stays protected.

  To change it later, click the "Service" badge at the top of the panel.

  The badge tells you where you stand:
    Connected       ready to use
    Token needed    paste the token
    Token rejected  wrong or expired token - ask for a current one
    Service down    the service is not reachable; contact your admin


USING IT
--------

  1. Open your interview in a sequence (drop the clip on a timeline).
  2. In the panel, type the speaker's name, choose how many reels, and
     click "Generate reels".
  3. When the reels appear, click "Build reels" (or Build on a single
     reel). Each becomes a ready-to-edit 9:16 sequence in an
     "ISTV Reels" bin, with the cuts, vertical reframe, and captions
     already in place.
  4. Tweak on the timeline and export as usual (File > Export /
     Media Encoder).

  "Smooth playback" builds a one-time low-res preview so 4K footage
  scrubs without stuttering. Your exports still use the full-quality
  original.

  Re-running the same clip reuses the saved transcript, so it is much
  faster and costs nothing the second time. Tick "Re-transcribe" if you
  want a fresh transcription.


REMOVING IT
-----------

  Windows:  double-click  uninstall.bat
  Mac:      double-click  uninstall.command


TROUBLE?
--------

  The panel is missing from the Extensions menu:
    - Fully quit and reopen Premiere (not just close the project).
    - Run the installer again.
    - Confirm you installed the zip built for your platform - the
      installer prints a warning if it does not match.

  "Token needed" or "Token rejected":
    Click the "Service" badge at the top of the panel and paste the
    token your admin gave you. If it is rejected, ask for a current one.

  "Service down":
    The transcription service is not reachable. Contact your admin - it
    must be up before you can generate reels.

  "Extract audio" fails:
    You are probably running a package built for a different platform.
    Ask for the zip matching your machine (see INSTALL above).

  Reels come out 16:9 instead of tall, or captions arrive as a file you
  have to drag on:
    The optional Premiere template files are not installed. The panel
    says so in a yellow message. It still works - ask your admin about
    the sequence preset and caption template.
