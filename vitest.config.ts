import { defineConfig } from "vitest/config";

// Ink components are TSX; use the automatic JSX runtime so tests need no React import.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: { environment: "node" },
});
