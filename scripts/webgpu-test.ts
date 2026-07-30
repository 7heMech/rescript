import { isWebGpuDeviceLostError } from "../lib/webgpu";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

{
  const issue39 = new Error(
    "failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /mnt/vss/_work/1/s/onnxruntime/core/providers/webgpu/buffer_manager.cc:553 auto onnxruntime::webgpu::BufferManager::Download(WGPUBuffer, void *, size_t)::(lambda)::operator()(wgpu::MapAsyncStatus, wgpu::StringView) const status == wgpu::MapAsyncStatus::Success was false. Failed to download data from buffer: Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists."
  );
  assert(isWebGpuDeviceLostError(issue39), "issue #39 OrtRun buffer download should match");
}

{
  assert(
    isWebGpuDeviceLostError("WebGPU device lost (2): Device was destroyed."),
    "transformers.js device-destroyed message should match"
  );
  assert(
    isWebGpuDeviceLostError(
      new Error("Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved.")
    ),
    "unmapped buffer race should match"
  );
}

{
  assert(!isWebGpuDeviceLostError(new Error("Could not extract audio from this file.")), "audio error");
  assert(!isWebGpuDeviceLostError("out of memory"), "generic oom should not match");
  assert(!isWebGpuDeviceLostError(null), "null");
  assert(!isWebGpuDeviceLostError(""), "empty");
}

console.log("webgpu-test: ok");
