// Folders: a person's own filing of workbooks and reports.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Stack } from "./harness.mjs";

let stack, workbookId, boardId;
const json = (res) => res.json();

before(async () => {
  stack = new Stack({ controlPort: 8985, wbhostPort: 8986 });
  await stack.start();
  workbookId = (await json(await stack.api("POST", "/api/v1/workbooks"))).id;
  boardId = (await json(await stack.api("GET", "/api/v1/dashboards"))).dashboards[0].id;
});

after(() => stack?.stop());

test("a person makes folders and files workbooks and reports in them", async () => {
  assert.deepEqual(await json(await stack.api("GET", "/api/v1/folders")), { folders: [], items: [] });
  let res = await stack.api("POST", "/api/v1/folders", { name: "Client A" });
  assert.equal(res.status, 201);
  const a = (await res.json()).folder;
  const b = (await json(await stack.api("POST", "/api/v1/folders", { name: "Archive" }))).folder;
  assert.equal((await stack.api("POST", "/api/v1/folders", { name: "Client A" })).status, 409);
  for (const name of ["", " ", "x".repeat(61)]) assert.equal((await stack.api("POST", "/api/v1/folders", { name })).status, 400);

  assert.equal((await stack.api("PUT", "/api/v1/folders/place", { kind: "workbook", itemId: workbookId, folderId: a.id })).status, 200);
  assert.equal((await stack.api("PUT", "/api/v1/folders/place", { kind: "report", itemId: boardId, folderId: a.id })).status, 200);
  let got = await json(await stack.api("GET", "/api/v1/folders"));
  // Folders come back by name.
  assert.deepEqual(got.folders.map((f) => f.name), ["Archive", "Client A"]);
  assert.deepEqual(got.items.sort((x, y) => x.kind.localeCompare(y.kind)), [{ kind: "report", itemId: boardId, folderId: a.id }, { kind: "workbook", itemId: workbookId, folderId: a.id }]);

  // Filing again moves it; null takes it out.
  assert.equal((await stack.api("PUT", "/api/v1/folders/place", { kind: "workbook", itemId: workbookId, folderId: b.id })).status, 200);
  assert.equal((await stack.api("PUT", "/api/v1/folders/place", { kind: "report", itemId: boardId, folderId: null })).status, 200);
  got = await json(await stack.api("GET", "/api/v1/folders"));
  assert.deepEqual(got.items, [{ kind: "workbook", itemId: workbookId, folderId: b.id }]);

  assert.equal((await json(await stack.api("PATCH", `/api/v1/folders/${b.id}`, { name: "Old work" }))).folder.name, "Old work");
  assert.equal((await stack.api("PATCH", `/api/v1/folders/${b.id}`, { name: "Client A" })).status, 409);
  // Removing a folder keeps what was in it.
  assert.equal((await stack.api("DELETE", `/api/v1/folders/${b.id}`)).status, 204);
  got = await json(await stack.api("GET", "/api/v1/folders"));
  assert.deepEqual(got.items, []);
  assert.ok((await json(await stack.api("GET", "/api/v1/workbooks"))).workbooks.some((w) => w.id === workbookId));

  for (const body of [{ kind: "agent", itemId: "x", folderId: a.id }, { kind: "workbook", folderId: a.id }, { kind: "workbook", itemId: "NOPE", folderId: a.id }, { kind: "workbook", itemId: workbookId, folderId: "nope" }]) {
    assert.ok([400, 404].includes((await stack.api("PUT", "/api/v1/folders/place", body)).status), JSON.stringify(body));
  }
});

test("filing is each person's own, and nobody files what they cannot open", async () => {
  const other = new Stack({ controlPort: 8985, wbhostPort: 8986 });
  other.base = stack.base;
  assert.equal((await other.api("POST", "/api/auth/sign-up/email", { name: "Other", email: `other-${Date.now()}@example.com`, password: "correct-horse-9" })).status, 200);
  const theirs = (await json(await other.api("POST", "/api/v1/folders", { name: "Mine" }))).folder;
  // Someone else's workbook and report cannot be filed, nor anything filed in someone else's folder.
  assert.equal((await other.api("PUT", "/api/v1/folders/place", { kind: "workbook", itemId: workbookId, folderId: theirs.id })).status, 404);
  assert.equal((await other.api("PUT", "/api/v1/folders/place", { kind: "report", itemId: boardId, folderId: theirs.id })).status, 404);
  assert.equal((await stack.api("PUT", "/api/v1/folders/place", { kind: "workbook", itemId: workbookId, folderId: theirs.id })).status, 404);
  const mine = (await json(await stack.api("GET", "/api/v1/folders"))).folders;
  assert.equal((await other.api("DELETE", `/api/v1/folders/${mine[0].id}`)).status, 404);
  assert.equal((await other.api("PATCH", `/api/v1/folders/${mine[0].id}`, { name: "Taken" })).status, 404);
  assert.deepEqual((await json(await other.api("GET", "/api/v1/folders"))).folders.map((f) => f.name), ["Mine"]);
});
