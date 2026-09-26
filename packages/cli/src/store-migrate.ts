import path from "node:path";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { getStoreCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";

const verbs = getStoreCommandDefinitions();
type Input = Record<string, string | boolean | undefined>;
const optionKeysByVerb: Record<string, readonly string[]> = {
  init: ["harness"], migrate: ["harness", "apply", "manifest", "out"], upgrade: ["harness"], backup: ["harness", "out"],
  activate: ["harness", "manifest", "attestation", "out"], retire: ["harness", "manifest", "out"],
};

function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: resolveProcessHarnessDir(process.cwd()),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("dashboard effect is unavailable for store commands"); },
      async openBrowser() { throw new Error("browser effect is unavailable for store commands"); },
    },
  };
}

function attach(command: Command, definition: CommandDefinition): void {
  const verb = definition.cli.path[1]!;
  for (const option of definition.cli.options) if (optionKeysByVerb[verb]!.includes(option.key)) command.option(option.flags);
  command.exitOverride().action(async (options: Input) => {
    const { json, ...input } = options;
    const result = await definition.execute(input, context());
    const data = result.status === "ok" ? result.data : undefined;
    const operation = definition.id.slice("store.".length);
    if (json === true) {
      console.log(JSON.stringify(result.status === "ok" ? { ok: true, data } : { ok: false, code: result.code, message: result.message, details: { operation } }));
    } else if (result.status !== "ok") {
      console.error(`store ${operation}: ${result.message}`);
    } else {
      const value = data as Record<string, unknown>;
      if (operation === "init") {
        const harness = resolveProcessHarnessDir(process.cwd(), typeof input.harness === "string" ? input.harness : undefined) ?? process.cwd();
        console.log(`store init: created an active empty store at ${path.join(harness, "store.db")} (schema ${value.schemaVersion}, epoch ${value.epoch})`);
      } else if (operation === "upgrade") {
        console.log(`store upgrade: schema version ${value.schemaVersion} (nothing left to apply)`);
      } else if (operation === "migrate" && Array.isArray(value.sources)) {
        console.log(`store migrate preview: ${value.mappings} mapped row(s) across ${value.sources.length} register(s), ${value.unresolved} unresolved, ${value.catalogConflicts} catalog conflict(s)`);
        for (const source of value.sources as { project: string; relativePath: string; entryCount: number; sha256: string }[]) {
          console.log(`  ${source.project} ${source.relativePath}: ${source.entryCount} entr(ies) ${source.sha256.slice(0, 12)}`);
        }
        console.log(String(value.nextStep));
      } else if (operation === "migrate") {
        const counts = value.counts as { issues: number; open: number; closed: number; catalogEntities: number };
        console.log(`store migrate apply: ${value.replayed ? "REPLAY (no writes)" : "applied"} receipt #${value.receiptId} (${counts.issues} issue(s): ${counts.open} open / ${counts.closed} closed, catalog ${counts.catalogEntities})`);
      } else if (operation === "backup") {
        console.log(`store backup: ${value.backupPath} (store_id ${value.storeId}, epoch ${value.epoch}, revision ${value.revision})`);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    }
    if (result.status !== "ok") process.exitCode = result.exitCode;
  });
}

export function registerStoreCommands(program: Command): void {
  const store = program.command("store").description("Store migration, lifecycle and recovery operations").exitOverride();
  for (const definition of verbs) {
    const verb = definition.cli.path[1]!;
    attach(store.command(verb).description(definition.description), definition);
  }
}

export function storeUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[2] !== "store" || argv[3] === "execution") return null;
  return JSON.stringify({ ok: false, code: "usage", message, details: { operation: argv[3] ?? "store" } });
}
