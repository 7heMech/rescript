/**
 * Unit tests for speaker rename / reassign / move / merge / remove.
 * Run: npx tsx tests/speakers-test.ts
 */
import {
  addSpeaker,
  defaultSpeakerName,
  findSpeakerByName,
  moveSpeakerBoundary,
  reassignWords,
  removeSpeaker,
  renameSpeaker,
  replaceSpeaker,
  speakersFromWords,
  speakerLabel,
} from "../lib/speakers";
import type { SpeakerInfo, Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function w(
  id: number,
  text: string,
  speaker: number,
  start = id,
  end = id + 0.5
): Word {
  return { id, text, start, end, speaker, deleted: false };
}

{
  assert(defaultSpeakerName(0) === "Speaker 1", "default 0");
  assert(defaultSpeakerName(2) === "Speaker 3", "default 2");
  const speakers = speakersFromWords([w(0, "a", 0), w(1, "b", 2)]);
  assert(speakers.length === 2, "derive skips missing ids");
  assert(speakers[0].name === "Speaker 1", "name 0");
  assert(speakers[1].id === 2 && speakers[1].name === "Speaker 3", "name 2");
  // Preserve custom names + unused speakers the user added.
  const kept = speakersFromWords(
    [w(0, "a", 0)],
    [
      { id: 0, name: "Alice" },
      { id: 1, name: "Bob" },
    ]
  );
  assert(kept.some((s) => s.id === 1 && s.name === "Bob"), "keep unused");
  assert(speakerLabel(kept, 0) === "Alice", "label lookup");
  console.log("derive: ok");
}

{
  let speakers: SpeakerInfo[] = [
    { id: 0, name: "Speaker 1" },
    { id: 1, name: "Speaker 2" },
  ];
  speakers = renameSpeaker(speakers, 1, "Bob");
  assert(speakers[1].name === "Bob", "rename");
  assert(findSpeakerByName(speakers, "bob")?.id === 1, "find by name");
  const added = addSpeaker(speakers, "Carol");
  assert(added.id === 2 && added.speakers[2].name === "Carol", "add named");
  console.log("rename/add: ok");
}

{
  const words = [w(0, "Hi", 0), w(1, "there", 0), w(2, "friend", 1)];
  const next = reassignWords(words, [1, 2], 0);
  assert(next[1].speaker === 0 && next[2].speaker === 0, "reassign");
  assert(words[2].speaker === 1, "immutable");
  console.log("reassign: ok");
}

{
  // A A | B B B  → move B start onto second A → A | B B B B
  const words = [
    w(0, "one", 0),
    w(1, "two", 0),
    w(2, "three", 1),
    w(3, "four", 1),
    w(4, "five", 1),
  ];
  const earlier = moveSpeakerBoundary(words, 2, 1);
  assert(earlier !== null, "move earlier");
  assert(
    earlier!.map((x) => x.speaker).join("") === "01111",
    `earlier got ${earlier!.map((x) => x.speaker).join("")}`
  );

  // Move B later within its turn → A A A A | B
  const later = moveSpeakerBoundary(words, 2, 4);
  assert(later !== null, "move later");
  assert(
    later!.map((x) => x.speaker).join("") === "00001",
    `later got ${later!.map((x) => x.speaker).join("")}`
  );

  assert(moveSpeakerBoundary(words, 0, 1) === null, "first turn immovable");
  assert(moveSpeakerBoundary(words, 2, 2) === null, "no-op null");
  console.log("move boundary: ok");
}

{
  const words = [w(0, "a", 0), w(1, "b", 1), w(2, "c", 1)];
  const speakers: SpeakerInfo[] = [
    { id: 0, name: "Alice" },
    { id: 1, name: "Bob" },
  ];
  const merged = replaceSpeaker(words, speakers, 1, 0);
  assert(merged !== null, "merge");
  assert(merged!.words.every((x) => x.speaker === 0), "all alice");
  assert(merged!.speakers.length === 1, "bob removed");
  console.log("replace: ok");
}

{
  const words = [
    w(0, "a", 0),
    w(1, "b", 1),
    w(2, "c", 1),
    w(3, "d", 2),
  ];
  const speakers: SpeakerInfo[] = [
    { id: 0, name: "A" },
    { id: 1, name: "B" },
    { id: 2, name: "C" },
  ];
  const removed = removeSpeaker(words, speakers, 1);
  assert(removed !== null, "remove");
  assert(
    removed!.words.map((x) => x.speaker).join("") === "0002",
    `remove reassign got ${removed!.words.map((x) => x.speaker).join("")}`
  );
  assert(!removed!.speakers.some((s) => s.id === 1), "B gone");

  // Removing the first speaker assigns to the following one.
  const removeFirst = removeSpeaker(words, speakers, 0);
  assert(removeFirst !== null, "remove first");
  assert(removeFirst!.words[0].speaker === 1, "first → next");
  console.log("remove: ok");
}

console.log("ALL SPEAKER TESTS PASSED");
