import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";

const binary = process.env.FGA_TEST_BINARY ?? "openfga";
const enginePort = process.env.FGA_TEST_ENGINE_PORT;
const proxyPort = process.env.FGA_TEST_PROXY_PORT;
const grpcPort = process.env.FGA_TEST_GRPC_PORT;

for (const port of [enginePort, proxyPort, grpcPort]) {
  if (!/^\d{4,5}$/.test(port ?? "") || Number(port) > 65535) {
    throw new Error("Assign valid loopback ports for the OpenFGA test harness");
  }
}

const version = spawnSync(binary, ["version"], { encoding: "utf8", timeout: 5000 });
const versionText = (version.stdout ?? "") + (version.stderr ?? "");
if (version.status !== 0 || !/\b1\.22\.1\b/.test(versionText)) {
  throw new Error("FGA Lens integration tests require the installed stock OpenFGA server v1.22.1");
}
console.log(versionText.trim());

const engine = spawn(binary, [
  "run",
  "--datastore-engine", "memory",
  "--http-addr", "127.0.0.1:" + enginePort,
  "--grpc-addr", "127.0.0.1:" + grpcPort,
  "--playground-enabled=false",
  "--metrics-enabled=false",
  "--listObjects-max-results", process.env.FGA_TEST_LIST_LIMIT ?? "1000",
], { stdio: "inherit" });

const engineUrl = "http://127.0.0.1:" + enginePort;
const controlPath = "/__fga_test__/traffic";
const gatePath = "/__fga_test__/gates";
const gates = new Map();
const supportedFaults = new Set([
  "drop-success", "drop-request", "service-error", "malformed-success", "malformed-error",
  "repeat-token", "hold-response", "gate-response", "forward",
]);
const captured = [];
let queuedFaults = [];
let stopping = false;

/** Buffers only synthetic loopback traffic so assertions can compare exact API payloads. */
async function readBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

/** Drives response loss, failure, pagination and cancellation at the transport boundary. */
function controlTraffic(request, response, body) {
  if (request.method === "POST") {
    const faults = JSON.parse(body);
    if (!Array.isArray(faults) || faults.some((fault) =>
      !fault || !supportedFaults.has(fault.kind) || typeof fault.path !== "string"
      || (fault.kind === "gate-response" && typeof fault.gate !== "string"))) {
      response.writeHead(400).end();
      return;
    }
    queuedFaults = faults;
  }

  if (request.method === "DELETE") {
    captured.length = 0;
    queuedFaults = [];
  }

  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(captured));
}

/** Forwards an ordinary operation to the real engine and optionally perturbs only its transport. */
async function proxyRequest(request, response) {
  const path = request.url ?? "/";
  if (!path.startsWith("/") || path.startsWith("//")) {
    response.writeHead(400).end();
    return;
  }

  const body = await readBody(request);
  if (path === controlPath) {
    controlTraffic(request, response, body);
    return;
  }

  if (path === gatePath) {
    if (request.method === "POST") gates.get(JSON.parse(body).id)?.();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([...gates.keys()]));
    return;
  }

  const needsToken = queuedFaults.some((fault) =>
    fault.path === path && (fault.when === "continued" || fault.kind === "repeat-token"));
  const previousToken = needsToken && body ? JSON.parse(body).continuation_token : undefined;
  const faultIndex = queuedFaults.findIndex((fault) =>
    fault.path === path && (fault.when !== "continued" || previousToken));
  const fault = faultIndex === -1 ? undefined : queuedFaults.splice(faultIndex, 1)[0];
  if (path !== "/healthz") captured.push({ method: request.method, path, body });

  if (fault?.kind === "drop-request") {
    response.destroy();
    return;
  }
  if (fault?.kind === "malformed-error") {
    response.writeHead(503, { "content-type": "text/plain" }).end("synthetic_untrusted_error_52");
    return;
  }
  if (fault?.kind === "malformed-success") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"allowed":"synthetic_invalid_result_52"}');
    return;
  }
  if (fault?.kind === "service-error") {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "internal_error", message: "synthetic_untrusted_error_52" }));
    return;
  }

  const upstream = await fetch(engineUrl + path, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body: body || undefined,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  const payload = await upstream.text();
  if (fault?.kind === "drop-success" && upstream.ok) {
    response.destroy();
    return;
  }

  if (fault?.kind === "hold-response") await wait(7000);
  if (fault?.kind === "gate-response") {
    await new Promise((resolve) => {
      const release = () => {
        gates.delete(fault.gate);
        response.off("close", release);
        resolve();
      };
      gates.set(fault.gate, release);
      response.once("close", release);
    });
  }
  if (response.destroyed) return;
  response.writeHead(upstream.status, { "content-type": "application/json" });
  if (fault?.kind === "repeat-token" && upstream.ok) {
    const page = JSON.parse(payload);
    response.end(JSON.stringify({ ...page, continuation_token: previousToken ?? page.continuation_token }));
    return;
  }
  response.end(payload);
}

const proxy = createServer((request, response) => {
  proxyRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
});
proxy.listen(Number(proxyPort), "127.0.0.1");

/** Close test listeners and the owned engine together when Playwright ends the run. */
function stop() {
  stopping = true;
  proxy.close();
  proxy.closeAllConnections();
  engine.kill("SIGTERM");
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
engine.once("exit", (code) => {
  proxy.close();
  proxy.closeAllConnections();
  process.exitCode = stopping ? 0 : code || 1;
});
proxy.once("error", (error) => {
  console.error("OpenFGA test transport failed:", error.message);
  process.exitCode = 1;
  stop();
});
engine.once("error", (error) => {
  console.error("OpenFGA test process failed:", error.message);
  process.exitCode = 1;
  stop();
});
