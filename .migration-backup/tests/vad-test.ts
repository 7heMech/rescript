import {
  MAX_SEGMENT_S,
  VAD_FRAME_SIZE,
  energySpeechFrames,
  speechSegmentsFromFrames,
} from "../lib/vad";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  // 3s speech, 2s silence, 1s speech — at 16 kHz.
  const sr = 16_000;
  const audio = new Float32Array(sr * 6);
  for (let i = 0; i < sr * 3; i++) audio[i] = Math.sin(i / 20) * 0.3;
  for (let i = sr * 5; i < audio.length; i++) audio[i] = Math.sin(i / 20) * 0.3;

  const frames = energySpeechFrames(audio);
  const segs = speechSegmentsFromFrames(frames, audio.length, {
    maxGapS: 1.5,
    padS: 0.1,
  });

  assert(segs.length === 2, `expected 2 speech segments, got ${segs.length}`);
  assert(segs[0]!.startSample < sr, "first segment should start near 0");
  assert(segs[0]!.endSample < sr * 3.5, "first segment should end before mid silence");
  assert(segs[1]!.startSample > sr * 4.5, "second segment should start after silence");
  // Whisper never sees the silent mid region.
  const covered = segs.reduce((n, s) => n + (s.endSample - s.startSample), 0);
  assert(covered < audio.length - sr, "silence should be excluded from coverage");
  console.log("skip long silence: ok", segs);
}

{
  // Short pause (0.4s) should NOT split when maxGapS is 1.5.
  const frames = [
    ...Array(10).fill(true),
    ...Array(Math.round((0.4 * 16_000) / VAD_FRAME_SIZE)).fill(false),
    ...Array(10).fill(true),
  ];
  const total = frames.length * VAD_FRAME_SIZE;
  const segs = speechSegmentsFromFrames(frames, total, {
    maxGapS: 1.5,
    padS: 0,
  });
  assert(segs.length === 1, `short pause should merge into one segment, got ${segs.length}`);
  console.log("short pause merged: ok");
}

{
  const frames = [
    ...Array(5).fill(true),
    ...Array(Math.round((2 * 16_000) / VAD_FRAME_SIZE)).fill(false),
    ...Array(5).fill(true),
  ];
  const total = frames.length * VAD_FRAME_SIZE;
  const segs = speechSegmentsFromFrames(frames, total, {
    maxGapS: 1.5,
    padS: 0,
  });
  assert(segs.length === 2, `expected split on 2s gap, got ${segs.length}`);
  console.log("long silence splits: ok");
}

{
  // All silence → no segments.
  const frames = Array(20).fill(false);
  const segs = speechSegmentsFromFrames(frames, 20 * VAD_FRAME_SIZE);
  assert(segs.length === 0, "all silence should yield no segments");
  console.log("all silence empty: ok");
}

{
  // Continuous speech with no long pause used to come back as one segment
  // spanning the whole recording, which the caller then copies wholesale.
  const sr = 16_000;
  const framesPerSecond = sr / VAD_FRAME_SIZE;
  // 20 minutes of speech, with a brief breath every 10 s (well under maxGapS,
  // so none of them split the run on their own).
  const frames: boolean[] = [];
  for (let s = 0; s < 20 * 60; s++) {
    for (let f = 0; f < framesPerSecond; f++) {
      // ~0.2 s of quiet at the top of every tenth second.
      frames.push(!(s % 10 === 0 && f < framesPerSecond * 0.2));
    }
  }
  const total = frames.length * VAD_FRAME_SIZE;
  const segs = speechSegmentsFromFrames(frames, total, { maxGapS: 1.5, padS: 0 });

  const longest = Math.max(...segs.map((s) => (s.endSample - s.startSample) / sr));
  console.log(`20min continuous -> ${segs.length} segments, longest ${longest.toFixed(1)}s`);
  assert(segs.length > 1, "continuous speech should be split into bounded segments");
  assert(longest <= MAX_SEGMENT_S + 1, `segment of ${longest}s exceeds the ceiling`);

  // Splitting must not lose or reorder audio: segments stay ordered and their
  // union still covers the speech the un-capped version covered.
  for (let i = 1; i < segs.length; i++) {
    assert(segs[i].startSample >= segs[i - 1].endSample, "segments overlap or are unordered");
  }
  const covered = segs.reduce((n, s) => n + (s.endSample - s.startSample), 0);
  const uncapped = speechSegmentsFromFrames(frames, total, {
    maxGapS: 1.5,
    padS: 0,
    maxSegmentS: Infinity,
  });
  const uncappedCovered = uncapped.reduce((n, s) => n + (s.endSample - s.startSample), 0);
  assert(uncapped.length === 1, "control: uncapped should still be a single run");
  assert(
    Math.abs(covered - uncappedCovered) < sr * 0.05,
    `capping changed coverage by ${(uncappedCovered - covered) / sr}s`
  );

  // Cuts should land in the quiet gaps, not through speech.
  const cutsInSilence = segs
    .slice(1)
    .filter((s) => !frames[Math.floor(s.startSample / VAD_FRAME_SIZE)]).length;
  console.log(`${cutsInSilence}/${segs.length - 1} splits landed in silence`);
  assert(cutsInSilence === segs.length - 1, "a split cut through speech");
}

{
  // A segment already under the ceiling is untouched.
  const frames = Array(200).fill(true);
  const total = frames.length * VAD_FRAME_SIZE;
  const segs = speechSegmentsFromFrames(frames, total, { maxGapS: 1.5, padS: 0 });
  assert(segs.length === 1, "short continuous speech should stay one segment");
  assert(segs[0].endSample === total, "segment should reach the end of the audio");
}

console.log("ALL VAD TESTS PASSED");
