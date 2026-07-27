import {
  cleanTranscript,
  collapseRepeatingNgrams,
  stripHallucinationPhrases,
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

console.log("ALL HALLUCINATION TESTS PASSED");
