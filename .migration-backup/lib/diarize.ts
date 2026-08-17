/**
 * Windowing and speaker stitching for pyannote segmentation.
 *
 * pyannote-segmentation-3.0 is a *local* model: it was trained on 10 s windows
 * and emits a powerset class per frame, where the mapping from class index to
 * a person is arbitrary and only stable within one forward pass. Running it
 * over a whole recording in one pass — which is what the worker used to do —
 * is therefore not only unnecessary, it is the single largest allocation in
 * the app:
 *
 * - the feature extractor builds one `[1, 1, num_samples]` tensor (230 MB of
 *   float32 for an hour at 16 kHz),
 * - the SincNet frontend convolves that into activations several times larger
 *   again inside the onnxruntime heap,
 * - and `post_process_speaker_diarization` calls `logits.tolist()`, turning
 *   ~213k frames into as many small JS arrays before softmaxing each one.
 *
 * Chromium usually throws somewhere in there and the worker falls back to a
 * single speaker; WebKit kills the tab instead ("This webpage was reloaded
 * because it was using significant memory"). Either way nobody gets speakers
 * on a long file today.
 *
 * So the audio is windowed. Each window costs a bounded, small amount of
 * memory, and the cost of windowing is that class 2 in one window is not class
 * 2 in the next. Consecutive windows therefore overlap, and the overlap is used
 * to match this window's classes onto the ones already emitted — the classic
 * permutation-matching stitch. Everything here is pure and takes plain segment
 * lists, so it is tested without loading a model.
 */

/** One contiguous run of a single pyannote powerset class. */
export interface DiarizationSegment {
  /** Powerset class index. 0 is "no speaker"; higher indices are speakers. */
  id: number;
  start: number;
  end: number;
  confidence: number;
}

/** One window's raw result, with times relative to the window start. */
export interface DiarizationWindow {
  /** Media-time offset of this window's first sample. */
  offsetS: number;
  /** Length of the audio actually fed to the model. */
  durationS: number;
  segments: DiarizationSegment[];
}

export interface WindowSpan {
  startSample: number;
  endSample: number;
}

/**
 * Window length in seconds.
 *
 * Well above the model's 10 s training window (longer context segments more
 * consistently) but short enough that one forward pass stays small: 30 s is
 * 480k samples, ~2 MB of input against 230 MB for an hour.
 */
export const DIARIZE_WINDOW_S = 30;

/**
 * Overlap between consecutive windows, in seconds.
 *
 * This is the only evidence available for matching one window's classes onto
 * the previous window's, so it has to be long enough to contain speech from
 * the speakers who span the boundary. Five seconds covers a normal
 * conversational turn without adding much recomputation (a sixth of each
 * window is decoded twice).
 */
export const DIARIZE_OVERLAP_S = 5;

/**
 * Ignore a candidate match supported by less than this many seconds of shared
 * activity. Below it the "match" is usually a stray frame or two, and inventing
 * a new speaker is the better failure: a wrong merge silently attributes one
 * person's words to another, whereas a spurious extra speaker is visible and
 * fixable from the transcript's speaker labels.
 */
const MIN_MATCH_S = 0.25;

/**
 * Split `totalSamples` into overlapping windows.
 *
 * The final window is snapped back so it ends exactly at the audio end rather
 * than being short — a runt window carries too little context for the model to
 * segment well, and stitching it is exactly where a short window fails.
 */
export function diarizationWindows(
  totalSamples: number,
  sampleRate: number,
  { windowS = DIARIZE_WINDOW_S, overlapS = DIARIZE_OVERLAP_S } = {}
): WindowSpan[] {
  if (totalSamples <= 0) return [];
  const windowSamples = Math.max(1, Math.round(windowS * sampleRate));
  const overlapSamples = Math.max(0, Math.round(overlapS * sampleRate));
  if (totalSamples <= windowSamples) {
    return [{ startSample: 0, endSample: totalSamples }];
  }

  const step = Math.max(1, windowSamples - overlapSamples);
  const spans: WindowSpan[] = [];
  for (let start = 0; start < totalSamples; start += step) {
    const end = Math.min(totalSamples, start + windowSamples);
    // Snap the tail window back so it is full length instead of a runt.
    const snappedStart = end === totalSamples ? Math.max(0, end - windowSamples) : start;
    spans.push({ startSample: snappedStart, endSample: end });
    if (end === totalSamples) break;
  }
  return spans;
}

type Interval = [number, number];

