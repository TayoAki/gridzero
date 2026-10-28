import { createAuthClient } from "better-auth/react";

// Same origin in every environment: Vite proxies /api in dev, the control plane serves the SPA when deployed.
export const authClient = createAuthClient({ baseURL: window.location.origin });
