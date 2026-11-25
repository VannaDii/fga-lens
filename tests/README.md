# Workbench verification

Use Node 24 and install from the lockfile with npm ci. Use a clean test checkout with disposable workspace data. Install Google Chrome and native Safari for the browser checks. The integration harness requires [stock OpenFGA v1.22.1][release] on PATH or at the path supplied in FGA_TEST_BINARY. The export scenarios use generated files and do not require the OpenFGA CLI.

The Chrome projects bind Next.js and the harness to loopback. Set FGA_TEST_APP_PORT, FGA_TEST_ENGINE_PORT, FGA_TEST_PROXY_PORT and FGA_TEST_GRPC_PORT together if the default ports 35490–35493 are occupied. Set FGA_TEST_ARTIFACTS and FGA_TEST_COVERAGE to assigned local directories to retain raw output. Keep logs, browser recordings, run artifacts and generated fixture copies local.

## Test inventory

| Gate | Command and expected cases |
| --- | --- |
| Isolated solution tests | npm test -- tests/model-editor.test.tsx (1); npm run test:e2e:chrome (4); npm run test:integration (4, including 2 engine controls). |
| Full qualification | npm test (17 in the initial test inventory); npm run lint; npm run build; npm run test:coverage (the same 17 Vitest cases); both browser commands above; the relevant live walkthroughs below and native Safari. Reconcile candidate additions with the approved suite inventory. |
| Selection | Vitest discovers its ordinary test files. Playwright Chrome picks files matching *.chrome.pw.ts; integration picks *.engine.pw.ts. Run each configured suite in full without retries, skips, grep or sharding for qualification. |

The existing Vitest cases cover parsing, layout and session restoration. The jsdom case uses the real legacy editor, React Flow, parser and browser storage. Its ResizeObserver stub supplies the absent layout API. Native browsers cover actual graph geometry and keyboard behavior.

Run V8 against Node and rendered components together. Use coverage-final.json and the frozen Git comparison to report exact statement, line, branch and function counts for changed production code. Inspect the entries for each changed location, including individual branch arms. Require zero uncovered items per metric. Treat a missing runtime source file or metric as missing evidence. Baseline totals record runner behavior and aren’t candidate qualification.

## Focused repair regressions

The F01–F12 cases extend the initial inventory. The original editor test, four Chrome cases and four stock-engine cases remain in their normal runner selections.

| File | Cases | Verification |
| --- | ---: | --- |
| [managed-boundary-regression.test.ts](managed-boundary-regression.test.ts) | 3 | F01 checks managed credentials and origin policy, and publishes a synthetic model through the real local workbench as a positive control. |
| [local-boundary-regression.test.ts](local-boundary-regression.test.ts) | 4 | F02 invokes the real route and disposable workspace, checks local loads and compares binary recovery bytes. |
| [wire-regression.test.ts](wire-regression.test.ts) | 6 | F08 injects only provider response shapes. F09 imports actual native files and round-trips the one-filter control. |
| [draft-findings.engine.pw.ts](draft-findings.engine.pw.ts) | 11 | F03 checks actual automatic engine writes and the explicit empty-list control. F04 drives fetch, conflict resolution, stale tabs and reordered responses. |
| [publication-findings.engine.pw.ts](publication-findings.engine.pw.ts) | 6 | F05 interrupts actual journaled writes. F06 compares the manual retry payload, valid formatting reuse and a split decimal rejected by OpenFGA. |
| [query-findings.engine.pw.ts](query-findings.engine.pw.ts) | 8 | F07 checks each context path and exact request disclosure. F08 uses actual decisions and later evidence, including a capped list. F10 releases the primary after an alternate result. |
| [batch-findings.engine.pw.ts](batch-findings.engine.pw.ts) | 6 | F11 verifies report identity and setup cancellation. F12 follows the configured-store staging guide with exported data and checks real grant isolation. |

