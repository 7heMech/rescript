import {
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

console.log("ALL VAD TESTS PASSED");
