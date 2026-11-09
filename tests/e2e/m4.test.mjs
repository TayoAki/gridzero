// M4 acceptance (BUILD-SPEC §11): convergence with concurrent editors, server-side
// viewer checks, restoring versions; plus invitations, links, copies and trash.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Stack, waitFor } from "./harness.mjs";

const stack = new Stack({ controlPort: 18987, wbhostPort: 18990 });

before(() => stack.start());
after(() => stack.stop());

/** Every cell of the first tiles of a sheet, as one comparable string. */
async function fingerprint(s, sheet = 0) {
  const tiles = [];
  for (let tr = 0; tr < 2; tr++) for (let tc = 0; tc < 2; tc++) tiles.push([tr, tc]);
  const r = await s.send({ type: "GetTiles", sheet, tiles });
  return JSON.stringify(r.tiles.map((t) => [...t.cells].sort((a, b) => a[0] - b[0]).map((c) => [c[0], c[1]])));
}

function randomEdit(rng) {
  const row = Math.floor(rng() * 50);
  const col = Math.floor(rng() * 10);
  const raw = rng() < 0.2 ? `=SUM(A1:A${1 + Math.floor(rng() * 50)})+${Math.floor(rng() * 9)}` : String(Math.floor(rng() * 1e6));
  return { type: "UpdateCell", sheet: 0, row, col, raw };
}

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `fn` as a newly signed-up person, with their own cookie. */
async function newUser(name) {
  const owner = stack.cookie;
  stack.cookie = "";
  const email = `${name}-${Date.now()}-${Math.random()}@example.com`;
  const res = await stack.api("POST", "/api/auth/sign-up/email", { name, email, password: "correct-horse-9" });
  assert.equal(res.status, 200);
  const cookie = stack.cookie;
  stack.cookie = owner;
  return { name, email, cookie };
}

async function as(user, fn) {
  const owner = stack.cookie;
  stack.cookie = user.cookie;
  try {
    return await fn();
  } finally {
    stack.cookie = owner;
  }
}

async function invite(id, user, role) {
  const res = await stack.api("PUT", `/api/v1/workbooks/${id}/shares`, { email: user.email, role });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.emailed, false, "no mail provider in tests");
  const token = body.inviteUrl.split("/invite/")[1];
  const accepted = await as(user, () => stack.api("POST", `/api/v1/invites/${token}/accept`));
  assert.equal(accepted.status, 200);
  return body.id;
}

test("three editors making 1,000 random edits each converge", { timeout: 300_000 }, async () => {
  const id = await stack.newWorkbook();
  const sessions = await Promise.all([stack.open(id), stack.open(id), stack.open(id)]);
  await Promise.all(
    sessions.map(async (s, i) => {
      const rng = mulberry(i + 1);
      // Each client keeps many edits in flight, so they interleave on the server.
      for (let batch = 0; batch < 100; batch++) {
        await Promise.all(Array.from({ length: 10 }, () => s.send(randomEdit(rng))));
      }
    }),
  );
  const prints = await Promise.all(sessions.map((s) => fingerprint(s)));
  assert.equal(prints[0], prints[1]);
  assert.equal(prints[1], prints[2]);
  assert.ok(prints[0].length > 1000, "the sheet has content");
  await Promise.all(sessions.map((s) => s.close()));

  // And the durable state is the same thing they all saw.
  await stack.restartWbhost();
  const reopened = await stack.open(id);
  assert.equal(await fingerprint(reopened), prints[0]);
  await reopened.close();
});

test("a viewer cannot change anything, and losing access closes the session", async () => {
  const id = await stack.newWorkbook();
  const viewer = await newUser("viewer");
  const shareId = await invite(id, viewer, "viewer");
  const s = await as(viewer, () => stack.open(id));
  assert.equal(s.state.role, "viewer");
  await assert.rejects(s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "1" }), /forbidden/);
  await assert.rejects(s.send({ type: "AddComment", sheet: 0, row: 0, col: 0, text: "hi" }), /forbidden/);
  await assert.rejects(s.send({ type: "RestoreVersion", seq: 0 }), /forbidden/);
  await assert.rejects(s.send({ type: "CreateVersion", name: "x" }), /forbidden/);
  assert.equal((await as(viewer, () => stack.api("PATCH", `/api/v1/workbooks/${id}`, { title: "mine" }))).status, 403);
  assert.equal((await as(viewer, () => stack.api("DELETE", `/api/v1/workbooks/${id}`))).status, 403);
  assert.equal((await as(viewer, () => stack.api("GET", `/api/v1/workbooks/${id}/shares`))).status, 403);
  // Shared workbooks are listed for the person they were shared with.
  const list = await (await as(viewer, () => stack.api("GET", "/api/v1/workbooks"))).json();
  assert.equal(list.workbooks.find((w) => w.id === id).role, "viewer");

  const closed = new Promise((r) => s.ws.addEventListener("close", r));
  assert.equal((await stack.api("DELETE", `/api/v1/workbooks/${id}/shares/${shareId}`)).status, 204);
  await closed;
  assert.equal((await as(viewer, () => stack.api("POST", `/api/v1/workbooks/${id}/open`))).status, 404);
});