Run the targeted Node files with npm test -- tests/local-boundary-regression.test.ts tests/managed-boundary-regression.test.ts tests/wire-regression.test.ts. Run the four browser files with npm run test:integration -- tests/draft-findings.engine.pw.ts tests/publication-findings.engine.pw.ts tests/query-findings.engine.pw.ts tests/batch-findings.engine.pw.ts. Use assigned disposable workspace and artifact paths. FGA_TEST_LIST_LIMIT=1 speeds the focused browser run. The capped-list test seeds one more grant than the actual configured cap, including the default 1000. The managed file starts its own SQLite-backed stack. Run it before starting the browser harness so the Next.js dev processes do not share a build directory.

The test-only proxy can hold an actual OpenFGA response with a named gate. Tests release the gate explicitly or observe its removal when the connection aborts. Workbench browser interception can also withhold one actual request or response. These controls establish event order without fixed sleeps. They only apply to the local synthetic fixture endpoints.

## Local editor and publication preflight

Run the ten [local preflight cases](local-preflight.engine.pw.ts) with npm run test:integration -- tests/local-preflight.engine.pw.ts. The browser cases use a prepopulated fixture and compare the editor and durable state before repairing the YAML and publishing. They verify the original authorization grant against the engine after publication.

The publication cases check malformed tuple identifiers, an implicit userset, a computed relation, and condition inputs. A configured-engine browser case checks that a later condition context larger than 32 KiB when serialized as protobuf blocks the earlier valid addition and points to the exact YAML field. The stock engine rejects each invalid row independently. The workbench must reject the authored plan before sending any tuple write. The passing plan verifies ordinary, conditioned, and userset additions alongside the existing grant. See the [stock tuple contract][tuple-contract] and [write validation][write-validation].

## Instances relationship layout

Run the six [Instances relationship layout cases](instances-layout.engine.pw.ts) with npm run test:integration -- tests/instances-layout.engine.pw.ts. The installed Chrome runner uses a disposable stock-engine store with a synthetic resource hierarchy and distinct direct assignments. The cases verify grouping and sibling roles, resource and person focus, exact tuple and YAML source inspection, existing filters, and a resource held only in local inventory. A fetch and focus control verifies the same fixture without requiring the new layout.

## Contextual workbench toolbar

Run the four [contextual toolbar cases](workbench-toolbar.engine.pw.ts) with npm run test:integration -- tests/workbench-toolbar.engine.pw.ts. A disposable stock-engine fixture records real model and tuple sync times for the Model and Instances checks. Installed Chrome verifies the contextual controls and status on desktop, editor access at 320px, and the existing Queries comparison and Batches controls.

## Tuple publication diagnostics

Run the six [tuple publication diagnostics cases](tuple-publish-diagnostics.engine.pw.ts) with npm run test:integration -- tests/tuple-publish-diagnostics.engine.pw.ts. The browser cases use a disposable stock-engine store with existing grants and one prior successful publication. They verify row-specific missing-relation and subject guidance, exact YAML source selection, zero mutations on a model mismatch, and ordinary Publish after changing the revision or editing the draft. A synthetic upstream write fault checks the safe wire and UI error envelope without forwarding an upstream diagnostic body.

The F13 cases use a named barrier on the real installed-model reply to reject a captured attempt after a newer edit or a store switch. They verify feedback on the initiating editor, unchanged grants and draft selections, safe source navigation, and clear attribution of counts after success and a later blocked attempt.

## Copilot repair regressions

The [draft](draft-findings.engine.pw.ts) and [publication](publication-findings.engine.pw.ts) suites add five cases. C1 reverses delivery of real Save and Publish acknowledgments and checks the next Save. A separate retry control holds a committed Publish response while a Save conflicts. C2 uses two stock model revisions to verify deletion of an obsolete grant, same-key condition replacement, and zero writes when an invalid addition accompanies a valid removal. The [local boundary suite](local-boundary-regression.test.ts) adds two C3 cases comparing malformed UTF-8 with a valid literal replacement character. It checks exact recovery bytes and the subsequent file state after Save.

