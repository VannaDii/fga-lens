# Workbench data and operations

The [contract](workbench-contract.ts) defines workspace and OpenFGA codecs. The [workspace store](workbench-workspace.ts) serializes local writes and replaces snapshots atomically. The [engine adapter](workbench-server.ts) owns OpenFGA requests and per-store reservations.

Malformed UTF-8 in a workspace snapshot takes the same recovery path as malformed JSON. The original bytes remain available for download and new saves use the recovery file.

[Publication](workbench-publish.ts) checks captured tuple changes before the first mutation and journals condition replacements. OpenFGA [validates additions as contextual tuples in Expand][expand] against the captured model without writing them. Removals validate the stored key and reread the exact tuple under the captured revision's publication plan. [Evidence](workbench-evidence.ts) follows the captured query with a bounded set of observations. [Regression](workbench-regression.ts) stages shared tuples in owned fixtures and executes each selected case through the same [request builder](workbench-query-request.ts) as Queries.

Publish failures attach application reason codes, source coordinates, and allowed model choices. The editor resolves tuple identities locally against its saved snapshot. Provider text stays at the server boundary. Preflight failures leave the previous publication counts and merge basis intact.

Both startup modes check the [OpenFGA v1.22.1 default][write-context-limit] of 32 KiB per added tuple's protobuf condition context before any tuple mutation. The [Write command][write-context-check] checks this size separately from Expand's model validation. Deletions send tuple keys only.

[expand]: https://github.com/openfga/openfga/blob/v1.22.1/pkg/server/commands/expand.go#L67-L73
[write-context-limit]: https://github.com/openfga/openfga/blob/v1.22.1/pkg/server/config/config.go#L32-L34
[write-context-check]: https://github.com/openfga/openfga/blob/v1.22.1/pkg/server/commands/write.go#L136-L154
