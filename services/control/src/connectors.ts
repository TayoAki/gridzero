// Warehouse queries (Postgres, Redshift, Snowflake, Databricks, BigQuery), streamed as
// CSV (BUILD-SPEC M6). Credentials are decrypted only in this process; the workbook
// host receives nothing but the CSV.

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, createSign } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";

import postgres from "postgres";

import { env } from "./env.ts";

export const KINDS = ["postgres", "redshift", "snowflake", "databricks", "bigquery"] as const;
export type Kind = (typeof KINDS)[number];

/** Kinds that sign in with a user name (the others use a token or a key file). */
export const NEEDS_USER: readonly Kind[] = ["postgres", "redshift", "snowflake"];

export interface Config {
  /** Postgres and Redshift server, or the Databricks workspace host. */
  host?: string;
  port?: number;
  /** Database; the catalog for Databricks. */
  database?: string;
  user?: string;
  ssl?: "verify" | "require" | "disable";
  account?: string;
  warehouse?: string;
  schema?: string;
  role?: string;
  auth?: "password" | "key_pair";
  /** BigQuery project to run queries in (defaults to the key's own project). */
  project?: string;
  /** BigQuery location, such as US or europe-west2. */
  location?: string;
}

/**
 * Password; PEM private key for Snowflake key-pair auth; access token for Databricks;
 * service account key (JSON) for BigQuery.
 */
export type Secret = string;

// --- secrets -----------------------------------------------------------------

function secretKey(): Buffer {
  if (!env.connectionSecretKey) throw new Error("Connections are not set up on this server (CONNECTION_SECRET_KEY is missing)");
  return createHash("sha256").update(env.connectionSecretKey).digest();
}

export const secretsConfigured = () => !!env.connectionSecretKey;

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSecret(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// --- network safety ----------------------------------------------------------

function isPublicV4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)));
}

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPublicV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicV4(mapped[1]!);
  return !(v6 === "::" || v6 === "::1" || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("ff"));
}

/** Resolve once and connect to that address, so DNS cannot change the answer later. */
async function publicAddress(host: string): Promise<string> {
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error(`Could not find ${host}`);
  if (!env.connectorAllowPrivate && !addresses.every((a) => isPublicAddress(a.address))) {
    throw new Error("That host is on a private network, which GridZero cannot reach");
  }
  return addresses[0]!.address;
}

// --- CSV ---------------------------------------------------------------------

export function csvRow(values: readonly unknown[]): string {
  return (
    values
      .map((v) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(",") + "\n"
  );
}

function cleanSql(sql: string): string {
  const q = sql.trim().replace(/;\s*$/, "");
  if (!q) throw new Error("Enter a query");
  return q;
}

export type Sink = (csv: AsyncIterable<Uint8Array | string>) => Promise<void>;

// --- Postgres ----------------------------------------------------------------

async function postgresClient(config: Config, secret: Secret, redshift = false) {
  if (!config.host || !config.database) throw new Error("Host and database are required");
  const address = await publicAddress(config.host);
  const mode = config.ssl ?? "verify";
  const ssl = mode === "disable" ? false : { servername: isIP(config.host) ? undefined : config.host, rejectUnauthorized: mode === "verify" };
  return postgres({
    host: address,
    port: config.port ?? (redshift ? 5439 : 5432),
    database: config.database,
    username: config.user,
    password: secret,
    ssl,
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    onnotice: () => {},
    // Redshift's catalog lacks what the type lookup and prepared statements expect.
    ...(redshift ? { fetch_types: false, prepare: false } : {}),
  });
}

/** A Postgres value as spreadsheet text. */
function pgValue(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString("hex")}`;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

/**
 * Redshift has no COPY … TO STDOUT, so rows come through a cursor instead. Also used by
 * the tests against plain Postgres.
 */
async function redshiftQuery(config: Config, secret: Secret, sql: string, sink: Sink): Promise<void> {
  const client = await postgresClient(config, secret, true);
  try {
    await client.begin("read only", async (tx) => {
      await tx.unsafe("set statement_timeout to 900000");
      const query = cleanSql(sql);
      const described = await tx.unsafe(query).describe();
      const names = described.columns.map((c: { name: string }) => c.name);
      async function* rows(): AsyncGenerator<string> {
        yield csvRow(names);
        for await (const batch of tx.unsafe(query).cursor(2000)) {
          for (const row of batch) yield csvRow(names.map((n: string) => pgValue((row as Record<string, unknown>)[n])));
        }
      }
      await sink(rows());
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Run a query read-only, handing its rows to `sink` as CSV. */
async function postgresQuery(config: Config, secret: Secret, sql: string, sink: Sink): Promise<void> {
  const client = await postgresClient(config, secret);
  try {
    await client.begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '15min'");
      const stream = await tx.unsafe(`copy (${cleanSql(sql)}) to stdout with (format csv, header true)`).readable();
      await sink(stream as unknown as AsyncIterable<Uint8Array>);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * What Postgres expects a query to cost, without running it: the planner's row estimate and total cost
 * (docs/specs/DEFINITIONS-SPEC.md §9.3). Read-only, like every other query here.
 */
export async function postgresEstimate(config: Config, secret: Secret, sql: string): Promise<{ rows: number; cost: number }> {
  const client = await postgresClient(config, secret);
  try {
    return await client.begin("read only", async (tx) => {
      const out = await tx.unsafe(`explain (format json) ${cleanSql(sql)}`);
      const plan = (Object.values(out[0] ?? {})[0] as { Plan?: Record<string, number> }[] | undefined)?.[0]?.Plan ?? {};
      return { rows: Math.round(plan["Plan Rows"] ?? 0), cost: Math.round(plan["Total Cost"] ?? 0) };
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

// --- Snowflake ---------------------------------------------------------------

function snowflakeBase(config: Config): string {
  if (env.snowflakeBaseUrl) return env.snowflakeBaseUrl;
  if (!config.account || !/^[A-Za-z0-9_.-]+$/.test(config.account)) throw new Error("Enter your Snowflake account identifier");
  return `https://${config.account}.snowflakecomputing.com`;
}

