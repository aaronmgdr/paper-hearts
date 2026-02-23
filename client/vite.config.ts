import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "child_process";

const gitHash = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "icons/*.png"],
      manifest: {
        name: "Paper Hearts",
        short_name: "Paper Hearts",
        description: "A private shared diary for couples",
        theme_color: "#FDF6EC",
        background_color: "#FDF6EC",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,woff2,wasm,png}"],
      },
    }),
  ],
  define: {
    __GIT_HASH__: JSON.stringify(gitHash),
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
