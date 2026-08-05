# CrisperWhisper → ONNX (with cross-attentions)

Exports [CrisperWhisper 2.0](https://huggingface.co/nyralabs) to ONNX in a
transformers.js-compatible layout, **including the cross-attention outputs that
word-level timestamps need**, so the Rescript editor can use it as a verbatim
speech model.

## Why this exists

Rescript needs two things from a speech model that no published CrisperWhisper
ONNX export provides together:

1. **Verbatim output** — `um` / `uh` / stutters transcribed, not silently
   dropped. Whisper omits them (its training data is cleaned subtitles) and
   Parakeet TDT omits them too (Granary is pseudo-labelled and filtered).
   `lib/models.ts` works around this with a short filler-bias prompt, which is
   capped at 32 characters because longer prompts truncate long-form output.
2. **Word-level timestamps** — the editor's entire model is cutting video by
   selecting words, so per-word `start`/`end` is non-negotiable.

Two published exports satisfy (2); none satisfies it at a size this app can
afford. Verified by loading each decoder graph and reading its outputs —
`onnx.load(..., load_external_data=False)`, which is cheap regardless of weight
size, and is what `verify.py` automates:

| Export | `cross_attentions.*` outputs | smallest q4 pair |
| --- | --- | ---: |
| `Masterx/CrisperWhisper2.0-turbo-ONNX` | **`.0` … `.3`** (4 layers) | ~1025 MB |
| `Masterx/CrisperWhisper2.0-large-ONNX` | **`.0` … `.31`** (32 layers) | ~1487 MB |
| `onnx-community/CrisperWhisper-ONNX` | none (0 of 129 outputs) | — |
| `Prince-1/CrisperWhisper` | none (0 of 65 outputs) | — |
| *this export* (`CrisperWhisper2.0_small`) | **`.0` … `.11`** (12 layers) | **324 MB** |
| `onnx-community/whisper-base_timestamped` *(Rescript today)* | `.0` … `.5` | ~200 MB |

**The gap this folder fills is size, not capability.** Every published
CrisperWhisper ONNX is large-v3-scale — even "turbo" keeps large-v3's 32-layer,
2.5 GB fp32 encoder and only shrinks the decoder — which puts the cheapest
working option at ~1 GB. Rescript is currently having Safari tabs killed for
memory while loading a 200 MB model, so 1 GB is not viable there.
`CrisperWhisper2.0_small` had no ONNX export at all before this one.

If you can afford ~1 GB, **`Masterx/CrisperWhisper2.0-turbo-ONNX` works off the
shelf**, is a stronger model than small, and its card documents the same
verbatim prompt prefix. Try it before spending anything on integration — it
answers "is CrisperWhisper's verbatim output good enough to justify the licence
question?" at zero cost.

One trap worth naming: `alignment_heads` in `generation_config.json` proves
nothing. All five exports above ship it, including the two that cannot use it.
The heads select *which* cross-attention tensors to run DTW over; with no such
tensors emitted there is nothing to select. Check graph outputs, not config.

## What this exports instead

`nyralabs/CrisperWhisper2.0_small` — 484 MB of bf16 safetensors, plain
whisper-small geometry (12 encoder / 12 decoder layers, `d_model` 768). Quantised
to q4 it should land in the 150–250 MB range, comparable to the Whisper Base
export Rescript ships today.

The export path is the same one that produced `onnx-community/*_timestamped`:
a `WhisperOnnxConfig` subclass that appends `cross_attentions.{i}` to the decoder
outputs, combined with `model_kwargs={"output_attentions": True}`. See
`onnx_config.py`, which is adapted from
[`transformers.js/scripts/extra/whisper.py`](https://github.com/huggingface/transformers.js/blob/v3/scripts/extra/whisper.py).

## ⚠️ Licensing — read before publishing

The CrisperWhisper 2.0 weights are **not** open source. `LICENSE.md` in the
upstream repos splits into two parts:

- **Part A** — inference code, pre/post-processing, scripts: MIT.
- **Part B** — *model weights, checkpoints, configuration, tokenizers, **and any
  Outputs the model generates***: nyra health Non-Commercial Research License.
  Commercial use requires a separate licence from nyra health GmbH.

CrisperWhisper v1 (`nyralabs/CrisperWhisper`) is CC-BY-NC-4.0. Both are
non-commercial.

Consequences that matter here:

- An ONNX export is a **derivative of the weights**, so it inherits Part B. It
  cannot be relicensed under Rescript's own licence.
- The "and any Outputs" clause reaches the *transcripts users generate*, not just
  the weights we redistribute.
- Anything published from this folder must carry the upstream licence and
  attribution. `MODEL_CARD.md` is pre-filled to do that; do not strip it.

Rescript ships signed desktop builds, so whether this model can be offered in the
product at all is a licensing decision, not a technical one. **This folder
deliberately stops at "produces a working export" and does not wire the model
into the app.**

## Requirements

Python **3.11+** — `onnxruntime` requires 3.11 and `onnx` requires 3.10, so the
`python3` that ships with macOS (3.9.6) will not work. Install a newer
interpreter first, e.g. `brew install python@3.11`.

```sh
cd tools/crisperwhisper-onnx
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` pins `optimum` to the 1.x line, where
`optimum.exporters.onnx` still lives in the main package and the
`WhisperOnnxConfig` API matches what `onnx_config.py` subclasses. Optimum 2.x
moved the exporters into a separate `optimum-onnx` distribution; both scripts
fall back to that import path, so upgrading is possible, but the 1.x pin is the
combination this was written against.

## Usage

```sh
# 1. Export encoder + decoder(+merged) to ONNX with cross-attentions.
#    Downloads ~500 MB of weights, writes ~1.5 GB of fp32 ONNX.
python export.py --model nyralabs/CrisperWhisper2.0_small --out out/

# 2. Prove the export is actually usable for word timestamps.
#    This is the check every published export fails — run it before anything else.
python verify.py out/

# 3. Quantise for the browser (q4 / int8 / fp16).
python quantize.py out/

# 4. Publish (requires `huggingface-cli login` and a licence decision).
python upload.py out/ --repo <your-org>/CrisperWhisper2.0_small-ONNX-timestamped
```

## Results (verified 2026-08-04)

Exported from `nyralabs/CrisperWhisper2.0_small` on macOS arm64, Python 3.11.15.

| Graph | fp32 | fp16 | int8 | q4 |
| --- | ---: | ---: | ---: | ---: |
| `encoder_model` | 352.8 MB | 176.5 MB | 92.7 MB | **66.1 MB** |
| `decoder_model_merged` | 774.6 MB | 388.0 MB | — *(see below)* | **257.9 MB** |

The q4 pair is **324 MB** — comparable to the ~200 MB Whisper Base export
Rescript ships today, and against ~980 MB for the smallest published
CrisperWhisper ONNX.

`verify.py` passes, including a live onnxruntime run of the q4 pair:
`cross_attentions.0` comes back `(1, 12, 1, 1500)` — batch × heads × decoder
positions × encoder frames, which is what DTW consumes — and `logits`
`(1, 1, 51896)` confirms the extended CrisperWhisper vocabulary survived.

### Gotchas hit along the way

Each of these is pinned or handled in code; they are recorded so a future
version bump does not rediscover them.

- **`torch<2.6`.** Optimum 1.x's `exporters/onnx/model_patcher.py` imports
  `_attention_scale` from `torch.onnx.symbolic_opset14`, which torch removed with
  the rest of the legacy TorchScript exporter. Newer torch makes importing the
  exporter fail outright.
- **`onnx-ir` is an undeclared dependency.** onnxruntime ≥1.28's
  `matmul_nbits_quantizer` imports it without declaring it, so q4 fails with
  `ModuleNotFoundError`. Also note the module and class were renamed from
  `matmul_4bits_quantizer` / `MatMul4BitsQuantizer` in 1.28.
- **int8 cannot quantise the merged decoder.** Optimum emits
  `decoder_model_merged` as one top-level `If` node with all 3889 nodes (314
  MatMuls) inside its branches. `quantize_dynamic` only walks the top level,
  finds nothing, and writes a file the same size as its input under an `_int8`
  name. `quantize.py` now detects this and skips rather than emitting a
  mislabelled file.

  This is not a local quirk — `onnx-community/whisper-medium_timestamped` ships
  `decoder_model_merged_int8.onnx` and `_uint8.onnx` at 1828 MB, byte-for-byte
  the size of its fp32, while `_q4` is 469 MB. Use q4 or fp16 for merged
  decoders. It is also the likely root of the note in `lib/models.ts:86-87`
  about q8 decoders failing.
- **`encoder_blank_head.{weight,bias}` are dropped on load.** That is
  CrisperWhisper's training-time attention-loss head; it plays no part in
  inference, and the warning from `WhisperForConditionalGeneration` is expected.

## Driving it from transformers.js

Verbatim mode is **not** a flag — CrisperWhisper 2.0 selects it via the decoder
prompt prefix, and the encoder output is identical either way. From
`crisperwhisper/prompt.py` (PyPI `crisperwhisper==2.0.1`), the sequence is:

```
# upstream (crisperwhisper/prompt.py)
tokenize("[verbatim_1][verbatim_2][verbatim_3][verbatim_4][verbatim_5]")
  + [<|startoftranscript|>, <|LANG|>, <|transcribe|>, <|notimestamps|>]

# what to send through transformers.js — same, minus <|notimestamps|>
tokenize("[verbatim_1]…[verbatim_5]")
  + [<|startoftranscript|>, <|LANG|>, <|transcribe|>]
```

`[intended_N]` in place of `[verbatim_N]` gives the clean transcript instead.
Notes:

- Each mode tag is a **single token already in the vocabulary** — 51880–51884
  for `[verbatim_1…5]` and 51885–51889 for `[intended_1…5]` in the small
  checkpoint. They are absent from `added_tokens.json`, so they need no special
  handling; the stock tokenizer encodes the five-tag string to exactly five ids.
  The full English verbatim prefix for this checkpoint is
  `[51880, 51881, 51882, 51883, 51884, 50258, 50259, 50359, 50363]`.
- Do not hardcode the trailing four. The turbo export uses different ids for
  `<|transcribe|>` (50360) and `<|notimestamps|>` (50364) because it carries an
  extra language; read them from `generation_config.json`.
- Unlike vanilla Whisper prompting there is **no `<|startofprev|>`**; the tags
  come first and the standard prefix follows.
- `<|notimestamps|>` is part of the *upstream* prefix, but **omit it under
  transformers.js**. Upstream suppresses timestamp tokens because it derives
  word timings itself, via Viterbi over the space token's cross-attention.
  transformers.js instead splits chunked audio on timestamp tokens inside
  `_decode_asr`; with them suppressed, a long transcript never segments, and the
  stride-overlap merge can resolve to an empty token list. That surfaces
  part-way through a transcription as `token_ids must be a non-empty array of
  integers`. Mode selection and timestamps are orthogonal, so dropping it does
  not affect verbatim output.
- The `<vtx>`/`<htx>`/`<ctx>` tokens in `added_tokens.json` are for verbatimize,
  hotwords and long-form continuation context respectively — *not* mode control.
- Verbatim output spells fillers as bracketed uppercase (`[UH]`, `[UM]`), so
  `lib/hallucinations.ts` and the "Remove fillers" matcher would need to
  recognise that form.

Rescript already builds custom `decoder_input_ids` for its Whisper filler prompt,
so the same mechanism applies — see the `decoder_input_ids` construction in
`workers/transcription.worker.ts`.

## Caveat on timing quality

CrisperWhisper's headline ~30 ms boundary accuracy comes from its own timing
method — Viterbi over the explicit space token's cross-attention, per the
upstream docs. transformers.js will instead run its standard DTW with
`alignment_heads` and a median filter. That still yields word timestamps, but do
not expect the upstream benchmark numbers through this path.
