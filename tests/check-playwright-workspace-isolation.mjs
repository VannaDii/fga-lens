import { execFileSync, spawnSync } from "node:child_process";
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "fga-playwright-isolation-")));
const checkout = join(scratch, "checkout");
const runtime = join(scratch, "runtime");
const source = join(project, "tests/playwright-workspace-probe.ts");
const scripts = [
  { name: "test:e2e:chrome", suffix: "chrome" },
  { name: "test:integration", suffix: "engine" },
];
const modes = ["default", "inherited", "override"];
const defaults = new Set();
let failed = 0;

/** Copy the Git-tracked project and installed dependencies without copying any local workspace or .env files. */
function stageCheckout() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: project, encoding: "utf8" });
  for (const path of tracked.split("\0").filter(Boolean)) {
    if (path.startsWith(".fga-workspace/") || path.startsWith(".env")) {
      throw new Error("Unexpected workspace or environment file in the tracked snapshot");
    }
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(project, path), destination, { verbatimSymlinks: true });
  }
  cpSync(join(project, "node_modules"), join(checkout, "node_modules"), {
    recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true,
  });
  mkdirSync(runtime);
}

/** Seed valid, distinct synthetic snapshots so accidental updates are detectable byte for byte. */
function seed(path, revision) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ revision, route: "model", store: "", model: "",
    autoSave: false, autoPublish: false, drafts: {}, batches: [] }, null, 2) + "\n");
  writeFileSync(path, bytes);
  return { path, bytes };
}

/** Run the documented entry point unchanged and check the Next child's workspace and lifecycle. */
function check({ name, suffix }, mode) {
  const key = `${suffix}-${mode}`;
  const checkoutDefault = join(checkout, ".fga-workspace", "workspace.json");
  const inherited = join(scratch, key, "inherited", "workspace.json");
  const override = join(scratch, key, "requested", "workspace.json");
  const receipt = join(scratch, key, "receipt.json");
  const sentinels = [seed(checkoutDefault, 11), seed(inherited, 22)];
  const probe = "tests/playwright-workspace-probe." + suffix + ".pw.ts";
  cpSync(source, join(checkout, probe));
  const env = { ...process.env, TMPDIR: runtime, FGA_TEST_ARTIFACTS: join(scratch, key, "artifacts"),
    FGA_ISOLATION_PROBE: JSON.stringify({ checkoutDefault, inherited, override, scratch, receipt, mode }) };
  delete env.FGA_WORKSPACE_DIR;
  delete env.FGA_TEST_WORKSPACE_DIR;
  delete env.FGA_TEST_ENGINE;
  delete env.OPENFGA_MANAGED_CREDENTIAL;
  if (mode !== "default") env.FGA_WORKSPACE_DIR = dirname(inherited);
  if (mode === "override") env.FGA_TEST_WORKSPACE_DIR = dirname(override);
  const command = ["run", name, "--", probe];
  console.log(`\n${new Date().toISOString()} ${key} in ${checkout}`);
  console.log(JSON.stringify({ FGA_WORKSPACE_DIR: env.FGA_WORKSPACE_DIR ?? null,
    FGA_TEST_WORKSPACE_DIR: env.FGA_TEST_WORKSPACE_DIR ?? null, TMPDIR: env.TMPDIR,
    FGA_TEST_ARTIFACTS: env.FGA_TEST_ARTIFACTS, WATCHPACK_POLLING: env.WATCHPACK_POLLING ?? null }));
  console.log("$ npm " + command.join(" "));
  const result = spawnSync("npm", command, { cwd: checkout, env, stdio: "inherit" });
  console.log(`[exit ${result.status ?? result.signal ?? String(result.error)}] npm ${command.join(" ")}`);
  const seen = existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null;
  console.log("C4 Next child receipt", seen);
  const unique = Boolean(seen?.disposableDefault) && !defaults.has(seen.path);
  if (seen?.disposableDefault) defaults.add(seen.path);
  const preserved = mode === "override" && seen?.path === override && existsSync(override);
  const removed = mode !== "override" && unique && !existsSync(dirname(seen.path));
  const lifecycle = mode === "override" ? preserved : removed;
  const developerBytesUnchanged = sentinels.map(({ path, bytes }) => existsSync(path) && readFileSync(path).equals(bytes));
  console.log("C4 workspace lifecycle", { uniqueDefault: unique, defaultRemoved: removed, overrideRetained: preserved, developerBytesUnchanged });
  if (result.status !== 0 || !lifecycle || developerBytesUnchanged.includes(false)) failed += 1;
}

try {
  stageCheckout();
  for (const script of scripts) {
    for (const mode of modes) check(script, mode);
  }
  console.log(`C4 isolation scenarios: ${6 - failed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
