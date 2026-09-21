import config from "../vite.config.mjs";
export default {
  ...config,
  build: {
    ...config.build,
    outDir: "/Users/sign-x/.buzz/.scratch/notion-large-browser",
    rollupOptions: { input: "tests/large-document.html" },
  },
};
