import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  test: {
    root: ".",
    include: ["test/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
