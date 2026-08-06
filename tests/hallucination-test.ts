import {
  cleanTranscript,
  collapseRepeatingNgrams,
  stripHallucinationPhrases,
  trimTrailingDegenerateTail,
} from "../lib/hallucinations";
import type { Word } from "../lib/types";

function w(text: string, i: number): Word {
  return { id: i, text, start: i * 0.3, end: i * 0.3 + 0.25, speaker: 0, deleted: false };
}

function texts(words: Word[]) {
  return words.map((x) => x.text).join(" ");
}

{
  const loop = "little bit of a little bit of a little bit of a little bit of a"
    .split(" ")
    .map(w);
  const out = collapseRepeatingNgrams(loop);
  console.log("collapse loop:", texts(out));
  if (texts(out) !== "little bit of a") throw new Error("expected single 'little bit of a'");
}

{
  const words = "okay I'm sorry thanks for watching next topic".split(" ").map(w);
  const out = stripHallucinationPhrases(words);
  console.log("strip phrases:", texts(out));
  if (texts(out) !== "okay next topic") throw new Error("phrase strip failed");
}

{
  const raw =
    "this is real speech I'm sorry little bit of a little bit of a little bit of a"
      .split(" ")
      .map(w);
  const out = cleanTranscript(raw);
  console.log("cleanTranscript:", texts(out));
  if (!texts(out).startsWith("this is real speech")) throw new Error("lost real speech");
  if (/i'?m sorry/i.test(texts(out))) throw new Error("sorry not stripped");
  if ((texts(out).match(/little bit of a/g) || []).length > 1) {
    throw new Error("loop not collapsed");
  }
}

{
  const words = "yes yes okay".split(" ").map(w);
  const out = collapseRepeatingNgrams(words);
  console.log("short repeats kept:", texts(out));
  if (texts(out) !== "yes yes okay") throw new Error("over-collapsed short repeats");
}

{
  // A loop that actually ends the clip is still trimmed.
  const words = "this is the real content of the talk you you you you you you you you"
    .split(" ")
    .map(w);
  const out = trimTrailingDegenerateTail(words);
  console.log("trailing loop trimmed:", texts(out));
  if (/you you you/.test(texts(out))) throw new Error("trailing loop not trimmed");
  if (!texts(out).startsWith("this is the real content")) {
    throw new Error("trailing trim ate real speech");
  }
}

{
  // Regression: a degenerate run in the *middle* must not truncate the tail.
  // Verbatim models emit "um uh um uh" runs routinely, and the old backwards
  // scan cut from the first such window to the end of the transcript.
  const head = "so today we are going to talk about how browsers manage memory".split(" ");
  const filler = ["um", "uh", "um", "uh", "um", "uh"];
  const tail = Array.from({ length: 4000 }, (_, k) => `word${k % 137}`);
  const words = [...head, ...filler, ...tail].map(w);
  const out = trimTrailingDegenerateTail(words);
  console.log("mid-transcript filler:", words.length, "->", out.length);
  if (out.length !== words.length) {
    throw new Error(
      `mid-transcript degenerate run truncated the transcript (dropped ${
        words.length - out.length
      } words)`
    );
  }
}

{
  // The same shape, end to end, through cleanTranscript.
  const head = "welcome back to the show today we have a great guest".split(" ");
  const filler = ["um", "uh", "um", "uh", "um", "uh"];
  const tail = "and that is how the whole system fits together thanks everyone".split(" ");
  const out = cleanTranscript([...head, ...filler, ...tail].map(w));
  console.log("cleanTranscript keeps tail:", texts(out));
  if (!texts(out).includes("how the whole system fits together")) {
    throw new Error("cleanTranscript dropped everything after the filler run");
  }
  // Ids stay a dense 0..n-1 range for the store / React keys.
  out.forEach((word, i) => {
    if (word.id !== i) throw new Error(`id ${word.id} at index ${i}`);
  });
}

console.log("ALL HALLUCINATION TESTS PASSED");
