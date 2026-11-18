import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { audit, type Issue } from "./audit.js";
import type { DpdpConfig } from "./config.js";
import { formatSafeguards, safeguardsReport } from "./safeguards.js";
import { checkSchema, type Schema } from "./schema-check.js";

export const CONFIG_FILES = ["dpdp.config.ts", "dpdp.config.mts", "dpdp.config.js", "dpdp.config.mjs"];

export function findConfig(cwd: string, explicit?: string): string | undefined {
  if (explicit) return resolve(cwd, explicit);
  return CONFIG_FILES.map((f) => resolve(cwd, f)).find((f) => existsSync(f));
}

/** Import a TypeScript or JavaScript file the way the app would, resolving its own imports. */
async function loadModule(file: string): Promise<Record<string, unknown>> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(pathToFileURL(file).href);
  return (await jiti.import(file)) as Record<string, unknown>;
}

/** Load a config file (TypeScript or JavaScript). Accepts a default export or `export const config`. */
export async function loadConfig(file: string): Promise<DpdpConfig<string>> {
  const mod = (await loadModule(file)) as { default?: { config?: unknown }; config?: unknown };
  // jiti's interop can make `default` the whole module, so try each place a config could be.
  const config = [mod.default, mod.config, mod.default?.config].find(
    (c): c is DpdpConfig<string> => typeof c === "object" && c !== null && "purposes" in c,
  );
  if (!config) {
    throw new Error(`${file} must export a config: \`export default defineConfig({ ... })\``);
  }
  return config;
}

export function formatIssues(issues: readonly Issue[]): string {
  if (issues.length === 0) return "✔ No problems found.";
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const lines = [...errors, ...warnings].map(
    (i) => `${i.level === "error" ? "✖ error  " : "⚠ warning"}  ${i.path}\n             ${i.message}`,
  );
  lines.push("", `${errors.length} error(s), ${warnings.length} warning(s)`);
  return lines.join("\n");
}

const escapeData = (text: string) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text: string) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * GitHub Actions workflow commands, so each problem shows as an annotation on the pull request.
 * Schema issues point at the schema file and the rest at the config file, relative to the
 * repository root (`GITHUB_WORKSPACE`).
 */
export function formatGithubAnnotations(
  issues: readonly Issue[],
  files: { config: string; schema?: string | undefined },
  root: string,
): string {
  return issues
    .map((issue) => {
      const file = issue.path.startsWith("schema.") && files.schema ? files.schema : files.config;
      const props = [`file=${escapeProperty(relative(root, file))}`, `title=${escapeProperty(`dpdp-kit: ${issue.path}`)}`];
      return `::${issue.level} ${props.join(",")}::${escapeData(issue.message)}`;
    })
    .join("\n");
}

/** Load a Drizzle schema file and read its tables. */
export async function loadDrizzleSchema(file: string): Promise<Schema> {
  const mod = await loadModule(file);
  let drizzleSchema: (m: Record<string, unknown>) => Schema;
  try {
    ({ drizzleSchema } = await import("./drizzle.js"));
  } catch {
    throw new Error("--schema reads a Drizzle schema, so drizzle-orm must be installed in this project.");
  }
  const schema = drizzleSchema(mod);
  if (schema.tables.length === 0) {
    throw new Error(`${file} exports no Drizzle tables. Point --schema at the file that defines them.`);
  }
  return schema;
}

const flagValue = (argv: readonly string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Run `dpdp-kit audit`. Returns the exit code: 1 when there are errors (or `--strict` and warnings). */
export async function runAudit(argv: readonly string[], cwd: string, log: (line: string) => void): Promise<number> {
  const explicit = flagValue(argv, "--config");
  const schemaFlag = flagValue(argv, "--schema");
  const strict = argv.includes("--strict");
  const format = flagValue(argv, "--format") ?? "text";
  if (format !== "text" && format !== "github") {
    log(`Unknown --format ${JSON.stringify(format)}. Use "text" or "github".`);
    return 1;
  }
  const file = findConfig(cwd, explicit);
  if (!file || !existsSync(file)) {
    log(explicit ? `Config file not found: ${explicit}` : `No config found. Create one of: ${CONFIG_FILES.join(", ")}`);
    return 1;
  }
  const schemaFile = schemaFlag ? resolve(cwd, schemaFlag) : undefined;
  if (schemaFile && !existsSync(schemaFile)) {
    log(`Schema file not found: ${schemaFlag}`);
    return 1;
  }
  const config = await loadConfig(file);
  const issues = audit(config);
  if (schemaFile) issues.push(...checkSchema(config, await loadDrizzleSchema(schemaFile)));
  if (format === "github" && issues.length > 0) {
    log(formatGithubAnnotations(issues, { config: file, schema: schemaFile }, process.env.GITHUB_WORKSPACE ?? cwd));
  }
  log(formatIssues(issues));
  const failing = issues.filter((i) => i.level === "error" || (strict && i.level === "warning"));
  return failing.length > 0 ? 1 : 0;
}

/**
 * Run `dpdp-kit safeguards`: a Rule 6(1) report from the config. Returns 0, or with `--strict` 1
 * when a safeguard is missing or partly recorded.
 */
export async function runSafeguards(argv: readonly string[], cwd: string, log: (line: string) => void): Promise<number> {
  const explicit = flagValue(argv, "--config");
  const file = findConfig(cwd, explicit);
  if (!file || !existsSync(file)) {
    log(explicit ? `Config file not found: ${explicit}` : `No config found. Create one of: ${CONFIG_FILES.join(", ")}`);
    return 1;
  }
  const report = safeguardsReport(await loadConfig(file));
  log(formatSafeguards(report));
  const gaps = report.some((s) => s.status === "missing" || s.status === "partly");
  return argv.includes("--strict") && gaps ? 1 : 0;
}
