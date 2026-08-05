"""Install an export into the app's public/models/ so the browser can load it.

Rescript's `crisperSmall` entry is flagged `local`, which makes the worker point
transformers.js at `/models/<id>/` for the duration of that model's load. This
copies the files that entry actually needs into place.

Only the q4 pair is copied by default: the fp32 graphs are 1.1 GB and nothing
references them at runtime, so shipping them into public/ would bloat every
`next build` for no reason.

    python install_local.py                       # from tools/crisperwhisper-onnx
    python install_local.py --dtype fp16 --name my-export
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import verify

# Must match MODELS.crisperSmall.id in lib/models.ts.
DEFAULT_NAME = "crisperwhisper-2.0-small-onnx"

# Everything transformers.js reads from the repo root. Missing optional entries
# are skipped; a missing required one is a hard error, because the failure would
# otherwise surface as an opaque tokenizer crash in the worker.
REQUIRED_FILES = ("config.json", "generation_config.json", "preprocessor_config.json")
OPTIONAL_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "vocab.json",
    "merges.txt",
    "normalizer.json",
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("out"), help="export directory")
    parser.add_argument("--name", default=DEFAULT_NAME, help="folder name under public/models")
    parser.add_argument(
        "--dtype",
        default="q4",
        help="graph suffix to install (q4, fp16, int8, or 'fp32' for unsuffixed)",
    )
    parser.add_argument("--skip-verify", action="store_true", help="install without verifying")
    args = parser.parse_args()

    out: Path = args.out
    if not (out / "config.json").exists():
        print(f"No export in {out} — run export.py first")
        return 1

    # Installing an export whose decoder has no cross-attentions would produce a
    # model that loads fine and silently returns no word timings.
    if not args.skip_verify:
        argv = sys.argv
        sys.argv = ["verify.py", str(out), "--no-smoke"]
        try:
            if verify.main() != 0:
                print("\nRefusing to install: verification failed.")
                return 1
        finally:
            sys.argv = argv
        print()

    suffix = "" if args.dtype == "fp32" else f"_{args.dtype}"
    graphs = [f"encoder_model{suffix}.onnx", f"decoder_model_merged{suffix}.onnx"]
    missing = [g for g in graphs if not (out / "onnx" / g).exists()]
    if missing:
        print(f"Missing graph(s) for --dtype {args.dtype}: {', '.join(missing)}")
        print("Run quantize.py, or pick a dtype that exists.")
        return 1

    dest = repo_root() / "public" / "models" / args.name
    if dest.exists():
        shutil.rmtree(dest)
    (dest / "onnx").mkdir(parents=True)

    total = 0
    for name in REQUIRED_FILES:
        src = out / name
        if not src.exists():
            print(f"Missing required file: {name}")
            return 1
        shutil.copy2(src, dest / name)
    for name in OPTIONAL_FILES:
        src = out / name
        if src.exists():
            shutil.copy2(src, dest / name)
    for name in graphs:
        src = out / "onnx" / name
        shutil.copy2(src, dest / "onnx" / name)
        size = src.stat().st_size
        total += size
        print(f"  onnx/{name}  {size / 1e6:.1f} MB")

    rel = dest.relative_to(repo_root())
    print(f"\nInstalled {total / 1e6:.0f} MB → {rel}")
    print(
        "Served at /models/"
        f"{args.name}/ — select \"CrisperWhisper Small (local)\" in the model menu."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