test("invitations work once, and strangers need the link turned on", async () => {
  const id = await stack.newWorkbook();
  const invited = await newUser("invited");
  const res = await stack.api("PUT", `/api/v1/workbooks/${id}/shares`, { email: invited.email, role: "editor" });
  const token = (await res.json()).inviteUrl.split("/invite/")[1];
  assert.equal((await as(invited, () => stack.api("POST", `/api/v1/invites/${token}/accept`))).status, 200);
  assert.equal((await as(invited, () => stack.api("POST", `/api/v1/invites/${token}/accept`))).status, 404);
  const s = await as(invited, () => stack.open(id));
  assert.equal(s.state.role, "editor");
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "ok" });
  await s.close();

  const stranger = await newUser("stranger");
  assert.equal((await as(stranger, () => stack.api("POST", `/api/v1/workbooks/${id}/open`))).status, 404);
  assert.equal((await stack.api("PUT", `/api/v1/workbooks/${id}/link`, { linkAccess: "view", allowCopy: false })).status, 200);
  const grant = await (await as(stranger, () => stack.api("POST", `/api/v1/workbooks/${id}/open`))).json();
  assert.equal(grant.role, "viewer");
  assert.equal((await as(stranger, () => stack.api("POST", `/api/v1/workbooks/${id}/copy`))).status, 403);
});

test("restoring version N equals the state at N, for everyone, and survives a restart", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  const rng = mulberry(42);
  for (let i = 0; i < 40; i++) await s.send(randomEdit(rng));
  await s.send({ type: "AddComment", sheet: 0, row: 1, col: 1, text: "at N" });
  const at = await fingerprint(s);
  const versions = (await s.send({ type: "CreateVersion", name: "Checkpoint" })).list;
  const n = versions.find((v) => v.name === "Checkpoint").seq;

  for (let i = 0; i < 40; i++) await s.send(randomEdit(rng));
  const later = await fingerprint(s);
  assert.notEqual(later, at);

  // Preview is that version, read-only, and leaves the live workbook alone.
  const grant = await stack.grant(id);
  const preview = await stack.openUrl(`${grant.endpoint}?token=${grant.token}&version=${n}`);
  assert.equal(preview.state.role, "viewer");
  assert.equal(await fingerprint(preview), at);
  await assert.rejects(preview.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "9" }), /forbidden/);
  await preview.close();
  assert.equal(await fingerprint(s), later);

  const other = await stack.open(id);
  await s.send({ type: "RestoreVersion", seq: n });
  assert.equal(await fingerprint(s), at);
  assert.equal(await fingerprint(other), at);
  const meta = (await s.send({ type: "GetSheetMeta", sheet: 0 })).meta;
  assert.equal(meta.comments[0].text, "at N");

  // The state it replaced is in the history, and edits continue from the restore.
  const list = (await s.send({ type: "ListVersions" })).list;
  assert.ok(list.some((v) => v.name === `Restored from version ${n}`));
  assert.ok(list.some((v) => v.seq === n + 40));
  await s.send({ type: "UpdateCell", sheet: 0, row: 60, col: 0, raw: "after" });
  const final = await fingerprint(s);
  await s.close();
  await other.close();
  await stack.restartWbhost();
  const back = await stack.open(id);
  assert.equal(await fingerprint(back), final);
  await back.close();
});

test("presence reaches the others, and comment authors come from the server", async () => {
  const id = await stack.newWorkbook();
  const friend = await newUser("Friend");
  await invite(id, friend, "editor");
  const a = await stack.open(id);
  const b = await as(friend, () => stack.open(id));
  await waitFor(() => a.presence?.peers.length === 2, "both peers");
  await b.send({ type: "Presence", sheet: 0, selection: { sheet: 0, r0: 2, c0: 3, r1: 4, c1: 5 }, view: [0, 0], following: null });
  await waitFor(() => a.presence.peers.some((p) => p.name === "Friend" && p.selection?.r0 === 2), "their selection");
  await b.send({ type: "AddComment", sheet: 0, row: 0, col: 0, text: "hello", author: "Someone Else", at: 1 });
  const c = (await a.send({ type: "GetSheetMeta", sheet: 0 })).meta.comments[0];
  assert.equal(c.author, "Friend");
  assert.ok(c.at > 1);
  await b.close();
  await waitFor(() => a.presence.peers.length === 1, "peer left");
  await a.close();
});

test("copies are independent; the trash hides and restores a workbook", async () => {
  const id = await stack.newWorkbook();
  const s = await stack.open(id);
  await s.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "original" });
  const res = await stack.api("POST", `/api/v1/workbooks/${id}/copy`);
  assert.equal(res.status, 201);
  const copy = (await res.json()).id;
  const c = await stack.open(copy);
  const cell = await c.send({ type: "GetCell", sheet: 0, row: 0, col: 0 });
  assert.equal(cell.raw, "original");
  await c.send({ type: "UpdateCell", sheet: 0, row: 0, col: 0, raw: "changed" });
  assert.equal((await s.send({ type: "GetCell", sheet: 0, row: 0, col: 0 })).raw, "original");
  await c.close();
  await s.close();

  assert.equal((await stack.api("DELETE", `/api/v1/workbooks/${id}`)).status, 204);
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${id}/open`)).status, 404);
  const trash = await (await stack.api("GET", "/api/v1/workbooks/trash")).json();
  assert.ok(trash.workbooks.some((w) => w.id === id));
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${id}/restore`)).status, 200);
  assert.equal((await stack.api("POST", `/api/v1/workbooks/${id}/open`)).status, 200);
});
