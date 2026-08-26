import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The dashboard ships as ONE self-contained HTML file: MCP hosts render it in
// a sandboxed iframe with deny-by-default CSP, so no external scripts, styles
// or fonts can load. Everything must be inlined.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    outDir: "dist",
    cssCodeSplit: false
  }
});
