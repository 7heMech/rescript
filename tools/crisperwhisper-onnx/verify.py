"""Verify an export can actually produce word-level timestamps.

This is the check that matters. Every CrisperWhisper ONNX repo on the Hub has a
plausible file listing and `alignment_heads` in its generation config, and none
of them emit cross-attentions — so the only way to tell a usable export from a
useless one is to read the decoder's graph outputs.

Exits non-zero on failure so it can gate `upload.py`.

    python verify.py out/
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

CROSS_ATTENTION_PREFIX = "cross_attentions."


def graph_output_names(model_path: Path) -> list[str]:
    """Output names of an ONNX graph, without touching external weight blobs.

    `load_external_data=False` keeps this cheap and constant-time regardless of
    model size — graph metadata lives in the .onnx file even when the weights sit
    in a sibling .onnx_data of several GB.
    """
    import onnx

    model = onnx.load(str(model_path), load_external_data=False)
    return [output.name for output in model.graph.output]


def check_decoder(model_path: Path, decoder_layers: int) -> bool:
    names = graph_output_names(model_path)
    cross = sorted(
        int(n[len(CROSS_ATTENTION_PREFIX) :])
        for n in names
        if n.startswith(CROSS_ATTENTION_PREFIX)
    )

    print(f"\n  {model_path.name}")
    print(f"    outputs: {len(names)} total")

    if not cross:
        print("    FAIL: no cross_attentions.* outputs")
        print(f"    got: {', '.join(names[:6])}{' …' if len(names) > 6 else ''}")
        print(
            "    → this is the same defect as every published CrisperWhisper export;"
            " word timestamps are impossible"
        )
        return False

    expected = list(range(decoder_layers))
    if cross != expected:
        print(
            f"    FAIL: expected cross_attentions.0 … .{decoder_layers - 1}, "
            f"got indices {cross}"
        )
        return False

    print(f"    OK: cross_attentions.0 … .{cross[-1]} ({len(cross)} layers)")
    return True


def check_alignment_heads(out: Path, decoder_layers: int, decoder_heads: int) -> bool:
    path = out / "generation_config.json"
    if not path.exists():
        print("\n  generation_config.json\n    FAIL: missing")
        return False

    heads = json.loads(path.read_text()).get("alignment_heads")
    print("\n  generation_config.json")
    if not heads:
        print("    FAIL: no alignment_heads — transformers.js cannot select DTW heads")
        return False

    # A head reference outside the model's real shape silently produces garbage
    # timings rather than an error, so bound-check it here.
    bad = [
        pair
        for pair in heads
        if not (0 <= pair[0] < decoder_layers and 0 <= pair[1] < decoder_heads)
    ]
    if bad:
        print(
            f"    FAIL: {len(bad)} head(s) out of range for "
            f"{decoder_layers} layers × {decoder_heads} heads: {bad[:4]}"
        )
        return False

    print(f"    OK: {len(heads)} alignment heads, all within bounds")
    return True


def smoke_test(out: Path, config: dict) -> bool:
    """Load the graphs in onnxruntime and run one decoder step.

    Graph outputs can be declared correctly and still fail at runtime — a
    quantised Whisper decoder previously failed session creation outright with
    "Missing required scale … MatMulNBits" (see the note in Rescript's
    `lib/models.ts`). Only an actual InferenceSession catches that.
    """
    import numpy as np
    import onnxruntime as ort

    onnx_dir = out / "onnx"
    # Prefer the quantised pair — it is what ships, and the variant most likely
    # to fail session creation.
    encoder = next(
        (onnx_dir / f"encoder_model{s}.onnx" for s in ("_q4", "_fp16", "")
         if (onnx_dir / f"encoder_model{s}.onnx").exists()),
        None,
    )
    decoder = next(
        (onnx_dir / f"decoder_model_merged{s}.onnx" for s in ("_q4", "_fp16", "")
         if (onnx_dir / f"decoder_model_merged{s}.onnx").exists()),
        None,
    )
    print("\n  smoke test")
    if encoder is None or decoder is None:
        print("    FAIL: need an encoder_model and a decoder_model_merged")
        return False

    options = ort.SessionOptions()
    options.log_severity_level = 3
    layers = config["decoder_layers"]
    heads = config["decoder_attention_heads"]
    head_dim = config["d_model"] // heads

    try:
        enc = ort.InferenceSession(str(encoder), options, providers=["CPUExecutionProvider"])
        hidden = enc.run(
            None,
            {"input_features": np.zeros((1, config["num_mel_bins"], 3000), dtype=np.float32)},
        )[0]

        dec = ort.InferenceSession(str(decoder), options, providers=["CPUExecutionProvider"])
        names = {i.name for i in dec.get_inputs()}
        feed = {
            "input_ids": np.array([[config["decoder_start_token_id"]]], dtype=np.int64),
            "encoder_hidden_states": hidden,
        }
        if "use_cache_branch" in names:
            feed["use_cache_branch"] = np.array([False])
        for i in range(layers):
            for kind, length in (("decoder", 0), ("encoder", hidden.shape[1])):
                for kv in ("key", "value"):
                    key = f"past_key_values.{i}.{kind}.{kv}"
                    if key in names:
                        feed[key] = np.zeros((1, heads, length, head_dim), dtype=np.float32)

        outputs = dec.run(None, feed)
        by_name = dict(zip((o.name for o in dec.get_outputs()), outputs))
    except Exception as err:  # noqa: BLE001 - the point is to report, not raise
        print(f"    FAIL: {type(err).__name__}: {err}")
        return False

    attention = by_name.get("cross_attentions.0")
    if attention is None:
        print("    FAIL: no cross_attentions.0 at runtime")
        return False

    # (batch, heads, decoder positions, encoder frames) is what DTW consumes.
    if attention.shape[1] != heads or attention.shape[3] != hidden.shape[1]:
        print(f"    FAIL: cross_attentions.0 has unexpected shape {attention.shape}")
        return False

    print(f"    OK: {encoder.name} + {decoder.name} run")
    print(f"        cross_attentions.0 {attention.shape}, logits {by_name['logits'].shape}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, help="export directory produced by export.py")
    parser.add_argument(
        "--no-smoke",
        action="store_true",
        help="skip the onnxruntime load/run check (graph inspection only)",
    )
    args = parser.parse_args()

    out: Path = args.out
    config_path = out / "config.json"
    if not config_path.exists():
        print(f"No config.json in {out} — did export.py finish?")
        return 1

    config = json.loads(config_path.read_text())
    decoder_layers = config["decoder_layers"]
    decoder_heads = config["decoder_attention_heads"]
    print(
        f"Verifying {out} — {decoder_layers} decoder layers, "
        f"{decoder_heads} attention heads"
    )

    decoders = sorted((out / "onnx").glob("decoder*.onnx"))
    if not decoders:
        print(f"\nNo decoder graphs in {out / 'onnx'}")
        return 1

    ok = all(check_decoder(path, decoder_layers) for path in decoders)
    ok &= check_alignment_heads(out, decoder_layers, decoder_heads)

    encoder = out / "onnx" / "encoder_model.onnx"
    print(f"\n  encoder_model.onnx\n    {'OK: present' if encoder.exists() else 'FAIL: missing'}")
    ok &= encoder.exists()

    if not args.no_smoke:
        ok &= smoke_test(out, config)

    print("\n" + ("PASS — export supports word timestamps" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
