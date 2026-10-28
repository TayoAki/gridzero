function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  databaseUrl: required("DATABASE_URL"),
  authSecret: required("BETTER_AUTH_SECRET"),
  // Public origin the browser uses, e.g. https://staging.gridzero.app
  publicUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  // Built SPA to serve in deployed environments; unset in local dev (Vite serves it).
  webDist: process.env.WEB_DIST,
};
