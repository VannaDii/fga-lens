# FGA Lens

FGA Lens is a local OpenFGA workbench for authoring authorization models, editing tuples, inspecting query evidence and running saved regression cases.

## Run locally

Use Node 24 and install dependencies with `npm ci`.

### Configured OpenFGA

Set the server URL and run the workbench. HTTP is available for loopback endpoints. Remote endpoints require HTTPS. Use `OPENFGA_PRESHARED_KEY` in the process environment if the endpoint requires a pre-shared key.

```sh
OPENFGA_API_URL=http://127.0.0.1:8080 npm run dev
```

Open `http://127.0.0.1:3000`. The configured OpenFGA lifecycle belongs to its operator. Local drafts remain available while the endpoint is unreachable.

### Managed OpenFGA

Install [OpenFGA v1.22.1][release] and make the installed binary available on PATH. For a binary elsewhere, set `OPENFGA_BINARY` to its full path.

```sh
npm run dev:managed
```

The launcher migrates SQLite in `.fga-workspace/` and starts Next.js after OpenFGA is ready. Both services bind to loopback. Managed mode generates a process-scoped server credential and restricts the engine’s browser origin policy. The managed engine suppresses provider logs so request data stays out of the workbench console. Ctrl+C or either process exiting stops both services. The default OpenFGA HTTP and gRPC ports are 8080 and 8081. Override them with `OPENFGA_MANAGED_HTTP_PORT` and `OPENFGA_MANAGED_GRPC_PORT`.

## Workspace

Model and Instances edits save locally by default. Auto-publish is off initially and is configurable in Settings. The workbench keeps store-specific source, tuple drafts and baselines. Queries use the selected installed model, published tuples and any explicitly selected contextual tuples. Opening the root URL restores the most recently saved screen.

**Fetch store tuples** preserves the previous baseline and fetch time if either the current or saved Tuple YAML cannot merge. The editor shows the cause and its source location. Correct the indicated YAML, save it, then fetch again. **Publish** checks the intended additions, replacements and removals against the selected installed model before making any tuple writes.

The default workspace directory is `.fga-workspace/`. Set `FGA_WORKSPACE_DIR` for a separate workspace. If the saved file cannot be decoded, use **Download saved workspace** to recover the original bytes. New saves go to a separate recovery file. Stop the workbench before replacing saved state manually.

The model editor includes the official ANTLR-backed DSL parser and seven example models. The bundled examples come from [OpenFGA Sample Stores][sample-stores], Copyright 2022 Okta, Inc., under the [Apache License 2.0][sample-license].

## Regression batches

Choose a published source store and model revision in Batches. **Publish fixture** installs that model in a dedicated fixture store and stages the shared tuples. **Run selected** verifies the fixture before executing the checklist. Case tuples and request context apply only to the relevant requests.

Import a native `.fga.yaml` file together with its referenced YAML, JSON or DSL companions. Choose the containing folder when the references include subdirectories. Export the standard suite as one model-free file. Choose **CLI compatible** for an assertions file and a separate `tuples.yaml` with shared and per-case tuples.

For [OpenFGA CLI v0.9.0][cli], use a configured endpoint that the CLI can authenticate to. Choose a dedicated fixture store and its installed model. To run the first case, copy the shared `tuples` plus the records under `tests[0].tuples` in the companion into Instances for that fixture store. For a replacement at the same tuple key, keep the case’s tuple. For a reused store, first select its actual store and revision and **Fetch store tuples** to refresh the baseline. Replace the YAML with the effective fixture, then Publish. Fetch again and verify the stored tuples, including conditions, against the intended case. Copy the first assertion case into a temporary `one-case.fga.yaml` with one entry under `tests`. Run the command below. Remove the first case’s tuple changes and stage the next case’s effective fixture before running the next file. Use the companion position as well as the name when multiple cases share a name.

```sh
fga model test --api-url "$OPENFGA_API_URL" --store-id "$FIXTURE_STORE_ID" --model-id "$FIXTURE_MODEL_ID" --tests ./one-case.fga.yaml
```

## Verification

Use `npm test`, `npm run lint`, `npm run build`, `npm run test:integration`, `npm run test:coverage` and `npm run test:e2e:chrome`. See [the verification guide](tests/README.md) for the stock engine, Chrome and native Safari walkthroughs.

[release]: https://github.com/openfga/openfga/releases/tag/v1.22.1
[cli]: https://github.com/openfga/cli/blob/v0.9.0/cmd/model/test.go
[sample-stores]: https://github.com/openfga/sample-stores/tree/main/stores
[sample-license]: https://github.com/openfga/sample-stores/blob/main/LICENSE
