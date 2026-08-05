"""ONNX export config that makes Whisper decoders emit cross-attentions.

Adapted from transformers.js `scripts/extra/whisper.py` (v3 branch), which is
what produced the `onnx-community/*_timestamped` repos. Kept as a local copy
rather than a dependency because that file lives in a scripts/ directory that is
not published to PyPI, and it moved between branches once already.

The only thing that matters here: `WhisperOnnxConfig.outputs` does not include
attention tensors, so a stock Optimum export produces a decoder whose outputs
are `logits` plus the KV cache. transformers.js derives word timestamps by
running DTW over `cross_attentions.{i}`, so such an export can never do
word-level timing no matter what `alignment_heads` says.
"""

from __future__ import annotations

from typing import Dict

# Optimum 2.x split the ONNX exporters into the separate `optimum-onnx`
# distribution. It re-exports under the original path in most installs, but not
# all, so try both rather than pinning the ecosystem to 1.x forever.
try:
    from optimum.exporters.onnx.base import ConfigBehavior
    from optimum.exporters.onnx.model_configs import WhisperOnnxConfig
except ImportError:  # pragma: no cover - depends on which distribution is installed
    from optimum_onnx.exporters.onnx.base import ConfigBehavior  # type: ignore[import-not-found]
    from optimum_onnx.exporters.onnx.model_configs import (  # type: ignore[import-not-found]
        WhisperOnnxConfig,
    )


class CrossAttentionWhisperOnnxConfig(WhisperOnnxConfig):
    """Whisper ONNX config that additionally exports per-layer cross-attentions."""

    @property
    def outputs(self) -> Dict[str, Dict[int, str]]:
        common_outputs = super().outputs

        # Encoder behaviour has no cross-attention to report; only the decoder
        # (both the plain and with-past variants) gains outputs here.
        if self._behavior is ConfigBehavior.DECODER:
            for i in range(self._config.decoder_layers):
                common_outputs[f"cross_attentions.{i}"] = {
                    0: "batch_size",
                    2: "decoder_sequence_length",
                    3: "encoder_sequence_length_out",
                }
        return common_outputs


def main_export_kwargs(config, task: str = "automatic-speech-recognition") -> dict:
    """Extra kwargs for `optimum.exporters.onnx.main_export`.

    `output_attentions=True` makes the traced forward actually compute the
    tensors; the custom configs declare them as graph outputs. Both are required
    — either alone silently produces the same useless export.
    """
    custom_config = CrossAttentionWhisperOnnxConfig(config=config, task=task)

    custom_onnx_configs = {
        "encoder_model": custom_config.with_behavior("encoder"),
        "decoder_model": custom_config.with_behavior(
            "decoder", use_past=True, use_past_in_inputs=False
        ),
        "decoder_with_past_model": custom_config.with_behavior(
            "decoder", use_past=True, use_past_in_inputs=True
        ),
    }

    return {
        "model_kwargs": {"output_attentions": True},
        "custom_onnx_configs": custom_onnx_configs,
    }