async function checked(res: Response): Promise<Record<string, any>> {
  const text = await res.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Snowflake answered ${res.status}`);
  }
  if (!res.ok || body.success === false) throw new Error(body.message ?? `Snowflake answered ${res.status}`);
  return body;
}

/** The JWT Snowflake's SQL API takes for key-pair auth. */
export function snowflakeJwt(account: string, user: string, pem: string, now = Math.floor(Date.now() / 1000)): string {
  const key = createPrivateKey(pem);
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(der).digest("base64");
  const qualified = `${account.split(".")[0]!.toUpperCase()}.${user.toUpperCase()}`;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: `${qualified}.SHA256:${fingerprint}`, sub: qualified, iat: now, exp: now + 3600 })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;
}

async function* snowflakeKeyPair(config: Config, secret: Secret, sql: string): AsyncGenerator<string> {
  const base = snowflakeBase(config);
  const headers = {
    Authorization: `Bearer ${snowflakeJwt(config.account ?? "", config.user ?? "", secret)}`,
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const start = await fetch(`${base}/api/v2/statements`, {
    method: "POST",
    headers,
    body: JSON.stringify({ statement: cleanSql(sql), warehouse: config.warehouse, database: config.database, schema: config.schema, role: config.role, timeout: 900 }),
  });
  let body = await checked(start);
  // 333334: still running.
  for (let waited = 0; body.code === "333334"; waited++) {
    if (waited > 900) throw new Error("The Snowflake query took too long");
    await new Promise((r) => setTimeout(r, 1000));
    body = await checked(await fetch(`${base}/api/v2/statements/${body.statementHandle}`, { headers }));
  }
  const meta = body.resultSetMetaData;
  yield csvRow(meta.rowType.map((c: { name: string }) => c.name));
  for (const row of body.data ?? []) yield csvRow(row);
  for (let partition = 1; partition < (meta.partitionInfo?.length ?? 1); partition++) {
    const next = await checked(await fetch(`${base}/api/v2/statements/${body.statementHandle}?partition=${partition}`, { headers }));
    for (const row of next.data ?? []) yield csvRow(row);
  }
}

async function* snowflakePassword(config: Config, secret: Secret, sql: string): AsyncGenerator<string> {
  const base = snowflakeBase(config);
  const params = new URLSearchParams();
  for (const [k, v] of [["warehouse", config.warehouse], ["databaseName", config.database], ["schemaName", config.schema], ["roleName", config.role]] as const) {
    if (v) params.set(k, v);
  }
  const login = await checked(
    await fetch(`${base}/session/v1/login-request?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        data: {
          ACCOUNT_NAME: config.account,
          LOGIN_NAME: config.user,
          PASSWORD: secret,
          CLIENT_APP_ID: "GridZero",
          CLIENT_APP_VERSION: "1.0",
          SESSION_PARAMETERS: { JDBC_QUERY_RESULT_FORMAT: "JSON", PYTHON_CONNECTOR_QUERY_RESULT_FORMAT: "JSON" },
        },
      }),
    }),
  );
  const auth = { Authorization: `Snowflake Token="${login.data.token}"`, "Content-Type": "application/json", Accept: "application/snowflake" };
  const result = await checked(
    await fetch(`${base}/queries/v1/query-request?requestId=${randomUUID()}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ sqlText: cleanSql(sql), asyncExec: false, sequenceId: 1, querySubmissionTime: Date.now() }),
    }),
  );
  const data = result.data;
  yield csvRow(data.rowtype.map((c: { name: string }) => c.name));
  for (const row of data.rowset ?? []) yield csvRow(row);
  for (const chunk of data.chunks ?? []) {
    // Chunks hold rows without the enclosing brackets, and may be gzipped.
    const res = await fetch(chunk.url, { headers: data.chunkHeaders ?? {} });
    if (!res.ok) throw new Error(`Snowflake answered ${res.status} for a result chunk`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
    for (const row of JSON.parse(`[${text}]`)) yield csvRow(row);
  }
}

// --- Databricks --------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse a JSON API answer, turning failures into a readable error. */
async function apiJson(res: Response, service: string): Promise<Record<string, any>> {
  const text = await res.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${service} answered ${res.status}`);
  }
  if (!res.ok) throw new Error(body.message ?? body.error?.message ?? body.error_description ?? `${service} answered ${res.status}`);
  return body;
}

