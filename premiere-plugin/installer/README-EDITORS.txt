ISTV Reel Tool — Premiere Pro panel
===================================

Install (Windows):

  1. Close Premiere Pro.
  2. Double-click  install.bat
     (If Windows SmartScreen warns: "More info" > "Run anyway".)
  3. Open Premiere Pro.
  4. Menu:  Window  >  Extensions  >  ISTV Reel Tool

That's it. FFmpeg is already bundled — you don't need to install anything else.

Using it:

  1. Open your interview in a sequence (drop the clip on a timeline).
  2. In the panel, type the speaker's name, choose how many reels and a
     caption style, and click "Generate reels".
  3. When the reels appear, click "Build all in Premiere" (or Build per reel).
     Each reel becomes a ready-to-edit 9:16 sequence in an "ISTV Reels" bin,
     with the cuts, vertical reframe, and captions already in place.
  4. Tweak on the timeline and export as usual (File > Export / Media Encoder).

To remove it later: double-click  uninstall.bat

Trouble? The panel is empty or missing:
  - Make sure you fully restarted Premiere after installing.
  - Re-run install.bat.
  - If "Backend not reachable" shows in the panel, the transcription service
    isn't up — contact your admin (it must be running/hosted).
