/**
 * Unit tests for SRT / VTT / JSON transcript import.
 * Run: npx tsx scripts/parse-transcript-test.ts
 */
import { parseTranscript } from "../lib/parseTranscript";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  const words = parseTranscript(
    `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,500 --> 00:00:06,000
Alice: How are you?
`,
    "sample.srt"
  );
  assert(words.length === 5, `srt expected 5 words, got ${words.length}`);
  assert(words[0].text === "Hello", "srt first word");
  assert(words[0].start === 1, `srt start ${words[0].start}`);
  assert(words[1].text === "world", "srt second word");
  assert(Math.abs(words[1].end - 3) < 1e-6, "srt cue end on last token");
  assert(words[2].text === "How", "srt speaker label stripped");
  assert(words[2].speaker === 0, "srt Name: maps to speaker 0");
  console.log("srt: ok");
}

{
  const words = parseTranscript(
    `WEBVTT

00:00:00.000 --> 00:00:02.000
<v Ned>Winter is coming

00:00:02.500 --> 00:00:04.000
<v Catelyn>You know nothing
`,
    "sample.vtt"
  );
  assert(words.length === 6, `vtt expected 6 words, got ${words.length}`);
  assert(words[0].speaker === 0 && words[0].text === "Winter", "vtt voice 0");
  assert(words[3].speaker === 1 && words[3].text === "You", "vtt voice 1");
  console.log("vtt: ok");
}

{
  const words = parseTranscript(
    JSON.stringify({
      words: [
        { text: "One", start: 0, end: 0.4, speaker: "A" },
        { text: "Two", start: 0.4, end: 0.8, speaker: "B" },
      ],
    }),
    "sample.json"
  );
  assert(words.length === 2, "json length");
  assert(words[0].speaker === 0 && words[1].speaker === 1, "json speakers");
  console.log("json: ok");
}

{
  let threw = false;
  try {
    parseTranscript("   ", "empty.srt");
  } catch {
    threw = true;
  }
  assert(threw, "empty should throw");
  console.log("empty: ok");
}

console.log("ALL PARSE TRANSCRIPT TESTS PASSED");
