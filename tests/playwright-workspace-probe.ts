import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import { expect, test } from "@playwright/test";
import type { WorkspaceView } from "@/lib/workbench-contract";

/** This probe is discovered only when copied into the verification checkout by the isolation driver. */
test("C4 the Next child saves without changing either developer workspace", async ({ page, request }) => {
  const { checkoutDefault, inherited, override, scratch, receipt, mode } = JSON.parse(process.env.FGA_ISOLATION_PROBE!);
  const untouched = [checkoutDefault, inherited];
  const sentinels = await Promise.all(untouched.map((path) => readFile(path)));
  const initial = await request.get("/api/workbench");
  expect(initial.ok()).toBe(true);
  const before: WorkspaceView = await initial.json();
  const difference = relative(scratch, before.location);
  const temporary = difference !== "" && !isAbsolute(difference) && difference.split(sep)[0] !== "..";
  const disposableDefault = temporary && basename(before.location) === "workspace.json" && ![...untouched, override].includes(before.location);
  expect(temporary, "the actual file is inside the synthetic scope").toBe(true);
  if (mode === "override") expect.soft(before.location).toBe(override);
  else expect.soft(disposableDefault, "the Next child uses its own disposable workspace").toBe(true);
  expect.soft(before.state.revision, "the isolated workspace starts fresh").toBe(0);

  await page.goto("/model");
  const saved = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/workbench" && response.request().postDataJSON()?.action === "save");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  await expect(page.getByText("Saved to workspace", { exact: true })).toBeVisible();
  const after: WorkspaceView = await response.json();
  expect(after.location).toBe(before.location);
  expect(after.state.revision).toBe(before.state.revision + 1);
  expect(JSON.parse(await readFile(after.location, "utf8"))).toMatchObject({ revision: after.state.revision });

  const unchanged = await Promise.all(untouched.map(async (path, index) => (await readFile(path)).equals(sentinels[index])));
  await writeFile(receipt, JSON.stringify({ mode, path: after.location, disposableDefault, before: before.state.revision,
    after: after.state.revision, defaultUnchanged: unchanged[0], inheritedUnchanged: unchanged[1] }) + "\n");
  expect.soft(unchanged[0], "the checkout's developer workspace keeps the exact bytes").toBe(true);
  expect(unchanged[1], "the inherited developer workspace keeps the exact bytes").toBe(true);
});
