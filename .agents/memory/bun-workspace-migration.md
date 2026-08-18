---
name: Bun workspace migration
description: Bun workspace lifecycle and dependency-layout constraints for this monorepo.
---

# Bun workspace migration

The monorepo uses Bun 1.3.x with root `workspaces` and `bun.lock`; package-local
workflow commands run from the artifact directory, so managed artifact commands
must be `bun run dev`/`bun run build`, while root scripts can use
`bun run --cwd <package> <script>`.

**Why:** Bun does not consume pnpm catalogs or `pnpm-workspace.yaml`, and its
workspace lifecycle runs can occur before root-level dependency links exist.
Its hoisted packages may also be stored under `node_modules/.bun/node_modules`.

**How to apply:** Put concrete versions in each package manifest, resolve
install-time tooling from the current package/root/Bun store paths, and keep
install patches idempotent. Text-based patching is preferable to the Unix
`patch` utility because Bun may extract package files with CRLF line endings.