Run `node tests/check-playwright-workspace-isolation.mjs` for the six C4 scenarios. The driver copies tracked project files and the installed lockfile-pinned dependencies into a disposable directory, without copying any local workspaces or `.env` files. Each real npm browser command runs the same [Save probe](playwright-workspace-probe.ts) once with default environment, once with a synthetic `FGA_WORKSPACE_DIR`, and once with `FGA_TEST_WORKSPACE_DIR` and the synthetic developer path both set. The probe checks the actual Next child’s target, successful Chrome Save and exact sentinel bytes. The driver checks fresh default directory cleanup and explicit override retention, then removes its own scratch checkout. Use the regular port overrides when other test listeners occupy the default ports.

The C4 probe is discovered only in the temporary checkout.

### Model ordering, batch preferences, and query inputs

The second Copilot repair adds 12 stock-engine cases to the existing focused browser files. The [publication cases](publication-findings.engine.pw.ts) distinguish escaped CEL literal spaces through real Publish, lost-reply recovery, source suggestions, fixture reuse, and Check. The [draft cases](draft-findings.engine.pw.ts) order real provider retries and acknowledgments across two ordinary auto-publishes, with a historical selection control. The [batch cases](batch-findings.engine.pw.ts) withhold real fixture and report replies after commit and verify user preferences after reload. The [query cases](query-findings.engine.pw.ts) compare alternate-only ListObjects and ListUsers results with known omitted candidates, verify the captured follow-up Check, and exercise scalar, represented, nested, malformed, and out-of-range durations against stock OpenFGA.

The isolated inventory is 98 standard runner cases (16 Vitest, 4 Chrome and 78 stock OpenFGA) plus the six C4 scenarios. Full qualification has 114 standard runner cases (32 Vitest, 4 Chrome and 78 stock OpenFGA) plus the same six scenarios, lint and build.

## Access Review

Use the [synthetic Access Review fixture](access-review-fixture.ts) in a disposable workspace. The browser cases install model revisions and tuples in the stock engine. They compare visible decisions to independent ordinary Checks and keep provider traffic local. The Node cases use the real same-origin route and stub only the upstream OpenFGA responses.

| Requirement | Evidence |
| --- | --- |
| AR01 · Scope and layout | [Scope cases](access-review-scope.test.ts) check complete pagination, exact concrete IDs, both directions, the installed model, a shared descendant, a cycle and roots with no eligible links. [Browser cases](access-review.engine.pw.ts) check exact check coverage, the live chart and viewport on person switch, branch access and a vanished root. |
| AR02 · Assignment and inheritance | Browser cases compare the direct and nested group verdicts to stock Checks and look for their exact supporting tuple keys and later-observation label. |
| AR03 · Denial, context and provider failure | [Wire cases](access-review-wire.test.ts) verify mixed result cardinality, per-ID association and safe diagnostics. Browser cases compare real exclusions and condition outcomes, including a missing parameter beside a valid result, then check recovery from a whole provider fault. |
| AR04 · Installed actions | Browser cases switch installed revisions, inspect relationship-only resources and promote an existing relation while observing its unchanged decision and check traffic. |
| AR05 · Cancellation and stale data | Node cases reject invalid later Read pages. Browser cases hold real replies for an obsolete person, condition and explanation, cancel two in-flight batches, fail a later Read page and change a grant between Expand and the verifying Check. |
| AR06 · Boundaries and recovery | Wire cases reject cross-origin, duplicate, invalid and oversized requests before provider access. Browser cases check read-only traffic, unsaved drafts, in-memory conditions and validated workspace restoration. For rollback, use the previous build with a disposable copy and verify Model, Instances and Batches survive the route preference change. |
| AR07 · Live walkthrough | On the frozen candidate use installed Chrome and native Safari at 1440 × 900 and 320 px. Select a root and person, expand a muted branch, switch person, inspect a reason and refresh. Verify keyboard focus, readable actions and page width. Retain the walkthrough locally. |
| AR08 · Scale | Run five managed SQLite reviews, including the first after restart, with 2,000 stored tuples, 200 scoped resources and 1,000 checks. Record catalog, scope, first decision and completion times, outcome totals, progress, cancellation, request size and concurrency. Verify evidence traffic starts only on inspection. |

