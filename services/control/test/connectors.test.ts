// Connector pieces that need no database. Snowflake, Databricks and BigQuery run
// against a stand-in server shaped like their documented APIs; none has been run
// against a real account. Redshift is covered by tests/e2e/m6.test.mjs.

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
      let parsed: any = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      requests.push({ url: req.url!, auth: String(req.headers.authorization ?? ""), body: parsed });
      const json = (o: unknown) => res.setHeader("Content-Type", "application/json").end(JSON.stringify(o));
      // Databricks: pending, then done with a second chunk.
      if (req.method === "POST" && req.url === "/api/2.0/sql/statements") return json({ statement_id: "s1", status: { state: "PENDING" } });
      if (req.url === "/api/2.0/sql/statements/s1") {
        return json({
          statement_id: "s1",
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [{ name: "ID" }, { name: "NAME" }] } },
          result: { data_array: [["1", "a,b"]], next_chunk_internal_link: "/api/2.0/sql/statements/s1/result/chunks/1" },
        });
      }
      if (req.url === "/api/2.0/sql/statements/s1/result/chunks/1") return json({ data_array: [["2", null]] });
      // Google: token, then a query that finishes on the first poll and has two pages.
      if (req.url === "/token") return json({ access_token: "gtok", expires_in: 3600 });
      const fields = [{ name: "n", type: "INTEGER" }, { name: "at", type: "TIMESTAMP" }, { name: "tags", type: "STRING", mode: "REPEATED" }];
      if (req.method === "POST" && req.url === "/bigquery/v2/projects/proj/queries") return json({ jobComplete: false, jobReference: { jobId: "j1", location: "US" } });
      if (req.url!.startsWith("/bigquery/v2/projects/proj/queries/j1?")) {
        const q = new URL(req.url!, "http://x").searchParams;
        if (q.get("pageToken") === "p2") return json({ jobComplete: true, schema: { fields }, rows: [{ f: [{ v: "2" }, { v: null }, { v: [] }] }] });
        return json({ jobComplete: true, schema: { fields }, rows: [{ f: [{ v: "1" }, { v: "1700000000123456" }, { v: [{ v: "x" }, { v: "y" }] }] }], pageToken: "p2" });
      }
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
  process.env.DATABRICKS_BASE_URL = base;
  process.env.BIGQUERY_BASE_URL = base;
  process.env.GOOGLE_TOKEN_URL = `${base}/token`;
});
after(() => server.close());

const load = () => import("../src/connectors.ts");
const collect = async (kind: "snowflake" | "databricks" | "bigquery", config: any, secret: string, sql = "select 1") => {
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

test("Databricks: waits for the statement and reads every chunk", async () => {
  const csv = await collect("databricks", { host: "ignored", warehouse: "wh1", database: "main", schema: "sales" }, "dapi-token", "select * from t;");
  assert.equal(csv, 'ID,NAME\n1,"a,b"\n2,\n');
  const start = requests.find((r) => r.url === "/api/2.0/sql/statements")!;
  assert.equal(start.auth, "Bearer dapi-token");
  assert.equal(start.body.statement, "select * from t");
  assert.equal(start.body.warehouse_id, "wh1");
  assert.equal(start.body.catalog, "main");
  assert.equal(start.body.disposition, "INLINE");
});

test("Databricks needs a warehouse", async () => {
  await assert.rejects(collect("databricks", { host: "x" }, "t"), /warehouse ID/);
});

test("BigQuery: service account sign-in, polling, pages and value formats", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), project_id: "proj", token_uri: "http://evil.example/token" });
  const csv = await collect("bigquery", { location: "US" }, key, "select 1");
  assert.equal(csv, 'n,at,tags\n1,2023-11-14T22:13:20.123456Z,"[""x"",""y""]"\n2,,[]\n');

  const token = requests.find((r) => r.url === "/token")!;
  const form = new URLSearchParams(token.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, p, s] = form.get("assertion")!.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s!, "base64url"));
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  assert.equal(claims.iss, "sa@proj.iam.gserviceaccount.com");
  assert.equal(claims.aud, `${base}/token`, "the key file's token_uri is ignored");

  const query = requests.find((r) => r.url === "/bigquery/v2/projects/proj/queries")!;
  assert.equal(query.auth, "Bearer gtok");
  assert.equal(query.body.useLegacySql, false);
  assert.equal(query.body.location, "US");
});

test("BigQuery rejects a key that is not a service account file", async () => {
  await assert.rejects(collect("bigquery", { project: "proj" }, "not json"), /key file/);
  await assert.rejects(collect("bigquery", { project: "proj" }, "{}"), /client_email/);
});

test("BigQuery timestamps before 1970 and nested records", async () => {
  const { bigqueryValue } = await load();
  assert.equal(bigqueryValue("-1", { type: "TIMESTAMP" }), "1969-12-31T23:59:59.999999Z");
  assert.equal(bigqueryValue("0", { type: "TIMESTAMP" }), "1970-01-01T00:00:00.000Z");
  assert.equal(bigqueryValue({ f: [{ v: "a" }, { v: [{ v: "1" }] }] }, { type: "RECORD" }), '["a",["1"]]');
  assert.equal(bigqueryValue(null, { type: "STRING" }), null);
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

test("a webhook address must be https and on the public internet", async () => {
  const { isPublicAddress, webhookProblem } = await import("../src/webhook.ts");
  for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "172.16.3.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
  assert.match((await webhookProblem("http://example.com/hook"))!, /https:\/\//);
  assert.match((await webhookProblem("https://user:pw@example.com/hook"))!, /user name/);
  assert.match((await webhookProblem("nonsense"))!, /https:\/\//);
  // An address that names our own network is refused whatever it is called.
  assert.match((await webhookProblem("https://127.0.0.1/hook"))!, /public internet/);
  assert.match((await webhookProblem("https://localhost/hook"))!, /public internet|could not be found/);
  assert.match((await webhookProblem("https://169.254.169.254/latest/meta-data"))!, /public internet/);
});
