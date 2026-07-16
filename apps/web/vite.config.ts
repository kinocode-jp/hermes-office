import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * The production build registers a precaching service worker on this origin.
 * When the dev server runs on the same port, that stale worker keeps serving
 * the old cached app. Serve a self-destroying /sw.js in dev so any previously
 * installed worker unregisters itself and reloads its clients.
 */
const devServiceWorkerReset: Plugin = {
  name: "dev-sw-self-destruct",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/sw.js", (_req, res) => {
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "no-store");
      res.end([
        "self.addEventListener('install', () => self.skipWaiting());",
        "self.addEventListener('activate', (event) => {",
        "  event.waitUntil(",
        "    caches.keys()",
        "      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))",
        "      .then(() => self.registration.unregister())",
        "      .then(() => self.clients.matchAll({ type: 'window' }))",
        "      .then((clients) => clients.forEach((client) => client.navigate(client.url)))",
        "  );",
        "});"
      ].join("\n"));
    });
  }
};

export default defineConfig({
  plugins: [
    devServiceWorkerReset,
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Hermes Office",
        short_name: "Hermes Office",
        description: "A visual control plane for Hermes Agent profiles.",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,svg,webp,woff2}"]
      }
    })
  ],
  server: {
    port: 4173,
    strictPort: true
  }
});
