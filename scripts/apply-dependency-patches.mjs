import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function packageDir(name) {
  const candidates = [
    join(process.cwd(), "node_modules", name),
    join(root, "node_modules", name),
    join(root, "node_modules", ".bun", "node_modules", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(
    `[patches] Cannot resolve installed package ${name} from ${process.cwd()} or ${root}.`,
  );
}

function updateFile({ name, target, marker, transform }) {
  const dir = packageDir(name);
  const targetPath = join(dir, target);
  if (!existsSync(targetPath)) {
    throw new Error(`[patches] ${name} is missing ${target}.`);
  }
  const original = readFileSync(targetPath, "utf8");
  if (original.includes(marker)) return;

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const normalized = original.replaceAll("\r\n", "\n");
  const updated = transform(normalized);
  if (updated === normalized) {
    throw new Error(`[patches] Could not find the expected patch point in ${name}/${target}.`);
  }
  writeFileSync(targetPath, updated.replaceAll("\n", newline));
}

updateFile({
  name: "@huggingface/transformers",
  target: "dist/transformers.js",
  marker: 's.length === 0 ? "" : super.decode',
  transform(source) {
    return source
      .replace(
        "const timestamp_begin = this.all_special_ids.at(-1) + 1;",
        "const timestamp_begin = this.timestamp_begin;\n    const timestamp_end = timestamp_begin + 1500;",
      )
      .replace(
        "if (token >= timestamp_begin) {",
        "if (token >= timestamp_begin && token <= timestamp_end) {",
      )
      .replace(
        'outputs = outputs.map((s) => typeof s === "string" ? s : super.decode(s, decode_args));',
        'outputs = outputs.map((s) => typeof s === "string" ? s : s.length === 0 ? "" : super.decode(s, decode_args));',
      )
      .replace(
        "this.timestamp_begin = this.no_timestamps_token_id + 1;\n    this.begin_index = init_tokens.length;",
        "this.timestamp_begin = this.no_timestamps_token_id + 1;\n    this.timestamp_end = this.timestamp_begin + 1500;\n    this.begin_index = init_tokens.length;",
      );
  },
});
updateFile({
  name: "parakeet.js",
  target: "src/backend.js",
  marker: "rescript-wasmPaths-patch",
  transform(source) {
    return source.replace(
      "  // Set up WASM paths first (needed for all backends)\n  if (!ort.env.wasm.wasmPaths) {",
      "  // Set up WASM paths first (needed for all backends)\n  /* rescript-wasmPaths-patch */\n  if (wasmPaths) {\n    ort.env.wasm.wasmPaths = wasmPaths;\n  } else if (!ort.env.wasm.wasmPaths) {",
    );
  },
});

console.log("[patches] Whisper and Parakeet patches verified");