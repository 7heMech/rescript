import {
  alignBatch,
  ctcViterbi,
  ctcVocabFromTokenizer,
  groupWordsForAlignment,
  normalizeForCtc,
  type CtcEmission,
  type CtcTokenizerLike,
  type CtcVocab,
} from "../lib/forcedAlign";
import type { Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// A toy character vocabulary: 0 = blank, 1 = "|", 2.. = A, B, C, ...
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ'";
const VOCAB: CtcVocab = {
  blankId: 0,
  delimiterId: 1,
  encode: (text) =>
    text
      .split("")
      .map((c) => LETTERS.indexOf(c))
      .filter((i) => i >= 0)
      .map((i) => i + 2),
};
const VOCAB_SIZE = LETTERS.length + 2;

/**
 * Emission where each frame is confidently one symbol. `plan` lists the symbol
 * occupying each frame, so the correct alignment is known exactly.
 */
function emissionFor(plan: number[]): CtcEmission {
  const frames = plan.length;
  const logProbs = new Float32Array(frames * VOCAB_SIZE).fill(Math.log(0.001));
  for (let t = 0; t < frames; t++) logProbs[t * VOCAB_SIZE + plan[t]] = Math.log(0.9);
  return { logProbs, frames, vocab: VOCAB_SIZE };
}
const sym = (c: string) => (c === "|" ? 1 : c === "_" ? 0 : LETTERS.indexOf(c) + 2);
/** "_AB_|_C" -> frame plan, one character per frame. */
const plan = (s: string) => s.split("").map(sym);

function word(id: number, text: string, start: number, end: number): Word {
  return { id, text, start, end, speaker: 0, deleted: false };
}

{
  assert(normalizeForCtc("Shot.") === "SHOT", "punctuation is stripped");
  assert(normalizeForCtc("don't") === "DON'T", "apostrophes survive");
  assert(normalizeForCtc("1985") === "", "digits have no spelling");
  assert(
    normalizeForCtc("café", "latin-upper") === "CAFE",
    "accents fold for Latin-upper"
  );
  assert(
    normalizeForCtc("niño", "latin-lower") === "nino",
    "accents fold for Latin-lower / MMS"
  );
  assert(
    normalizeForCtc("über", "latin-lower") === "uber",
    "German umlaut folds"
  );
  assert(
    normalizeForCtc("你好世界!", "cjk") === "你好世界",
    "CJK keeps Han and drops punctuation"
  );
  assert(
    normalizeForCtc("OK了", "cjk") === "OK了",
    "CJK keeps Latin letters uppercased"
  );
  console.log("normalisation: ok");
}

{
  // The path must follow the frames the symbols actually occupy.
  const frames = plan("__CC_AA_TT__");
  const tokens = VOCAB.encode("CAT");
  const path = ctcViterbi(emissionFor(frames), tokens, 0);
  assert(path !== null, "CAT should align");
  // state 2j+1 carries token j
  const framesOf = (j: number) => {
    const out: number[] = [];
    path!.forEach((s, t) => {
      if (s === 2 * j + 1) out.push(t);
    });
    return out;
  };
  assert(framesOf(0)[0] === 2, `C should start at frame 2, got ${framesOf(0)[0]}`);
  assert(framesOf(1)[0] === 5, `A should start at frame 5, got ${framesOf(1)[0]}`);
  assert(framesOf(2)[0] === 8, `T should start at frame 8, got ${framesOf(2)[0]}`);
  console.log("viterbi finds the right frames: ok");
}

{
  // Doubled letters need a blank between them; without one the path is wrong.
  const tokens = VOCAB.encode("BELL");
  const path = ctcViterbi(emissionFor(plan("_BB_EE_LL_L_")), tokens, 0);
  assert(path !== null, "BELL should align");
  const states = new Set(Array.from(path!));
  // Both L tokens must be used (states 5 and 7), not collapsed into one.
  assert(states.has(5) && states.has(7), `both L tokens should appear, got ${[...states]}`);
  console.log("repeated letters keep their blank: ok");
}

{
  // Too few frames to host every token -> refuse rather than guess.
  const short = ctcViterbi(emissionFor(plan("_A_")), VOCAB.encode("ALIGNMENT"), 0);
  assert(short === null, "an impossible alignment must return null");
  assert(ctcViterbi(emissionFor(plan("___")), [], 0) === null, "no tokens -> null");
  console.log("impossible alignments refused: ok");
}

{
  // End to end: two words, deliberately wrong incoming times.
  const frames = plan("__CC_AA_TT___|__SS_AA_TT__");
  const emission = emissionFor(frames);
  const FRAME_S = 0.02;
  const words = [word(0, "Cat", 5.0, 5.1), word(1, "sat.", 5.1, 5.16)];
  const aligned = alignBatch(words, emission, 10, frames.length * FRAME_S, VOCAB);
  assert(aligned !== null, "batch should align");
  const [cat, sat] = aligned!;
  assert(
    Math.abs(cat.start - (10 + 2 * FRAME_S)) < 1e-6,
    `cat should start at frame 2, got ${cat.start}`
  );
  assert(
    Math.abs(cat.end - (10 + 10 * FRAME_S)) < 1e-6,
    `cat should end after frame 9, got ${cat.end}`
  );
  assert(
    Math.abs(sat.start - (10 + 16 * FRAME_S)) < 1e-6,
    `sat should start at frame 16, got ${sat.start}`
  );
  assert(sat.end > sat.start && cat.end <= sat.start, "words must not overlap");
  assert(aligned![0].text === "Cat" && aligned![1].text === "sat.", "text is preserved");
  console.log(
    `end to end: ok (cat ${cat.start.toFixed(2)}-${cat.end.toFixed(2)}, sat ${sat.start.toFixed(2)}-${sat.end.toFixed(2)})`
  );
}

{
  // A word the vocabulary cannot spell still gets a sensible slot.
  const frames = plan("__CC_AA_TT___|__SS_AA_TT__");
  const words = [word(0, "Cat", 0, 0.1), word(1, "1985", 0.1, 0.2), word(2, "sat", 0.2, 0.3)];
  const aligned = alignBatch(words, emissionFor(frames), 0, frames.length * 0.02, VOCAB);
  assert(aligned !== null, "batch with an unspellable word should still align");
  const [a, b, c] = aligned!;
  assert(b.start >= a.end - 1e-9 && b.end <= c.start + 1e-9, "digits sit in the gap");
  assert(b.end > b.start, "digits keep a positive duration");
  console.log(`unspellable word interpolated: ok (${b.start.toFixed(2)}-${b.end.toFixed(2)})`);
}

{
  const many: Word[] = [];
  for (let i = 0; i < 60; i++) many.push(word(i, "w", i * 0.5, i * 0.5 + 0.4));
  const batches = groupWordsForAlignment(many, 10, 0.05);
  assert(batches.length > 1, "long input should be split");
  assert(
    batches.reduce((n, b) => n + b.length, 0) === many.length,
    "batching must not drop words"
  );
  for (const b of batches) {
    assert(b.length > 0, "no empty batches");
    assert(b[b.length - 1]!.end - b[0]!.start <= 16, "batches stay near the limit");
  }
  const flat = batches.flat().map((w) => w.id);
  assert(flat.every((id, i) => id === i), "order is preserved across batches");
  assert(groupWordsForAlignment([], 10).length === 0, "no words -> no batches");
  console.log(`batching: ok (${many.length} words -> ${batches.length} batches)`);
}

/**
 * Vocabulary reading, against fakes that reproduce what the three shipped
 * aligners actually report. Both derivations have a plausible shortcut that is
 * wrong on MMS and silent when it is wrong, so pin the real ids.
 */
{
  /** Build a tokenizer stand-in from a token→id table. */
  const fakeTokenizer = (
    vocab: Record<string, number>,
    padTokenId: number | undefined,
    unkTokenId: number
  ): CtcTokenizerLike => ({
    pad_token_id: padTokenId,
    unk_token_id: unkTokenId,
    convert_tokens_to_ids: (tokens) => tokens.map((t) => vocab[t]),
    // Character-level, mapping anything absent to unk — as Wav2Vec2CTCTokenizer does.
    encode: (text) => text.split("").map((c) => vocab[c] ?? unkTokenId),
  });

  // <pad> is the blank and sits at 0; "|" is a real token.
  const wav2vec2 = fakeTokenizer({ "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4 }, 0, 3);
  const v1 = ctcVocabFromTokenizer(wav2vec2, "latin-upper");
  assert(v1.blankId === 0, "wav2vec2 blank is <pad> at 0");
  assert(v1.delimiterId === 4, "wav2vec2 delimiter is | at 4");
  assert(v1.normalizeMode === "latin-upper", "normalize mode is carried through");

  // MMS: <blank> and <pad> are distinct, and there is no "|" at all.
  const mms = fakeTokenizer({ "<blank>": 0, "<pad>": 1, "</s>": 2, "<unk>": 3 }, 1, 3);
  const v2 = ctcVocabFromTokenizer(mms, "latin-lower");
  assert(v2.blankId === 0, "MMS blank is <blank> at 0, not pad_token_id (1)");
  assert(
    v2.delimiterId === undefined,
    "MMS has no |; encode() would have returned <unk> here"
  );

  // A tokenizer with no vocabulary lookup at all still has to yield something.
  const bare: CtcTokenizerLike = { pad_token_id: 0, encode: () => [] };
  assert(ctcVocabFromTokenizer(bare).blankId === 0, "falls back to pad_token_id");
  assert(ctcVocabFromTokenizer(bare).delimiterId === undefined, "no lookup -> no delimiter");
  assert(ctcVocabFromTokenizer({ encode: () => [] }).blankId === 0, "last resort blank is 0");

  // encode() skips specials and drops nothing else.
  assert(
    JSON.stringify(v1.encode("AB")) === JSON.stringify([3, 3]),
    "encode passes through the tokenizer"
  );
  assert(v1.encode("").length === 0, "empty text encodes to nothing");

  console.log(
    `vocab from tokenizer: ok (wav2vec2 blank ${v1.blankId}/delim ${v1.delimiterId}, ` +
      `MMS blank ${v2.blankId}/delim ${v2.delimiterId})`
  );
}

console.log("ALL FORCED ALIGN TESTS PASSED");
