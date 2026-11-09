// Connector pieces that need no database. Snowflake runs against a stand-in server
// shaped like its documented API; it has not been run against a real account.

import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";

process.env.CONNECTION_SECRET_KEY ??= "test-only-key";
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.BETTER_AUTH_SECRET ??= "test-only-secret-0123456789abcdef0123";
process.env.WB_TOKEN_SECRET ??= "test-only-0123456789";

let server: Server;
let base = "";
const requests: { url: string; auth: string; body: any }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString();
      requests.push({ url: req.url!, auth: String(req.headers.authorization ?? ""), body: raw ? JSON.parse(raw) : null });
      const json = (o: unknown) => res.setHeader("Content-Type", "application/json").end(JSON.stringify(o));
      if (req.url!.startsWith("/session/v1/login-request")) return json({ success: true, data: { token: "tok" } });
      if (req.url!.startsWith("/queries/v1/query-request")) {
        return json({ success: true, data: { rowtype: [{ name: "A" }, { name: "B" }], rowset: [["1", "x,y"]], chunks: [{ url: `${base}/chunk` }], chunkHeaders: {} } });
      }
      if (req.url === "/chunk") return res.end(gzipSync('["2",null],["3","z"]'));
      if (req.url === "/api/v2/statements") return json({ code: "090001", statementHandle: "h", resultSetMetaData: { rowType: [{ name: "N" }], partitionInfo: [{}, {}] }, data: [["1"]] });
      if (req.url === "/api/v2/statements/h?partition=1") return json({ code: "090001", data: [["2"]] });
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
  process.env.SNOWFLAKE_BASE_URL = base;
});
after(() => server.close());

const load = () => import("../src/connectors.ts");
const collect = async (kind: "snowflake", config: any, secret: string, sql = "select 1") => {
  const { runQuery } = await load();
  let out = "";
  await runQuery(kind, config, secret, sql, async (rows) => {
    for await (const r of rows) out += r;
  });
  return out;
};

test("secrets round-trip and differ each time", async () => {
  const { encryptSecret, decryptSecret } = await load();
  const a = encryptSecret("hunter2");
  assert.notEqual(a, encryptSecret("hunter2"));
  assert.ok(!Buffer.from(a, "base64").includes("hunter2"));
  assert.equal(decryptSecret(a), "hunter2");
  const tampered = Buffer.from(a, "base64");
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => decryptSecret(tampered.toString("base64")));
});

test("private addresses are recognised", async () => {
  const { isPublicAddress } = await load();
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("CSV quoting", async () => {
  const { csvRow } = await load();
  assert.equal(csvRow(["a", 'b"c', "d,e", null, 1]), 'a,"b""c","d,e",,1\n');
});

test("Snowflake with a password: rows, chunks and nulls", async () => {
  const csv = await collect("snowflake", { user: "u", account: "acct", warehouse: "W" }, "pw");
  assert.equal(csv, 'A,B\n1,"x,y"\n2,\n3,z\n');
  const login = requests.find((r) => r.url.startsWith("/session"))!;
  assert.equal(login.body.data.PASSWORD, "pw");
  assert.ok(login.url.includes("warehouse=W"));
  assert.equal(requests.find((r) => r.url.startsWith("/queries"))!.auth, 'Snowflake Token="tok"');
});

test("Snowflake with a key pair: signed JWT and partitions", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const csv = await collect("snowflake", { user: "bob", account: "acme.us-east-1", auth: "key_pair" }, pem, "select n;");
  assert.equal(csv, "N\n1\n2\n");
  const call = requests.find((r) => r.url === "/api/v2/statements")!;
  assert.equal(call.body.statement, "select n");
  const [h, p, s] = call.auth.replace("Bearer ", "").split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s!, "base64url"));
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  assert.equal(claims.sub, "ACME.BOB");
  assert.match(claims.iss, /^ACME\.BOB\.SHA256:/);
});

test("cron schedules", async () => {
  const { nextRun } = await import("../src/connected.ts");
  const at = new Date("2026-03-02T10:07:30Z"); // a Monday
  assert.equal(nextRun("* * * * *", at)!.toISOString(), "2026-03-02T10:08:00.000Z");
  assert.equal(nextRun("*/15 * * * *", at)!.toISOString(), "2026-03-02T10:15:00.000Z");
  assert.equal(nextRun("0 6 * * *", at)!.toISOString(), "2026-03-03T06:00:00.000Z");
  assert.equal(nextRun("30 9 * * 5", at)!.toISOString(), "2026-03-06T09:30:00.000Z");
  assert.equal(nextRun("nonsense", at), null);
  assert.equal(nextRun("61 * * * *", at), null);
});