/** Total length of the intersection of two interval lists. */
function overlapDuration(a: Interval[], b: Interval[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) total += hi - lo;
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return total;
}

/** Intervals of `segments` belonging to `id`, clipped to [lo, hi]. */
function intervalsFor(
  segments: DiarizationSegment[],
  id: number,
  lo: number,
  hi: number
): Interval[] {
  const out: Interval[] = [];
  for (const s of segments) {
    if (s.id !== id) continue;
    const start = Math.max(s.start, lo);
    const end = Math.min(s.end, hi);
    if (end > start) out.push([start, end]);
  }
  return out;
}

/**
 * Stitch per-window results into one timeline with globally consistent ids.
 *
 * Each window's classes are matched onto the already-emitted ones by how much
 * activity they share in the region the two windows have in common, greedily,
 * best pair first. A class with no good match becomes a new speaker. Windows
 * contribute segments only from the midpoint of their overlap with the previous
 * window, so every instant is described exactly once, by whichever window has
 * more context around it.
 */
export function stitchDiarizationWindows(
  windows: DiarizationWindow[]
): DiarizationSegment[] {
  const emitted: DiarizationSegment[] = [];
  let nextGlobalId = 1;
  let prevWindowEnd = -Infinity;

  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    const winStart = w.offsetS;
    const winEnd = w.offsetS + w.durationS;

    // Absolute-time, speaker-only segments for this window.
    const local = w.segments
      .filter((s) => s.id !== 0 && s.end > s.start)
      .map((s) => ({
        ...s,
        start: s.start + winStart,
        end: Math.min(s.end + winStart, winEnd),
      }))
      .filter((s) => s.end > s.start);

    // Region shared with the previous window: the only place the two agree
    // about what happened, and so the only usable matching evidence.
    const shareLo = winStart;
    const shareHi = Math.min(prevWindowEnd, winEnd);
    const hasShared = k > 0 && shareHi > shareLo;
    // Emit from the middle of the shared region, so each side contributes the
    // half it saw with more surrounding context.
    const emitFrom = hasShared ? (shareLo + shareHi) / 2 : winStart;

    const localIds = [...new Set(local.map((s) => s.id))];
    const mapping = new Map<number, number>();

    if (hasShared) {
      const globalIds = [...new Set(emitted.map((s) => s.id))];
      const localIntervals = new Map(
        localIds.map((id) => [id, intervalsFor(local, id, shareLo, shareHi)])
      );
      const globalIntervals = new Map(
        globalIds.map((id) => [id, intervalsFor(emitted, id, shareLo, shareHi)])
      );

      const candidates: Array<{ local: number; global: number; score: number }> = [];
      for (const localId of localIds) {
        for (const globalId of globalIds) {
          const score = overlapDuration(
            localIntervals.get(localId)!,
            globalIntervals.get(globalId)!
          );
          if (score >= MIN_MATCH_S) candidates.push({ local: localId, global: globalId, score });
        }
      }
      // Greedy best-first. With at most a handful of classes per window this is
      // equivalent to an optimal assignment in every realistic case, without
      // the machinery.
      candidates.sort((a, b) => b.score - a.score);
      const takenGlobal = new Set<number>();
      for (const c of candidates) {
        if (mapping.has(c.local) || takenGlobal.has(c.global)) continue;
        mapping.set(c.local, c.global);
        takenGlobal.add(c.global);
      }
    }

    for (const id of localIds) {
      if (!mapping.has(id)) mapping.set(id, nextGlobalId++);
    }

    for (const s of local) {
      const start = Math.max(s.start, emitFrom);
      if (s.end <= start) continue;
      emitted.push({ ...s, id: mapping.get(s.id)!, start, end: s.end });
    }
    prevWindowEnd = winEnd;
  }

  emitted.sort((a, b) => a.start - b.start || a.end - b.end);
  return mergeAdjacent(emitted);
}

/**
 * Join runs of the same speaker split only by a window boundary. Confidence is
 * averaged by duration so a merged run reports the confidence of the whole span
 * rather than of whichever piece happened to come last.
 */
function mergeAdjacent(segments: DiarizationSegment[]): DiarizationSegment[] {
  const out: DiarizationSegment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.id === s.id && s.start - prev.end <= 1e-6) {
      const prevLen = prev.end - prev.start;
      const thisLen = s.end - s.start;
      const total = prevLen + thisLen;
      prev.confidence =
        total > 0
          ? (prev.confidence * prevLen + s.confidence * thisLen) / total
          : prev.confidence;
      prev.end = Math.max(prev.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
