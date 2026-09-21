import * as React from "react";

import { compileDatabaseFormula } from "./databaseFormulaCompiler";
import type { DatabaseSchema } from "./databaseSchemaCodec";

const CLOCK_INTERVAL_MS = 60_000;

/** True when an accepted schema contains a clock-dependent formula. */
export function databaseSchemasUseFormulaClock(
  schemas: Iterable<DatabaseSchema>,
): boolean {
  for (const schema of schemas) {
    if (schema.deleted) continue;
    for (const property of schema.properties) {
      if (property.type !== "formula") continue;
      const compiled = compileDatabaseFormula(
        property.options.expression,
        schema.properties,
      );
      if (compiled.ok && compiled.compilation.usesNow) return true;
    }
  }
  return false;
}

/** Advances formula evaluation at a bounded minute cadence when needed. */
export function useDatabaseFormulaClock(
  schemas: ReadonlyMap<string, DatabaseSchema>,
): number {
  const usesClock = React.useMemo(
    () => databaseSchemasUseFormulaClock(schemas.values()),
    [schemas],
  );
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!usesClock) return undefined;
    setNowMs(Date.now());
    const interval = window.setInterval(
      () => setNowMs(Date.now()),
      CLOCK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [usesClock]);

  return nowMs;
}
