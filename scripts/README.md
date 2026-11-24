# Managed runtime

The [managed launcher](managed.mjs) checks the installed OpenFGA version, migrates the workspace SQLite database and supervises the loopback engine and Next.js. See [setup](../README.md#managed-openfga) for configuration.

## Browser test workspace

`npm run test:e2e:chrome`, `npm run test:integration`, and direct Playwright runs using the repository config start Next through the [test launcher](playwright-next.mjs). Each launch uses its own temporary workspace, which the launcher removes after Next exits. Set `FGA_TEST_WORKSPACE_DIR` to an assigned disposable directory if you need to retain the test workspace. The launcher leaves that directory in place. The application's `FGA_WORKSPACE_DIR` does not select the browser test workspace.
