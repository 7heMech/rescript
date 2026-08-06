import {
  diarizationWindows,
  stitchDiarizationWindows,
  DIARIZE_WINDOW_S,
  DIARIZE_OVERLAP_S,
  type DiarizationSegment,
  type DiarizationWindow,
} from "../lib/diarize";

const SR = 16_000;

function seg(id: number, start: number, end: number): DiarizationSegment {
  return { id, start, end, confidence: 0.9 };
}

/** Which global id covers `t`, or 0 for none. */
function speakerAt(segments: DiarizationSegment[], t: number): number {
  const hit = segments.find((s) => t >= s.start && t < s.end);
  return hit ? hit.id : 0;
}

{
  // Windows tile the audio with the requested overlap and no gaps.
  const spans = diarizationWindows(SR * 100, SR);
  console.log("windows for 100s:", spans.map((s) => `${s.startSample / SR}-${s.endSample / SR}`).join(" "));
  if (spans[0].startSample !== 0) throw new Error("first window must start at 0");
  if (spans[spans.length - 1].endSample !== SR * 100) {
    throw new Error("last window must reach the end of the audio");
  }
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].startSample > spans[i - 1].endSample) {
      throw new Error(`gap between window ${i - 1} and ${i}`);
    }
  }
  for (const s of spans) {
    const len = (s.endSample - s.startSample) / SR;
    if (len > DIARIZE_WINDOW_S + 1e-6) throw new Error(`window too long: ${len}s`);
  }
}

{
  // Audio shorter than one window is a single pass.
  const spans = diarizationWindows(SR * 5, SR);
  if (spans.length !== 1 || spans[0].endSample !== SR * 5) {
    throw new Error("short audio should produce exactly one full-length window");
  }
}

{
  // Every window is bounded, whatever the file length — this is the property
  // that keeps peak memory flat instead of scaling with duration.
  const spans = diarizationWindows(SR * 3600, SR);
  const longest = Math.max(...spans.map((s) => (s.endSample - s.startSample) / SR));
  console.log("1h ->", spans.length, "windows, longest", longest, "s");
  if (longest > DIARIZE_WINDOW_S + 1e-6) throw new Error("window grew with duration");
}

{
  // The core stitch: pyannote's class indices are arbitrary per window, so the
  // same person is class 1 in the first window and class 2 in the second.
  // Both windows are 30 s with 5 s of overlap (25..30).
  const windows: DiarizationWindow[] = [
    {
      offsetS: 0,
      durationS: 30,
      segments: [seg(1, 0, 12), seg(2, 12, 24), seg(1, 24, 30)],
    },
    {
      // Local time 0 == media time 25. Alice (global 1) holds 25..35,
      // then Bob (global 2) takes over — but the model labelled them 2 and 1.
      offsetS: 25,
      durationS: 30,
      segments: [seg(2, 0, 10), seg(1, 10, 30)],
    },
  ];
  const out = stitchDiarizationWindows(windows);
  console.log(
    "stitched:",
    out.map((s) => `${s.id}@${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(" ")
  );

  // Alice speaks at 26 s (window 1 class 1) and at 33 s (window 2 class 2).
  // The stitch must call those the same person.
  if (speakerAt(out, 26) !== speakerAt(out, 33)) {
    throw new Error("speaker identity was not carried across the window boundary");
  }
  // And the speaker who takes over at 35 s must be someone else.
  if (speakerAt(out, 40) === speakerAt(out, 33)) {
    throw new Error("distinct speakers were merged across the boundary");
  }
  // The timeline is covered exactly once, in order.
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end - 1e-6) {
      throw new Error("stitched segments overlap");
    }
  }
  if (out.some((s) => s.end <= s.start)) throw new Error("empty segment emitted");
  const last = out[out.length - 1];
  if (Math.abs(last.end - 55) > 1e-6) throw new Error(`timeline ends at ${last.end}, want 55`);
}

{
  // A speaker who only appears in the later window gets a new id rather than
  // being folded into whoever was talking before.
  const windows: DiarizationWindow[] = [
    { offsetS: 0, durationS: 30, segments: [seg(1, 0, 30)] },
    { offsetS: 25, durationS: 30, segments: [seg(1, 0, 5), seg(3, 5, 30)] },
  ];
  const out = stitchDiarizationWindows(windows);
  const ids = new Set(out.map((s) => s.id));
  console.log("new speaker:", [...ids].join(","), out.length, "segments");
  if (ids.size !== 2) throw new Error(`expected 2 speakers, got ${ids.size}`);
  if (speakerAt(out, 10) === speakerAt(out, 50)) {
    throw new Error("a genuinely new speaker was merged into the previous one");
  }
}

{
  // Same speaker straight through: the boundary must not show up as a split,
  // and must not invent a second speaker.
  const windows: DiarizationWindow[] = [
    { offsetS: 0, durationS: 30, segments: [seg(1, 0, 30)] },
    { offsetS: 25, durationS: 30, segments: [seg(1, 0, 30)] },
    { offsetS: 50, durationS: 30, segments: [seg(2, 0, 30)] },
  ];
  const out = stitchDiarizationWindows(windows);
  console.log("continuous speaker ->", out.length, "segment(s)");
  if (out.length !== 1) throw new Error(`boundary leaked into output: ${out.length} segments`);
  if (Math.abs(out[0].end - 80) > 1e-6) throw new Error("continuous run truncated");
}

{
  // Silence-only windows contribute nothing and break nothing.
  const windows: DiarizationWindow[] = [
    { offsetS: 0, durationS: 30, segments: [seg(0, 0, 30)] },
    { offsetS: 25, durationS: 30, segments: [] },
  ];
  const out = stitchDiarizationWindows(windows);
  if (out.length !== 0) throw new Error("silence produced speaker segments");
}

{
  if (DIARIZE_OVERLAP_S >= DIARIZE_WINDOW_S) {
    throw new Error("overlap must be shorter than the window or windows cannot advance");
  }
}

console.log("ALL DIARIZE TESTS PASSED");
