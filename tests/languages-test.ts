import {
  isTranscriptLanguage,
  TRANSCRIPT_LANGUAGE_ORDER,
  TRANSCRIPT_LANGUAGES,
} from "../lib/languages";

{
  if (!isTranscriptLanguage("en")) throw new Error("expected en to be valid");
  if (!isTranscriptLanguage("de")) throw new Error("expected de to be valid");
  if (isTranscriptLanguage("fr")) throw new Error("did not expect fr to be valid");
}

{
  const labels = TRANSCRIPT_LANGUAGE_ORDER.map(
    (id) => TRANSCRIPT_LANGUAGES[id].nativeLabel
  );
  if (labels.join(",") !== "English,Deutsch") {
    throw new Error(`unexpected language order: ${labels.join(",")}`);
  }
}

console.log("ALL LANGUAGE TESTS PASSED");
