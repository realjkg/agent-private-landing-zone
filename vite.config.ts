import { defineConfig } from "vite";

// The operator console's front-end build. Everything the browser loads is
// produced here and served by src/operator-ui/server.ts from
// dist/operator-ui/app — first-party assets only: no CDN references, no
// third-party origins, no runtime dependency on react (devDependency only).
export default defineConfig({
  root: "src/operator-ui/app",
  publicDir: "public",
  build: {
    outDir: "../../../dist/operator-ui/app",
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
  },
});