async function databricksBase(config: Config): Promise<string> {
  if (env.databricksBaseUrl) return env.databricksBaseUrl;
  const host = (config.host ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error("Enter your Databricks workspace host, such as dbc-1234.cloud.databricks.com");
  await publicAddress(host);
  return `https://${host}`;
}

/** The SQL Statement Execution API, with results inline (up to 25 MB). */
async function* databricks(config: Config, token: Secret, sql: string): AsyncGenerator<string> {
  if (!config.warehouse) throw new Error("Enter the SQL warehouse ID");
  const base = await databricksBase(config);
  const headers = { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json", Accept: "application/json" };
  let body = await apiJson(
    await fetch(`${base}/api/2.0/sql/statements`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        statement: cleanSql(sql),
        warehouse_id: config.warehouse,
        catalog: config.database,
        schema: config.schema,
        disposition: "INLINE",
        format: "JSON_ARRAY",
        wait_timeout: "30s",
        on_wait_timeout: "CONTINUE",
      }),
    }),
    "Databricks",
  );
  for (let waited = 0; ["PENDING", "RUNNING"].includes(body.status?.state); waited++) {
    if (waited > 450) throw new Error("The Databricks query took too long");
    await sleep(2000);
    body = await apiJson(await fetch(`${base}/api/2.0/sql/statements/${encodeURIComponent(body.statement_id)}`, { headers }), "Databricks");
  }
  if (body.status?.state !== "SUCCEEDED") throw new Error(body.status?.error?.message ?? `The Databricks query ended as ${body.status?.state ?? "unknown"}`);
  if (body.manifest?.truncated) throw new Error("The result is over Databricks' 25 MB limit for direct results; narrow the query");
  yield csvRow((body.manifest?.schema?.columns ?? []).map((c: { name: string }) => c.name));
  let result = body.result;
  while (result) {
    for (const row of result.data_array ?? []) yield csvRow(row);
    const next = result.next_chunk_internal_link;
    if (!next) break;
    if (typeof next !== "string" || !next.startsWith("/api/2.0/sql/statements/")) throw new Error("Databricks returned an unexpected result link");
    result = await apiJson(await fetch(`${base}${next}`, { headers }), "Databricks");
  }
}

