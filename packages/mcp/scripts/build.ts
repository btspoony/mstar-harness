import { build } from "bun";

for (const [target, outdir] of [["node", "dist"], ["bun", "dist/bun"]] as const) {
  const result = await build({
    entrypoints: ["src/index.ts", "src/stdio.ts"],
    outdir,
    target,
    packages: "bundle",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
    break;
  }
}

