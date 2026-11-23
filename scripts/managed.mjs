import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import concurrently from "concurrently";

const binary = process.env.OPENFGA_BINARY || "openfga";
const version = "1.22.1";
const apiPort = process.env.OPENFGA_MANAGED_HTTP_PORT || "8080";
const grpcPort = process.env.OPENFGA_MANAGED_GRPC_PORT || "8081";
const endpoint = "http://127.0.0.1:" + apiPort;
const sqlite = resolve(process.env.FGA_WORKSPACE_DIR || ".fga-workspace", "openfga.sqlite");

const databaseArgs = ["--datastore-engine", "sqlite", "--datastore-uri", sqlite];

/** Keep the engine under the supervisor and forward shutdown to its child. */
async function engine() {
  const credential = process.env.OPENFGA_MANAGED_CREDENTIAL;
  if (!credential) return 1;
  const allowedOrigin = "http://127.0.0.1:" + (process.env.PORT || "3000");
  const child = spawn(binary, ["run", ...databaseArgs, "--http-addr", "127.0.0.1:" + apiPort,
    "--grpc-addr", "127.0.0.1:" + grpcPort, "--playground-enabled=false", "--metrics-enabled=false", "--log-level", "none",
    "--authn-method", "preshared", "--http-cors-allowed-origins", allowedOrigin,
    "--http-cors-allowed-headers", "Content-Type"], { stdio: "inherit",
    env: { ...process.env, OPENFGA_AUTHN_PRESHARED_KEYS: credential } });
  const stop = () => { child.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const exited = new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return exited;
}

/** Start Next.js only after the engine reports readiness. */
async function app() {
  const credential = process.env.OPENFGA_MANAGED_CREDENTIAL;
  if (!credential) return 1;
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    try {
      const status = await fetch(endpoint + "/stores?page_size=1", {
        headers: { authorization: "Bearer " + credential }, signal: AbortSignal.timeout(750),
      });
      if (status.ok) {
        const child = spawn("npm", ["run", "dev"], { stdio: "inherit",
          env: { ...process.env, OPENFGA_API_URL: endpoint, OPENFGA_PRESHARED_KEY: credential } });
        return await new Promise((resolve) => {
          const stop = () => { child.kill("SIGTERM"); };
          process.once("SIGTERM", stop);
          process.once("SIGINT", stop);
          child.once("error", () => resolve(1));
          child.once("exit", (code) => resolve(code ?? 1));
        });
      }
    } catch {
      // A starting engine may reject connections until readiness.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.error("OpenFGA readiness timed out. Check the port and the SQLite configuration in README.md.");
  return 1;
}

/** Validate the pinned installed binary and migrate SQLite before supervising the runtime. */
async function managed() {
  const installed = spawnSync(binary, ["version"], { encoding: "utf8", timeout: 5_000 });
  const output = (installed.stdout ?? "") + (installed.stderr ?? "");
  if (installed.status !== 0 || !new RegExp("(^|[^0-9.])" + version.replaceAll(".", "\\.") + "([^0-9.]|$)").test(output)) {
    console.error("Install OpenFGA v" + version + " from https://github.com/openfga/openfga/releases/tag/v" + version
      + " and add it to PATH or set OPENFGA_BINARY. See README.md.");
    return 1;
  }
  await mkdir(resolve(sqlite, ".."), { recursive: true, mode: 0o700 });
  const migrated = spawnSync(binary, ["migrate", ...databaseArgs], { stdio: "inherit", timeout: 20_000 });
  if (migrated.status !== 0) {
    console.error("OpenFGA SQLite migration failed. Check the workspace directory and installed binary.");
    return 1;
  }
  const env = { OPENFGA_MANAGED_CREDENTIAL: randomBytes(32).toString("hex") };
  const supervisor = concurrently(
    [{ command: "node scripts/managed.mjs engine", name: "openfga", env },
      { command: "node scripts/managed.mjs app", name: "next", env }],
    { killOthersOn: ["success", "failure"] },
  );
  return supervisor.result.then(() => 0, () => 1);
}

const mode = process.argv[2];
process.exitCode = await (mode === "engine" ? engine() : mode === "app" ? app() : managed());
