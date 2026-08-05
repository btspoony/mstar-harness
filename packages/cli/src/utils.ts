import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeModelList(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseCsv(raw?: string) {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ensureObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function readJson(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
}

export function writeJson(filePath: string, value: Record<string, unknown>) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveProjectRoot() {
  const candidate = process.env.MSTAR_CLI_PROJECT_ROOT || process.env.INIT_CWD || process.env.PWD;
  if (candidate && candidate.trim()) return path.resolve(candidate);
  return process.cwd();
}

/**
 * Read the CLI package version from its package.json.
 * Single source of truth for the harness version inside the CLI; adapters
 * that need to embed/validate a version (e.g. ZCode marketplace entry) must
 * derive it from here instead of hardcoding a literal.
 */
export function readHarnessVersion(): string {
  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../package.json",
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return parsed.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
