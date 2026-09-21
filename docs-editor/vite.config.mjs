import { defineConfig, transformWithEsbuild } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "blocksuite-typescript",
      enforce: "pre",
      async transform(code, id) {
        if (
          id.includes("/node_modules/") &&
          /\.tsx?$/.test(id) &&
          !id.endsWith(".css.ts") &&
          !id.endsWith(".d.ts")
        ) {
          return transformWithEsbuild(code, id, {
            loader: id.endsWith(".tsx") ? "tsx" : "ts",
            target: "es2022",
            // Match the class-field semantics required by BlockSuite's DI.
            tsconfigRaw: {
              compilerOptions: {
                experimentalDecorators: false,
                useDefineForClassFields: false,
              },
            },
          });
        }
      },
    },
    vanillaExtractPlugin(),
  ],
  optimizeDeps: { noDiscovery: true },
  build: {
    target: "es2022",
    outDir: "../desktop/public/docs-editor",
    emptyOutDir: true,
  },
});
