---
license: other
license_name: nyra-health-non-commercial-research
license_link: https://huggingface.co/nyralabs/CrisperWhisper2.0_small/blob/main/LICENSE.md
base_model: nyralabs/CrisperWhisper2.0_small
base_model_relation: quantized
library_name: transformers.js
pipeline_tag: automatic-speech-recognition
language:
  - en
  - de
tags:
  - onnx
  - transformers.js
  - whisper
  - verbatim
  - disfluency
  - word-timestamps
---

# CrisperWhisper 2.0 Small — ONNX (word timestamps)

ONNX export of [`nyralabs/CrisperWhisper2.0_small`](https://huggingface.co/nyralabs/CrisperWhisper2.0_small)
for [transformers.js](https://github.com/huggingface/transformers.js), exported
**with per-layer cross-attention outputs** so word-level timestamps work in the
browser.

## Why re-export

Every other CrisperWhisper ONNX export is large-v3-scale. Even the "turbo"
export keeps large-v3's 32-layer, 2.5 GB fp32 encoder and only shrinks the
decoder, so the cheapest published option that supports word timestamps is
around 1 GB in 4-bit. This export is ~324 MB (66 MB encoder + 258 MB merged
decoder in q4), which is browser-viable — `CrisperWhisper2.0_small` had no ONNX
export at all before this.

It is exported **with** per-layer cross-attention outputs, which
`return_timestamps: "word"` requires: transformers.js computes word timings by
running DTW over `cross_attentions.{i}`. Note that the `alignment_heads` in
`generation_config.json` are not sufficient on their own — they select which
attention tensors to align over, so they are useless if the decoder does not
emit any. Some published CrisperWhisper exports ship the heads without the
tensors. See `CrossAttentionWhisperOnnxConfig` in the export tooling, adapted
from `transformers.js/scripts/extra/whisper.py`.

If you need a larger, more accurate variant with the same capability,
[`Masterx/CrisperWhisper2.0-turbo-ONNX`](https://huggingface.co/Masterx/CrisperWhisper2.0-turbo-ONNX)
already provides one.

## Usage

Verbatim mode is selected by the **decoder prompt prefix**, not a flag — the
encoder output is identical for both modes:

```
tokenize("[verbatim_1][verbatim_2][verbatim_3][verbatim_4][verbatim_5]")
  + [<|startoftranscript|>, <|LANG|>, <|transcribe|>]
```

Substitute `[intended_N]` for the clean, non-verbatim transcript. Each tag is a
single vocabulary token (51880–51884 verbatim, 51885–51889 intended) absent from
`added_tokens.json`, so the stock tokenizer encodes them without special
handling, and there is **no `<|startofprev|>`** — the tags precede the standard
prefix. Verbatim output spells fillers as `[UH]` / `[UM]`.

The upstream `crisperwhisper` package appends `<|notimestamps|>` to this prefix,
because it computes word timings itself. **Omit it under transformers.js**,
which segments chunked audio on timestamp tokens; suppressing them makes long
transcriptions fail part-way with `token_ids must be a non-empty array of
integers`.

## Licence — non-commercial

The upstream weights are dual-licensed: inference code under MIT, but **model
weights, configuration, tokenizers, and any Outputs the model generates** under
the [nyra health Non-Commercial Research License](https://huggingface.co/nyralabs/CrisperWhisper2.0_small/blob/main/LICENSE.md).

This export is a derivative of those weights and **inherits that licence in
full**. Non-commercial research use only. The restriction extends to transcripts
produced by the model. Commercial use requires a separate licence from nyra
health GmbH.

## Attribution

- Model: CrisperWhisper 2.0 by [nyra health GmbH](https://www.nyra-labs.com/) —
  [paper](https://arxiv.org/abs/2607.18934)
- Export tooling: [`tools/crisperwhisper-onnx`](https://github.com/wassgha/rescript/tree/main/tools/crisperwhisper-onnx)
  in Rescript
- Cross-attention export config adapted from
  [transformers.js](https://github.com/huggingface/transformers.js/blob/v3/scripts/extra/whisper.py) (Apache-2.0)

## Known limitation

CrisperWhisper's published ~30 ms word-boundary accuracy comes from its own
timing method (Viterbi over the explicit space token's cross-attention).
transformers.js instead runs its standard DTW with `alignment_heads` and a median
filter. Word timestamps work; the upstream benchmark figures do not transfer.
