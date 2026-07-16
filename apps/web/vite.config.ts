import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Hermes Office",
        short_name: "Hermes Office",
        description: "A visual control plane for Hermes Agent profiles.",
        theme_color: "#111821",
        background_color: "#111821",
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
