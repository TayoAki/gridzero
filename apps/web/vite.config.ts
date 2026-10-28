import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the control plane runs on :8787; in deployed environments it serves this build.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