Run the 19 isolated Node cases with `npm test -- tests/access-review-scope.test.ts tests/access-review-wire.test.ts`. Run the 18 isolated Chrome cases with `npm run test:integration -- tests/access-review.engine.pw.ts`. The complete inventory is 51 Vitest cases, 96 stock-engine cases and 4 Chrome cases, plus the six workspace-isolation scenarios. Use the configured runners without filters, retries, skips or shards for qualification. Collect exact covered and total counts for changed statements, lines, branches and functions. The Vitest coverage command does not itself collect execution from the separate browser and Next.js processes.

## Synthetic data and transport

Generate a disposable import bundle with node tests/make-fixtures.mjs followed by a local destination path. The inline and relative batches include 108 shared tuples, duplicate case names with different grants, wildcard and userset assertions, and two request timestamps with opposite results. The inline batch adds an exact 100-context case. The overflow batch supplies 101. Use both variants with the [native file contract][format].

The engine suite uses an unauthenticated in-memory OpenFGA started as a child of the harness. A loopback-only transport forwards requests to the engine and records synthetic payloads in memory. It can drop the reply after a successful write, drop a request before forwarding, return a bounded error, repeat a real page token, or delay a response. It alters transport observations only for explicitly armed paths. Use GET /__fga_test__/traffic to inspect and DELETE to reset observations. POST a JSON array such as [{"path":"/stores/TEST_STORE/authorization-models","kind":"drop-success"}] to arm ordered actions. Use "when":"continued" to match a later tuple page. Use FGA_TEST_LIST_LIMIT=1 for the capped ListObjects walkthrough. The fixture installation and assertions use the [pinned engine API][api].

## Live acceptance walkthrough

Run the scenarios on the frozen candidate and bind results to its SHA. Use separate throwaway endpoints or workspaces for restart, corruption, failures and different browser runs. The table identifies additional evidence to collect beyond the automated tests.

