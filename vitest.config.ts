import { defineConfig } from "vitest/config";

// Component/render tests for the operator console's React tree. Kept separate
// from vite.config.ts because the build root is the app directory while the
// tests live in the repository-root test/ folder. Node-side tests continue to
// run under `tsx --test` (npm run test:node); .tsx tests are excluded from
// that glob on purpose so no suite runs twice.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/*.test.tsx"],
  },
});
