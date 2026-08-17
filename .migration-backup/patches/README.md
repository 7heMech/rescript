# Patches

Applied by `patch-package` from `postinstall`. If a patch fails to apply, install
fails loudly rather than silently reverting to the buggy behaviour.

**Patched dependencies are pinned to an exact version in `package.json`, not a
caret range.** A patch filename carries the version it was cut against, and on a
mismatch `patch-package` only *warns* — so a range would let a minor bump quietly
drop the fix. That matters more than usual here: the unpatched failure mode below
is a silently truncated transcript, not an error. When bumping
`@huggingface/transformers`, re-cut the patch (`npx patch-package
@huggingface/transformers`) and re-run the CrisperWhisper models against a clip
containing a filler.

## `@huggingface/transformers` — bound the Whisper timestamp-token range

**Upstream bug.** `WhisperTokenizer` defines the start of the timestamp block as
`token_to_id("<|notimestamps|>") + 1`, and Whisper has exactly 1500 timestamp
tokens above it. `_decode_asr` uses both bounds:

```js
const timestamp_begin = this.timestamp_begin;
const total_timestamp_tokens = 1500;
const timestamp_end = timestamp_begin + total_timestamp_tokens;
```

Two other places test only the lower bound, so **every token above the timestamp
block is mistaken for a timestamp**:

1. `WhisperTokenizer.decodeWithTimestamps` — additionally re-derives the start as
   `all_special_ids.at(-1) + 1` rather than using the getter.
2. `WhisperTimeStampLogitsProcessor._call` — during generation.

For stock Whisper this is harmless: the vocabulary ends at the timestamp block,
so there is nothing above it to misclassify. It breaks any derivative that
extends the vocabulary.

**How it broke Rescript.** CrisperWhisper appends 31 tokens past the block —
`[UM]`, `[UH]`, 13 vocal events (`[laughter]`, `[breath]`, …) and its prompt
scaffolding. Two distinct failures, both triggered by the model transcribing a
filler:

- *Decoding.* `decodeWithTimestamps` split on `[UM]`, leaving an empty token
  bucket that reached `decode([])` — `token_ids must be a non-empty array of
  integers`, thrown from `combineTokensIntoWords` part-way through a transcript.
- *Generation.* The logits processor saw `[UH]` as a timestamp and ran
  `subarray(0, eos_token_id).fill(-Infinity)`, suppressing every text token and
  leaving only EOS. Transcription stopped at the first hesitation; the rest of
  the audio came back as `...` VAD placeholders.

The second one is the quieter of the two — no error, just a silently truncated
transcript. It is why CrisperWhisper appeared to *never* emit fillers through
transformers.js while emitting them readily in PyTorch: asking for word
timestamps suppressed the very tokens the model was chosen for.

**The patch.** Adds `timestamp_end = timestamp_begin + 1500` alongside the
existing lower bound and range-checks against both, matching what `_decode_asr`
already does. Also:

- makes `decodeWithTimestamps` use the `timestamp_begin` getter instead of
  re-deriving it from `all_special_ids`;
- skips empty buckets in its output map (a leading or doubled timestamp produces
  one even on stock Whisper — a latent crash);
- when forcing a timestamp, suppresses text tokens *above* the block too, not
  just below it;
- compares against the max text-token logprob on both sides of the block.

**Upstreaming.** Worth a PR — the fix is small and the tokenizer already computes
the correct bound. Until then this patch is required for the CrisperWhisper
entries in `lib/models.ts` to work at all.
