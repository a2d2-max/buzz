import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// BlockSuite exports TypeScript source for bundlers and ships matching dist
// declarations. Check our integration against those public declarations,
// rather than recompiling vendor internals with the application's TS version.
const configPath = ts.findConfigFile(
  process.cwd(),
  ts.sys.fileExists,
  "tsconfig.json",
);
if (!configPath) throw Error("Missing editor tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error)
  throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  path.dirname(configPath),
);
const host = ts.createCompilerHost(parsed.options);
host.resolveModuleNames = (names, containingFile) =>
  names.map((name) => {
    const resolved = ts.resolveModuleName(
      name,
      containingFile,
      parsed.options,
      host,
    ).resolvedModule;
    if (!resolved) return undefined;
    if (
      !/\/node_modules\/@blocksuite\/[^/]+\/src\//.test(
        resolved.resolvedFileName,
      )
    )
      return resolved;
    const declaration = resolved.resolvedFileName
      .replace(/(\/node_modules\/@blocksuite\/[^/]+)\/src\//, "$1/dist/")
      .replace(/(?<!\.d)\.tsx?$/, ".d.ts");
    if (
      declaration !== resolved.resolvedFileName &&
      fs.existsSync(declaration)
    ) {
      return {
        ...resolved,
        resolvedFileName: declaration,
        extension: ts.Extension.Dts,
        isExternalLibraryImport: true,
      };
    }
    return resolved;
  });
const program = ts.createProgram(parsed.fileNames, parsed.options, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
}
