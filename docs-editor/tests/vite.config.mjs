import config from "../vite.config.mjs";
export default {...config,build:{...config.build,outDir:process.env.A2D2_LINKED_DB_TEST_OUT ?? "../.scratch/linked-db-browser-build",rollupOptions:{input:"tests/linked-database.html"}}};