| ID | Actions and pass evidence |
| --- | --- |
| A01 | Start from npm ci using both production README paths. Inspect listening addresses. Confirm valid same-origin publish and reject an otherwise equivalent cross-origin request. Compare local revision and recorded writes before and after rejection. Exercise missing and wrong binary versions, failed readiness, each owned process exiting and Ctrl+C. |
| A02 | In managed SQLite mode publish the sample model and a tuple. Save and execute a batch, leave an invalid DSL draft and pending tuple edit, alter settings, select Queries and stop both processes. Restart and compare the screen, text, graph, selected IDs, pending changes, settings, stored model and restored report. |
| A03 | With services stopped, make the disposable workspace unreadable as data, preserving its bytes for comparison. Relaunch, download the damaged file, save a new edit and compare original bytes. Separately stop the configured engine and confirm manual Save persists offline edits. |
| A04 | Toggle all four save/publish combinations. Use two tabs to produce a stale save, including when a prior save is pending. Inspect retained inputs and the transport for exactly the intended writes during preference saves, fetch, conflict resolution and a failed auto-publish. |
| A05 | Run the entry and legacy editor cases. In both real browsers open an example, select an edge and verify the source line, then introduce an invalid edit. Create a zero-tuple object. Fetch and edit tuple YAML, filter/search, inspect a conditioned edge and select its source line. Repeat legacy restoration with and without an existing file workspace in the same origin. |
| A06 | Publish the fixture model, add only whitespace and compare IDs and model-write counts. Edit only the condition expression and then only its parameters. Each real condition change needs a distinct ID. Select an earlier revision deliberately and confirm the selection stays until Use published revision. |
| A07 | Target the real model-write path with drop-success, then drop-request once, then drop-request twice in separate attempts. Switch the target and edit after dispatch. Verify original captured content, accepted revision reuse, one retry when needed, and Publish again with draft retained when both attempts fail. |
| A08 | Fetch the 108 tuples and inspect all pages and the deadline condition. Construct remote-only, local-only, matching and conflicting changes and deletions on distinct keys. Resolve one conflict with each action. Arm later-page service-error, repeat-token and hold-response and cancel while held. Each failure preserves prior baseline and draft and sends no write. |
| A09 | Publish explicit edits using an older installed model ID with an unrelated tuple present. Fail a later write and compare completed and pending counts. Interrupt a conditioned replacement after delete. Restart and separately retry with original, absent, replacement and different server values. Check exact writes and preservation of newer local edits. |
| A10 | Run the captured Check case. For all three operations inspect the actual request relative to the pinned API, including installed model ID and store path. Assert one ListUsers filter, nested versus flat contextual tuples, and distinct condition context per input. Exercise malformed app requests, malformed upstream success and error responses, and inspect io-ts decoding of existing wire types as well. |
| A11 | Select IDs from fetched data and a local-only object. Search, clear and attempt incompatible selections and invalid condition context. Capture a valid query, edit the form after dispatch and verify its original request stays. Compare two targets with identical inputs and a relation missing on one side. Preserve the successful result and explanation with target and elapsed time. |
| A12 | Run the inherited grant case and inspect both rule and tuple identities. Add one more parent hop. Separately exercise direct grant, no grant, eligible+blocked and ineligible+blocked, and the two sides of the fixture deadline. Confirm each sentence matches actual tuples, rules or follow-up results. |
| A13 | Run a capped list and target an omitted object the engine allows. Preserve list and Check observations independently. Change a tuple after dispatch, arm a provider error, hold a follow-up and cancel, and check at most 32 follow-ups or five seconds per result. Preserve original outcome and Reason undetermined when evidence conflicts. Verify correlation ID and synthetic diagnostic redaction at both UI and log sink. |
| A14 | Run the temporary-grant case. Confirm denied, allowed with the selected contextual tuple, and denied after clearing it. The captured write count and higher-consistency stored tuple snapshot must agree before and after. |
| A15 | Import the duplicate batch. Save a captured request with unique, colliding, unique and other-collision names. Verify exact diff, occurrence selection, cancel stability and one-case overwrite. Choose the successful comparison side for expectation and see Not run. Repeat with a live temporary grant absent from the destination. |
| A16 | Import both inline and relative fixture files. Remove a companion and add an unsupported field in disposable copies to verify the specific error. Run the two timestamps within one case and inspect every assertion. Change a same-key shared condition from Queries and confirm the full diff and separate effective fixture option. |
| A17 | Run the same saved cases against two installed revisions. Change the inherited grant and keep one control stable. Compare source and actual installed fixture target IDs, expected values and fixture records. Verify a draft, a missing revision and drift cannot each produce a passing run. |
| A18 | Select subsets including each operation. Verify the 108 shared tuples and 100 case tuples execute, then assert 101 fails validation. Verify set ordering, wildcard and userset identifiers, continue after one assertion error, cancel between cases, and restart to confirm totals, timings, error and unrun state. |
| A19 | Hold a batch operation inside the fixture reservation. Attempt Publish fixture, Instances publish, auto-publish and replacement recovery against that store. Prove all return Batch running with no upstream write. Publish to an unrelated store and repeat the original write after release by completion and by cancellation. |
| A20 | Export the duplicate and timed cases both ways. Count files, inspect both decoded formats and compare conditions and request contexts. Standard import round-trips. The split assertions contain no tuple fields or references. Reconstruct each companion fixture by position and name, compare all 108 shared tuples and verify only the first duplicate grants Casey. |
| A21 | In installed Chrome and native Safari record browser versions and the complete A02/A05/A11/A14/A15/A17/A20 path at 1440 × 900 and a narrow viewport. Inspect actual graph, focus visibility and return, keyboard controls, dialog Escape, comparison stacking, both downloads and app-authored pronoun-free text. Retain the recording and observations locally. |

[release]: https://github.com/openfga/openfga/releases/tag/v1.22.1
[format]: https://openfga.dev/docs/modeling/store-file-format
[api]: https://github.com/openfga/api/blob/f153694bfc20/openfga/v1/openfga_service.proto
[tuple-contract]: https://github.com/openfga/openfga/blob/v1.22.1/pkg/tuple/tuple.go#L390-L486
[write-validation]: https://github.com/openfga/openfga/blob/v1.22.1/pkg/server/commands/write.go#L119-L153
