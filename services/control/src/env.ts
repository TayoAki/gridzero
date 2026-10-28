function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required("DATABASE_URL"),
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
  authSecret: required("BETTER_AUTH_SECRET"),
  // Public origin the browser uses, e.g. https://staging.gridzero.app
  publicUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  // Built SPA to serve in deployed environments; unset in local dev (Vite serves it).
  webDist: process.env.WEB_DIST,
  // Shared with wbhost: signs the short-lived routing tokens that open a workbook socket.
  wbTokenSecret: required("WB_TOKEN_SECRET"),
  // Base URL browsers use to reach wbhost, e.g. wss://wbhost-staging.up.railway.app
  wbhostUrl: process.env.WBHOST_PUBLIC_URL ?? "ws://localhost:8790",
};
