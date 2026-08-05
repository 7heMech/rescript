"""Publish a verified export to the Hugging Face Hub.

Refuses to upload unless `verify.py` passes. An export that looks right but has
no cross-attention outputs is exactly what is already on the Hub several times
over; adding another is worse than publishing nothing.

    huggingface-cli login
    python upload.py out/ --repo <org>/CrisperWhisper2.0_small-ONNX-timestamped
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import verify

CARD_TEMPLATE = Path(__file__).with_name("MODEL_CARD.md")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, help="export directory produced by export.py")
    parser.add_argument("--repo", required=True, help="target repo id, e.g. org/name")
    parser.add_argument("--private", action="store_true", help="create as private")
    parser.add_argument(
        "--message", default="Add ONNX export with cross-attentions", help="commit message"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="verify and stage the card, but do not push"
    )
    args = parser.parse_args()

    out: Path = args.out

    print("Verifying before upload …")
    if _verify(out) != 0:
        print("\nRefusing to upload: verification failed.")
        return 1

    # The licence notice is not optional — the upstream terms cover the weights
    # and their outputs, and this export is a derivative.
    card = out / "README.md"
    if not card.exists():
        shutil.copy2(CARD_TEMPLATE, card)
        print(f"Staged model card → {card}")
    else:
        print(f"Keeping existing {card}")

    if args.dry_run:
        print("\n--dry-run: nothing pushed.")
        return 0

    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo(args.repo, private=args.private, exist_ok=True, repo_type="model")
    print(f"\nUploading {out} → {args.repo} …")
    api.upload_folder(
        folder_path=str(out),
        repo_id=args.repo,
        repo_type="model",
        commit_message=args.message,
        # Staging leftovers and virtualenvs must never reach the Hub.
        ignore_patterns=["_staging/*", ".venv/*", "**/__pycache__/*"],
    )
    print(f"Done → https://huggingface.co/{args.repo}")
    return 0


def _verify(out: Path) -> int:
    """Run verify.py's checks in-process; returns 0 on success."""
    import sys

    argv = sys.argv
    sys.argv = ["verify.py", str(out)]
    try:
        return verify.main()
    finally:
        sys.argv = argv


if __name__ == "__main__":
    raise SystemExit(main())
