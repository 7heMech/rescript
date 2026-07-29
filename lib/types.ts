/** A single transcribed word, timed against the original media. */
export interface Word {
  id: number;
  /** The word text (no surrounding whitespace). */
  text: string;
  /** Start time in seconds, in original media time. */
  start: number;
  /** End time in seconds, in original media time. */
  end: number;
  /** Sequential speaker index (0-based). -1 when unknown. */
  speaker: number;
  /** Deleted words are cut out of the video. */
  deleted: boolean;
}

/** A half-open time range [start, end) in original media seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * A cut range tagged with a stable `key` (the id of the first deleted word in
 * the run that produced it), so manual edge adjustments can be attached to a
 * specific cut even as the derived set changes.
 */
export interface CutRange extends TimeRange {
  key: number;
}

/**
 * A manual override of a word-derived cut's edges, in original media seconds.
 * Either edge may be set independently; an unset edge tracks the word boundary.
 */
export interface CutAdjustment {
  start?: number;
  end?: number;
}

/** Manual cut-edge overrides, keyed by CutRange.key. */
export type CutAdjustments = Record<number, CutAdjustment>;

/**
 * A user-placed cut that is not owned by a deleted word.
 * Used for blade/trim edits after splitting clips.
 */
export interface ManualCut {
  id: number;
  start: number;
  end: number;
}

/**
 * A structural split point in original media time.
 * Subdivides keep ranges into independently selectable clips (Descript-style scenes).
 */
export interface SceneBoundary {
  id: number;
  time: number;
}

/** Snapshot of all edit state for undo/redo. */
export interface EditSnapshot {
  words: Word[];
  manualCuts: ManualCut[];
  sceneBoundaries: SceneBoundary[];
  cutAdjustments: CutAdjustments;
}

/** A contiguous kept segment of media, optionally subdivided by scene boundaries. */
export interface ClipSegment {
  /** Stable key for React / selection (`start` fixed at creation is not stable after trim). */
  id: string;
  start: number;
  end: number;
  index: number;
}

/** Consecutive words spoken by the same speaker (derived for rendering). */
export interface SpeakerTurn {
  speaker: number;
  words: Word[];
}

export type EditorStatus =
  | "idle" // no video loaded
  | "preparing" // loading ffmpeg / extracting audio
  | "transcribing" // whisper + diarization running
  | "ready" // editable
  | "exporting"
  | "error";

export interface ProgressInfo {
  /** Short human-readable description of the current step. */
  message: string;
  /** 0..1, or null for indeterminate. */
  value: number | null;
}

/** Messages posted from the transcription worker to the main thread. */
export type WorkerResponse =
  | { type: "progress"; message: string; value: number | null }
  | { type: "partial"; text: string }
  | { type: "complete"; words: Word[] }
  | { type: "error"; message: string };

export interface WorkerRequest {
  audio: Float32Array;
  /** Total media duration in seconds (used for progress estimation). */
  duration: number;
  /** Which Whisper model to use (see lib/models.ts). */
  model: import("./models").WhisperModel;
  language?: string;
}
