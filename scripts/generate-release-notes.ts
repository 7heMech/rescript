// Generates GitHub release notes from the git range since the previous tag.
// Usage: `npx tsx scripts/generate-release-notes.ts <current-ref> [previous-ref] [--out <file>]`
// Writes markdown to <file>, or to stdout when --out is omitted.
// Requires AI_GATEWAY_API_KEY.
import { config as loadEnv } from "dotenv";
import { generateText } from "ai";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// quiet: dotenv's banner would otherwise pollute stdout.
loadEnv({ quiet: true });

const argv = process.argv.slice(2);
let outFile: string | undefined;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--out" || arg === "-o") {
    outFile = argv[++i];
    if (!outFile) {
      console.error("[release-notes] --out requires a file path");
      process.exit(1);
    }
  } else if (arg.startsWith("--out=")) {
    outFile = arg.slice("--out=".length);
  } else {
    positional.push(arg);
  }
}

const [current, previous] = positional;
const model = process.env.RELEASE_NOTES_MODEL ?? "anthropic/claude-sonnet-4-6";

if (!current) {
  console.error(
    "Usage: tsx scripts/generate-release-notes.ts <current-ref> [previous-ref] [--out <file>]"
  );
  process.exit(1);
}

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("[release-notes] AI_GATEWAY_API_KEY not set");
  process.exit(1);
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function gatherContext(): {
  commits: string;
  diffStat: string;
  changedFiles: string;
} {
  const excludeLock = "-- . ':!package-lock.json'";

  if (!previous) {
    return {
      commits: sh(`git log ${current} -n 20 --pretty=format:'%h %s'`),
      diffStat: "(first release)",
      changedFiles: "",
    };
  }

  const range = `${previous}..${current}`;
  return {
    commits: sh(`git log ${range} --pretty=format:'%h %s'`),
    diffStat: sh(`git diff ${range} --stat ${excludeLock}`),
    changedFiles: sh(`git diff ${range} --name-only ${excludeLock}`),
  };
}

async function main() {
  const { commits, diffStat, changedFiles } = gatherContext();

  const { text } = await generateText({
    model,
    system: `You write GitHub release notes for Rescript, an offline transcript-based video/audio editor (web + Electron desktop).
Audience: end users and contributors. Tone: clear, concise, no hype.
Format markdown with:
## Highlights (2-4 bullets of the most user-visible changes)
## Changes (bullets grouped by theme when helpful: Transcription, Editing, Export, Desktop, Fixes)
Omit internal refactors unless user-visible. No commit hashes. No preamble.`,
    prompt: previous
      ? `Release ${current} (changes since ${previous}):

Commits:
${commits || "(none)"}

Files changed:
${changedFiles || "(none)"}

Diff summary:
${diffStat || "(none)"}`
      : `Release ${current} (first tagged release):

Recent commits:
${commits || "(none)"}`,
  });

  const notes = `${text.trim()}\n`;

  if (outFile) {
    writeFileSync(outFile, notes, "utf8");
    console.error(`[release-notes] wrote ${outFile}`);
  } else {
    process.stdout.write(notes);
  }
}

main().catch((err) => {
  console.error("[release-notes] error:", err);
  process.exit(1);
});
