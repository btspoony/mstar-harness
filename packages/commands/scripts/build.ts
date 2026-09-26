import { build } from "bun";

const result = await build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  packages: "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
