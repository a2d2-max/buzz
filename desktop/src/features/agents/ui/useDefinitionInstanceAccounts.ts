import * as React from "react";

import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { useManagedAgentsQuery } from "../hooks";
import {
  instancesOfPersona,
  personaInstanceAccountUpdate,
} from "./definitionInstanceAccounts";
import { useEditAgentAccountSelections } from "./EditAgentAccountFields";

export function useDefinitionInstanceAccounts({
  envVars,
  open,
  personaId,
  prospectiveRuntime,
}: {
  envVars: Readonly<Record<string, string>>;
  open: boolean;
  personaId: string | null;
  prospectiveRuntime: AcpRuntimeCatalogEntry | undefined;
}) {
  const agentsQuery = useManagedAgentsQuery({
    enabled: open && personaId !== null,
  });
  const instances = React.useMemo(
    () => instancesOfPersona(agentsQuery.data ?? [], personaId),
    [agentsQuery.data, personaId],
  );
  const lead = instances[0];
  const selections = useEditAgentAccountSelections({
    agent: {
      claudeAccountId: lead?.claudeAccountId ?? null,
      codexAccountId: lead?.codexAccountId ?? null,
    },
    envVars,
    open,
    prospectiveRuntime,
    resetKey: personaId ?? "",
  });

  return {
    instanceCount: instances.length,
    selections,
    update: personaId
      ? personaInstanceAccountUpdate(selections.submissions())
      : null,
  };
}
