import { build } from "bun";

const result = await build({
  entrypoints: ["src/index.ts", "src/stdio.ts"],
  outdir: "dist",
  target: "bun",
  packages: "bundle",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
