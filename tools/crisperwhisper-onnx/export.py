"""Export a CrisperWhisper checkpoint to ONNX with cross-attention outputs.

Writes a transformers.js-compatible layout:

    out/
      onnx/encoder_model.onnx
      onnx/decoder_model_merged.onnx
      config.json, generation_config.json, tokenizer.json, preprocessor_config.json, ...

Run `verify.py` afterwards. Do not trust an export that has not been verified —
every CrisperWhisper ONNX repo on the Hub looks correct by file listing and is
unusable for word timestamps.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

DEFAULT_MODEL = "nyralabs/CrisperWhisper2.0_small"

# CrisperWhisper checkpoints declare a training-time subclass that carries an
# extra attention-loss head. Nothing in it is needed for inference, and Optimum
# resolves the exportable model from `model_type` ("whisper") anyway — but the
# name in `architectures` trips `AutoModel` resolution, so it is rewritten in the
# staging copy. The upstream repo is never modified.
TRAINING_ARCHITECTURE = "WhisperForConditionalGenerationWithAttentionLoss"
INFERENCE_ARCHITECTURE = "WhisperForConditionalGeneration"

# Files transformers.js loads from the repo root (everything that is not weights).
SUPPORT_FILES = (
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "vocab.json",
    "merges.txt",
    "normalizer.json",
)


def stage_checkpoint(model_id: str, staging: Path) -> Path:
    """Download the checkpoint and normalise its config for export."""
    from huggingface_hub import snapshot_download

    print(f"[1/4] Downloading {model_id} …")
    local = Path(
        snapshot_download(
            repo_id=model_id,
            allow_patterns=["*.json", "*.txt", "*.safetensors", "*.model"],
        )
    )

    print(f"[2/4] Staging a normalised copy in {staging} …")
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(local, staging, symlinks=False)

    config_path = staging / "config.json"
    config = json.loads(config_path.read_text())

    architectures = config.get("architectures") or []
    if TRAINING_ARCHITECTURE in architectures:
        config["architectures"] = [INFERENCE_ARCHITECTURE]
        print(f"      architectures: {TRAINING_ARCHITECTURE} → {INFERENCE_ARCHITECTURE}")

    # Weights ship as bf16; ONNX export needs fp32. Clearing the hint stops
    # transformers from loading in bf16 and tracing a bf16 graph.
    for key in ("dtype", "torch_dtype"):
        if config.pop(key, None) is not None:
            print(f"      cleared config.{key} (exporting fp32)")

    config_path.write_text(json.dumps(config, indent=2))
    return staging


def copy_support_files(staging: Path, out: Path) -> None:
    """Carry tokenizer / preprocessor / generation config into the output repo.

    `generation_config.json` matters most: CrisperWhisper ships its own
    `alignment_heads`, and transformers.js needs them to pick which
    cross-attention heads to run DTW over. Optimum writes a generation config of
    its own, so this runs last and wins.
    """
    for name in SUPPORT_FILES:
        src = staging / name
        if src.exists():
            shutil.copy2(src, out / name)

    generation_config = out / "generation_config.json"
    if generation_config.exists():
        config = json.loads(generation_config.read_text())
        heads = config.get("alignment_heads")
        if heads:
            print(f"      alignment_heads preserved ({len(heads)} pairs)")
        else:
            print(
                "      WARNING: no alignment_heads in generation_config.json — "
                "word timestamps will not work even with cross-attentions present"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="HF repo id or local path")
    parser.add_argument("--out", default="out", type=Path, help="output directory")
    parser.add_argument("--opset", type=int, default=None, help="ONNX opset override")
    parser.add_argument(
        "--keep-staging",
        action="store_true",
        help="keep the normalised checkpoint copy for debugging",
    )
    args = parser.parse_args()

    try:
        from optimum.exporters.onnx import main_export
    except ImportError:  # optimum 2.x moved the exporters into `optimum-onnx`
        from optimum_onnx.exporters.onnx import main_export  # type: ignore[import-not-found]
    from transformers import AutoConfig

    from onnx_config import main_export_kwargs

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    staging = out / "_staging"

    source = Path(args.model)
    staged = source if source.is_dir() else stage_checkpoint(args.model, staging)

    config = AutoConfig.from_pretrained(staged)
    print(
        f"      {config.encoder_layers} encoder / {config.decoder_layers} decoder layers, "
        f"d_model={config.d_model} → expecting cross_attentions.0 … .{config.decoder_layers - 1}"
    )

    print("[3/4] Exporting to ONNX (this is the slow part) …")
    main_export(
        model_name_or_path=str(staged),
        output=out,
        task="automatic-speech-recognition-with-past",
        library_name="transformers",
        # Validation compares ONNX outputs against PyTorch, but Optimum does not
        # know how to compare the cross-attention outputs we just added, so it
        # reports spurious mismatches. verify.py checks the graph instead.
        do_validation=False,
        **({"opset": args.opset} if args.opset else {}),
        **main_export_kwargs(config),
    )

    print("[4/4] Arranging transformers.js layout …")
    onnx_dir = out / "onnx"
    onnx_dir.mkdir(exist_ok=True)
    for model_file in sorted(out.glob("*.onnx")):
        shutil.move(str(model_file), onnx_dir / model_file.name)
        print(f"      onnx/{model_file.name}")
    # External weight blobs travel with their graph file.
    for data_file in sorted(out.glob("*.onnx_data")):
        shutil.move(str(data_file), onnx_dir / data_file.name)
        print(f"      onnx/{data_file.name}")

    copy_support_files(staged, out)

    if staging.exists() and not args.keep_staging:
        shutil.rmtree(staging)

    print(f"\nDone → {out}\nNext: python verify.py {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