// --- BigQuery ----------------------------------------------------------------

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function serviceAccount(secret: Secret): ServiceAccount {
  let key: Partial<ServiceAccount>;
  try {
    key = JSON.parse(secret);
  } catch {
    throw new Error("Paste the service account key file (JSON)");
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") throw new Error("The key file needs client_email and private_key");
  return key as ServiceAccount;
}

/** Trade a signed service-account JWT for an access token (the token URL is fixed, not the key file's). */
async function googleToken(key: ServiceAccount, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const tokenUrl = env.googleTokenUrl ?? "https://oauth2.googleapis.com/token";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope: "https://www.googleapis.com/auth/bigquery", aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(key.private_key), "base64url")}`;
  const body = await apiJson(
    await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    }),
    "Google sign-in",
  );
  if (typeof body.access_token !== "string") throw new Error("Google sign-in returned no access token");
  return body.access_token;
}

/** A BigQuery cell as spreadsheet text: timestamps as ISO, records and arrays as JSON. */
export function bigqueryValue(v: unknown, field: { type?: string; mode?: string } | undefined): unknown {
  if (v === null || v === undefined) return null;
  const plain = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map((e) => plain((e as { v: unknown }).v));
    if (x && typeof x === "object" && Array.isArray((x as { f?: unknown }).f)) return (x as { f: { v: unknown }[] }).f.map((c) => plain(c.v));
    return x;
  };
  if (typeof v === "object") return JSON.stringify(plain(v));
  if (field?.type === "TIMESTAMP" && typeof v === "string" && /^-?\d+$/.test(v)) {
    // Microseconds since 1970; keep all six decimal places when there are any.
    const micros = BigInt(v);
    let millis = micros / 1000n;
    let rest = micros % 1000n;
    if (rest < 0n) {
      rest += 1000n;
      millis -= 1n;
    }
    const iso = new Date(Number(millis)).toISOString();
    return rest === 0n ? iso : iso.replace("Z", `${String(rest).padStart(3, "0")}Z`);
  }
  return v;
}

async function* bigquery(config: Config, secret: Secret, sql: string): AsyncGenerator<string> {
  const key = serviceAccount(secret);
  const project = config.project || key.project_id;
  if (!project || !/^[A-Za-z0-9.:_-]+$/.test(project)) throw new Error("Enter the BigQuery project ID");
  const base = env.bigqueryBaseUrl ?? "https://bigquery.googleapis.com";
  const headers = { Authorization: `Bearer ${await googleToken(key)}`, "Content-Type": "application/json", Accept: "application/json" };
  const jobs = `${base}/bigquery/v2/projects/${encodeURIComponent(project)}/queries`;
  let body = await apiJson(
    await fetch(jobs, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: cleanSql(sql), useLegacySql: false, location: config.location || undefined, timeoutMs: 10_000, maxResults: 10_000, formatOptions: { useInt64Timestamp: true } }),
    }),
    "BigQuery",
  );
  const job = body.jobReference ?? {};
  const page = async (pageToken?: string) => {
    const params = new URLSearchParams({ timeoutMs: "10000", maxResults: "10000", "formatOptions.useInt64Timestamp": "true" });
    if (job.location) params.set("location", job.location);
    if (pageToken) params.set("pageToken", pageToken);
    return apiJson(await fetch(`${jobs}/${encodeURIComponent(job.jobId)}?${params}`, { headers }), "BigQuery");
  };
  // Each wait is up to 10 s on Google's side: about 15 minutes in all.
  for (let waited = 0; !body.jobComplete; waited++) {
    if (waited > 90) throw new Error("The BigQuery query took too long");
    body = await page();
  }
  const fields: { name: string; type?: string; mode?: string }[] = body.schema?.fields ?? [];
  yield csvRow(fields.map((f) => f.name));
  for (;;) {
    for (const row of body.rows ?? []) yield csvRow((row.f as { v: unknown }[]).map((c, i) => bigqueryValue(c.v, fields[i])));
    if (!body.pageToken) break;
    body = await page(body.pageToken);
  }
}

// --- entry points ------------------------------------------------------------

export async function runQuery(kind: Kind, config: Config, secret: Secret, sql: string, sink: Sink): Promise<void> {
  switch (kind) {
    case "postgres":
      return postgresQuery(config, secret, sql, sink);
    case "redshift":
      return redshiftQuery(config, secret, sql, sink);
    case "snowflake":
      return sink(config.auth === "key_pair" ? snowflakeKeyPair(config, secret, sql) : snowflakePassword(config, secret, sql));
    case "databricks":
      return sink(databricks(config, secret, sql));
    case "bigquery":
      return sink(bigquery(config, secret, sql));
  }
}

/** Connect and run a trivial query; throws a readable error on failure. */
export async function testConnection(kind: Kind, config: Config, secret: Secret): Promise<void> {
  await runQuery(kind, config, secret, "select 1", async (rows) => {
    for await (const _ of rows) {
      /* drain */
    }
  });
}
