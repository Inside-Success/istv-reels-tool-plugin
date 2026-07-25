"use strict";

/**
 * Synthetic backend /select output, shaped exactly like the real thing.
 *
 * Reel 1 is the interesting case: a TWO-SPAN reel whose cut sheet arrives
 * out of order and carries one zero-length row. Words are placed so that the
 * reel-timeline mapping is checkable by hand — see reel1ExpectedWords below.
 *
 * Reel 2 has no cut sheet at all, which is the fallback path.
 */

/** Evenly spaced words: one per second starting at `from`, 1s long, 0.1s gap. */
function words(from, list, speaker = 0) {
  return list.map((word, i) => ({
    word,
    time: from + i * 1.0,
    end: from + i * 1.0 + 0.9,
    speaker,
  }));
}

const reel1Words = [
  // Span A covers 10..14 (4s). These four land inside it.
  ...words(10, ["I", "lost", "everything", "twice"]),
  // 14..20 is NOT in any span — these must be dropped entirely.
  ...words(14, ["um", "you", "know", "sort", "of", "anyway"]),
  // Span B covers 20..23 (3s). Speaker changes here, which forces a block break.
  ...words(20, ["then", "I", "rebuilt"], 1),
];

const analysis = {
  reels: [
    {
      id: 7,
      rank: 1,
      title: 'She Lost Everything Twice: "Then I Rebuilt"',
      caption: "A story about starting over.",
      hashtags: ["#resilience", "#story"],
      why_it_works: "Concrete stakes stated in the first line.",
      spoken_hook: "I lost everything twice",
      // Deliberately unsorted, with a zero-length row that must be filtered out.
      editor_cut_sheet: [
        { start_time_seconds: 20, end_time_seconds: 23, role: "body" },
        { start_time_seconds: 5, end_time_seconds: 5, role: "junk" },
        { start_time_seconds: 10, end_time_seconds: 14, role: "hook" },
      ],
      timestamped_words: reel1Words,
    },
    {
      // No cut sheet, no rank, no title -> every fallback fires at once.
      id: 8,
      start_time_seconds: 100,
      end_time_seconds: 145,
      timestamped_words: words(100, ["second", "reel", "words", "here"]),
    },
  ],
};

/**
 * Reel 1's expected reel-timeline word placement. Span A is 4s long, so span B's
 * words start at reel-time 4.0 even though their source time is 20.0.
 */
const reel1ExpectedWords = [
  { word: "I", localTime: 0 },
  { word: "lost", localTime: 1 },
  { word: "everything", localTime: 2 },
  { word: "twice", localTime: 3 },
  { word: "then", localTime: 4 }, // source 20.0 -> reel 4.0
  { word: "I", localTime: 5 },
  { word: "rebuilt", localTime: 6 },
];

module.exports = { analysis, reel1Words, reel1ExpectedWords, words };
