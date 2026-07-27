import {
  VAD_FRAME_SIZE,
  energySpeechFrames,
  keepMaskFromSpeechFrames,
  muteLongSilence,
} from "../lib/vad";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  // 3s of "speech" energy, 2s silence, 1s speech — at 16 kHz.
  const sr = 16_000;
  const audio = new Float32Array(sr * 6);
  for (let i = 0; i < sr * 3; i++) audio[i] = Math.sin(i / 20) * 0.3;
  // silence in the middle (already zeros)
  for (let i = sr * 5; i < audio.length; i++) audio[i] = Math.sin(i / 20) * 0.3;

  const frames = energySpeechFrames(audio);
  const muted = muteLongSilence(audio, frames, { minSilenceS: 1.5, padS: 0.1 });

  // Mid silence should be zeroed.
  let midEnergy = 0;
  for (let i = sr * 3.5; i < sr * 4.5; i++) midEnergy += Math.abs(muted[i]!);
  assert(midEnergy === 0, "expected mid silence to be muted");

  // Speech regions should survive.
  let speechEnergy = 0;
  for (let i = 0; i < sr; i++) speechEnergy += Math.abs(muted[i]!);
  assert(speechEnergy > 100, "expected early speech to be kept");

  speechEnergy = 0;
  for (let i = sr * 5.2; i < sr * 5.8; i++) speechEnergy += Math.abs(muted[i]!);
  assert(speechEnergy > 50, "expected late speech to be kept");

  console.log("mute long silence: ok");
}

{
  // Short pause (0.4s) should NOT be muted when minSilenceS is 1.5.
  const frames = [
    ...Array(10).fill(true),
    ...Array(Math.round((0.4 * 16_000) / VAD_FRAME_SIZE)).fill(false),
    ...Array(10).fill(true),
  ];
  const total = frames.length * VAD_FRAME_SIZE;
  const keep = keepMaskFromSpeechFrames(frames, total, {
    minSilenceS: 1.5,
    padS: 0,
  });
  assert(
    keep.every(Boolean),
    "short pauses should remain when below minSilenceS"
  );
  console.log("short pause kept: ok");
}

{
  const frames = [
    ...Array(5).fill(true),
    ...Array(Math.round((2 * 16_000) / VAD_FRAME_SIZE)).fill(false),
    ...Array(5).fill(true),
  ];
  const total = frames.length * VAD_FRAME_SIZE;
  const keep = keepMaskFromSpeechFrames(frames, total, {
    minSilenceS: 1.5,
    padS: 0,
  });
  const mutedCount = keep.filter((k) => !k).length;
  assert(mutedCount > 16_000, "expected >1s of muted samples");
  console.log("long silence muted: ok");
}

console.log("ALL VAD TESTS PASSED");
