"""Quantise an exported CrisperWhisper for the browser.

Produces the dtype-suffixed variants transformers.js resolves from a `dtype`
config — `_fp16`, `_int8`, `_q4` — alongside the fp32 originals.

Rescript's `lib/models.ts` picks encoder and decoder dtypes independently, and
that split matters: Whisper's encoder degrades under aggressive quantisation
(which is why Base and Small pin `encoder_model: "fp32"`), while the merged
decoder tolerates q4. Emitting every variant here keeps that choice open at
integration time instead of baking it in.

    python quantize.py out/ --modes fp16 int8 q4
"""

from __future__ import annotations

import argparse
from pathlib import Path

# transformers.js dtype → filename suffix (mirrors its DEFAULT_DTYPE_SUFFIX_MAP).
SUFFIXES = {"fp16": "_fp16", "int8": "_int8", "q4": "_q4"}


class SkipVariant(Exception):
    """Raised when a (graph, mode) pair cannot produce a genuinely smaller model."""


def _weights_are_in_subgraphs(src: Path) -> bool:
    """True when the graph's MatMuls live inside control-flow subgraphs.

    Optimum emits `decoder_model_merged` as a single top-level `If` node — the
    with-past and without-past branches — so every MatMul sits one level down.
    `quantize_dynamic` only walks the top-level graph, finds nothing, and writes
    a file the same size as its input under an `_int8` name.

    This is not hypothetical: `onnx-community/whisper-medium_timestamped` ships
    `decoder_model_merged_int8.onnx` and `_uint8.onnx` at exactly the fp32 size
    of 1828 MB, while its `_q4` is 469 MB. Refusing to write the file is better
    than shipping a mislabelled one.
    """
    import onnx

    model = onnx.load(str(src), load_external_data=False)
    nodes = model.graph.node
    top_level_matmuls = sum(1 for n in nodes if n.op_type in ("MatMul", "Gemm"))
    if top_level_matmuls:
        return False
    return any(n.op_type in ("If", "Loop", "Scan") for n in nodes)


def quantize_int8(src: Path, dst: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    if _weights_are_in_subgraphs(src):
        raise SkipVariant(
            "weights live inside control-flow subgraphs, which quantize_dynamic "
            "cannot reach — use q4 (MatMulNBits descends into subgraphs) or fp16"
        )

    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QInt8,
        # Conv/attention kernels in Whisper are the accuracy-sensitive part;
        # per-channel weights cost nothing at runtime and lose noticeably less.
        per_channel=True,
        reduce_range=False,
    )


def quantize_fp16(src: Path, dst: Path) -> None:
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(str(src))
    converted = float16.convert_float_to_float16(
        model,
        keep_io_types=True,
        disable_shape_infer=False,
    )
    onnx.save(converted, str(dst), save_as_external_data=False)


def quantize_q4(src: Path, dst: Path) -> None:
    import onnx

    # Renamed in onnxruntime 1.28 (matmul_4bits_quantizer/MatMul4BitsQuantizer →
    # matmul_nbits_quantizer/MatMulNBitsQuantizer). Try the current name first.
    try:
        from onnxruntime.quantization.matmul_nbits_quantizer import (
            MatMulNBitsQuantizer as Quantizer,
        )
    except ImportError:  # onnxruntime < 1.28
        from onnxruntime.quantization.matmul_4bits_quantizer import (  # type: ignore[import-not-found]
            MatMul4BitsQuantizer as Quantizer,
        )

    model = onnx.load(str(src))
    quantizer = Quantizer(model, block_size=32, is_symmetric=True)
    quantizer.process()
    onnx.save(quantizer.model.model, str(dst), save_as_external_data=False)


MODES = {"int8": quantize_int8, "fp16": quantize_fp16, "q4": quantize_q4}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, help="export directory produced by export.py")
    parser.add_argument(
        "--modes",
        nargs="+",
        default=["fp16", "int8", "q4"],
        choices=sorted(MODES),
    )
    parser.add_argument(
        "--include",
        nargs="+",
        # transformers.js loads the merged decoder; the split decoder_model /
        # decoder_with_past_model pair is redundant for it and each is ~750 MB,
        # so quantising them by default triples the work for nothing.
        default=["encoder_model", "decoder_model_merged"],
        help="graph stems to quantise ('all' for every graph)",
    )
    args = parser.parse_args()

    onnx_dir: Path = args.out / "onnx"
    if not onnx_dir.is_dir():
        print(f"No onnx/ directory in {args.out} — run export.py first")
        return 1

    # Only the fp32 originals; never quantise an already-quantised file.
    sources = [
        path
        for path in sorted(onnx_dir.glob("*.onnx"))
        if not any(path.stem.endswith(s) for s in SUFFIXES.values())
        and ("all" in args.include or path.stem in args.include)
    ]
    if not sources:
        print(f"No source graphs in {onnx_dir}")
        return 1

    failures = 0
    for mode in args.modes:
        for src in sources:
            dst = src.with_name(f"{src.stem}{SUFFIXES[mode]}.onnx")
            print(f"{mode:>5}  {src.name} → {dst.name}", flush=True)
            try:
                MODES[mode](src, dst)
            except SkipVariant as reason:
                print(f"       skipped: {reason}")
                continue
            except Exception as err:  # noqa: BLE001 - report and continue
                failures += 1
                print(f"       FAILED: {type(err).__name__}: {err}")
                continue

            before = src.stat().st_size
            after = dst.stat().st_size
            print(f"       {after / 1e6:.1f} MB ({after / before:.0%} of fp32)")
            # A "quantised" file the size of its input is the failure mode that
            # put un-quantised int8 decoders on the Hub. Do not ship one.
            if after > before * 0.95:
                failures += 1
                print("       FAILED: no meaningful size reduction — removing")
                dst.unlink()

    if failures:
        print(f"\n{failures} variant(s) failed — the rest are usable")
    print(f"\nRe-run verification: python verify.py {args.out}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
