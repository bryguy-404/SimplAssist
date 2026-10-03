import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Next keeps JSX for its own compiler. Vitest needs JSX lowered before
  // Vite's import-analysis pass when a test imports an async page component.
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
