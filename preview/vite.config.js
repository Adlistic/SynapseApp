// Browser preview harness: runs the real Synapse frontend in a normal browser
// with the Tauri APIs replaced by mocks that serve a parsed transcript fixture.
// For design work only — never part of the app build.
//   SYN_FIXTURE=<path to messages.json> npx vite --config preview/vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const m = (f) => path.join(here, "mock", f);

export default defineConfig({
  root: path.join(here, ".."),
  plugins: [
    react(),
    {
      name: "syn-fixture",
      configureServer(server) {
        server.middlewares.use("/__agent.json", (_req, res) => {
          const p = process.env.SYN_AGENT;
          res.setHeader("content-type", "application/json");
          res.end(p && fs.existsSync(p) ? fs.readFileSync(p) : "[]");
        });
        server.middlewares.use("/__fixture.json", (_req, res) => {
          const p = process.env.SYN_FIXTURE;
          res.setHeader("content-type", "application/json");
          res.end(p && fs.existsSync(p) ? fs.readFileSync(p) : "[]");
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@tauri-apps/api/core": m("core.js"),
      "@tauri-apps/api/event": m("event.js"),
      "@tauri-apps/api/app": m("app.js"),
      "@tauri-apps/plugin-dialog": m("dialog.js"),
      "@tauri-apps/plugin-notification": m("notification.js"),
    },
  },
  server: { port: 1431, strictPort: true },
});
