/**
 * True for ONNX Runtime / WebGPU failures caused by a lost GPU device
 * (Windows screen lock, driver reset, Chromium GPU process teardown, …).
 */
export function isWebGpuDeviceLostError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("failed to download data from buffer") ||
    msg.includes("external instance reference no longer exists") ||
    msg.includes("buffer was destroyed before") ||
    msg.includes("buffer was unmapped before mapping was resolved") ||
    msg.includes("device was lost") ||
    msg.includes("webgpu device lost") ||
    msg.includes("gpudevice lost") ||
    (msg.includes("buffer_manager.cc") && msg.includes("download")) ||
    (msg.includes("mapasync") && msg.includes("gpubuffer"))
  );
}
