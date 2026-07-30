import { findFillerWordIds, isFillerWord } from "../lib/fillers";
import type { Word } from "../lib/types";

function w(text: string, id: number, deleted = false): Word {
  return { id, text, start: id, end: id + 0.2, speaker: 0, deleted };
}

{
  const germanFillers = ["äh", "Ähm,", "öhm", "mhh"];
  for (const word of germanFillers) {
    if (!isFillerWord(word)) throw new Error(`expected ${word} to be a filler`);
  }
}

{
  const meaningfulGermanWords = ["also", "genau", "ja"];
  for (const word of meaningfulGermanWords) {
    if (isFillerWord(word)) throw new Error(`did not expect ${word} to be a filler`);
  }
}

{
  const words = [w("Hello", 1), w("ähm", 2), w("uh", 3, true), w("öhm.", 4)];
  const ids = findFillerWordIds(words);
  if (ids.join(",") !== "2,4") throw new Error(`unexpected filler ids: ${ids.join(",")}`);
}

console.log("ALL FILLER TESTS PASSED");
