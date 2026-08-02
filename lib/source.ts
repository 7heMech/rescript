import { isModelId, type ModelId } from "./models";

/**
 * How the transcript is obtained on the upload screen:
 * a local speech model id, or an imported caption file.
 */
export type TranscriptSource = ModelId | "import";

export function isTranscriptSource(value: unknown): value is TranscriptSource {
  return isModelId(value) || value === "import";
}
