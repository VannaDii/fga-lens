# FGA Lens

FGA Lens is a local OpenFGA workbench for authoring authorization models, editing tuples, inspecting query evidence, reviewing effective access and running saved regression cases.

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

Model and Instances edits save locally by default. Auto-publish is off initially and is configurable in Settings. The workbench keeps store-specific source, tuple drafts and baselines. The Query screen uses the selected installed model, published tuples and any explicitly selected contextual tuples. Opening the root URL restores the most recently saved screen. Settings remembers the workspace appearance. **System** follows the device theme.

Open **Compare** to query a different store or a different revision in the same store. Close it to query the primary target alone. In **Evidence → Model rules**, select a line number to open the exact published revision in a read-only Model tab with the definition highlighted.

**Settings → General** holds connection, appearance, and saving preferences. **Settings → Stores** lists the configured server’s stores by name and ID. Use it to create an empty store or confirm deletion of a store. Deleting the selected store clears the active target and preserves local drafts. [OpenFGA’s store API][store-api] currently leaves renaming unimplemented.

Model revision selectors number installed revisions within each store, starting with the oldest. The selector tooltip and query results show the exact OpenFGA ID. On Instances, the info button beside the heading shows the tuple sync time and last publication counts.

The Instances editor detects strict JSON and YAML, including flow-style YAML. The shared empty list `[]` defaults to YAML. **Fetch store tuples** keeps JSON drafts in JSON and preserves the previous baseline and fetch time if either the current or saved draft cannot merge. Correct the indicated issue, save, then fetch again. **Publish** checks the intended additions, replacements and removals against the selected installed model before making any tuple writes.

The default workspace directory is `.fga-workspace/`. Set `FGA_WORKSPACE_DIR` for a separate workspace. If the saved file cannot be decoded, use **Download saved workspace** to recover the original bytes. New saves go to a separate recovery file. Stop the workbench before replacing saved state manually.

The model editor includes the official ANTLR-backed DSL parser and seven example models. The bundled examples come from [OpenFGA Sample Stores][sample-stores], Copyright 2022 Okta, Inc., under the [Apache License 2.0][sample-license].

## Explore

Open **Explore**, choose an installed model revision, then pick a starting instance and a **View as** identity. Branches start expanded. Collapse or expand a branch in either view to update both. The outline eye button pans and zooms the chart to the card, using the device’s reduced-motion setting. Select a chart card to reveal its outline entry. Changing **View as** updates the results in place.

Explore checks every defined relation on every in-scope resource, including hierarchy relations. Green marks allowed actions or branches that lead to an allowed action. Blue marks matches on resources and branches with only relationships. Muted access means the relevant checks returned a negative result. Unavailable and unfinished checks remain visible with their own status. Use the info button to see review timestamps and check progress.

The chart uses published tuples for `parent` and other relations referenced by an inheritance rule such as `can_view from folder`. Reverse links use `child`, `children`, `contains`, or `include`. Connectors show the structural relationship, and each resource card shows its `can_*` action results and other relationship matches. Open **Why** on a chart card or choose a specific result to inspect evidence beside the card. Use **Close Why** to dismiss it. The refresh icon reads the hierarchy and runs the access checks again. Condition inputs and results stay in memory.

Before opening the same workspace in an older build, visit **Model** and allow that selection to save. For an offline rollback, stop the workbench, copy the workspace file, and set its top-level route to `"model"` if the current value is `"explore"` or `"access-review"`.

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
[store-api]: https://github.com/openfga/api/blob/main/openfga/v1/openfga_service.proto#L787-L869
