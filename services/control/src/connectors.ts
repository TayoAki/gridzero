// Postgres and Snowflake queries, streamed as CSV (BUILD-SPEC M6). Credentials are
// decrypted only in this process; the workbook host receives nothing but the CSV.

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, createSign } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";

import postgres from "postgres";

import { env } from "./env.ts";

export type Kind = "postgres" | "snowflake";

export interface Config {
  host?: string;
  port?: number;
  database?: string;
  user: string;
  ssl?: "verify" | "require" | "disable";
  account?: string;
  warehouse?: string;
  schema?: string;
  role?: string;
  auth?: "password" | "key_pair";
}

/** Password, or PEM private key for Snowflake key-pair auth. */
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

async function postgresClient(config: Config, secret: Secret) {
  if (!config.host || !config.database) throw new Error("Host and database are required");
  const address = await publicAddress(config.host);
  const mode = config.ssl ?? "verify";
  const ssl = mode === "disable" ? false : { servername: isIP(config.host) ? undefined : config.host, rejectUnauthorized: mode === "verify" };
  return postgres({
    host: address,
    port: config.port ?? 5432,
    database: config.database,
    username: config.user,
    password: secret,
    ssl,
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    onnotice: () => {},
  });
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
    Authorization: `Bearer ${snowflakeJwt(config.account ?? "", config.user, secret)}`,
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

// --- entry points ------------------------------------------------------------

export async function runQuery(kind: Kind, config: Config, secret: Secret, sql: string, sink: Sink): Promise<void> {
  if (kind === "postgres") return postgresQuery(config, secret, sql, sink);
  await sink(config.auth === "key_pair" ? snowflakeKeyPair(config, secret, sql) : snowflakePassword(config, secret, sql));
}

/** Connect and run a trivial query; throws a readable error on failure. */
export async function testConnection(kind: Kind, config: Config, secret: Secret): Promise<void> {
  await runQuery(kind, config, secret, "select 1", async (rows) => {
    for await (const _ of rows) {
      /* drain */
    }
  });
}
