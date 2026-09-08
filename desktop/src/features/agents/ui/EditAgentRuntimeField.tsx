import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";

import { AddCustomHarnessDialog } from "./AddCustomHarnessDialog";
import {
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
  type PersonaDropdownOption,
} from "./agentConfigOptions";
import { PersonaDropdownField } from "./PersonaDropdownField";

/**
 * The "Provider" (runtime) dropdown of the agent edit dialog plus the custom
 * agent-command input it reveals. Pure presentation — every piece of state
 * and every handler lives in `AgentInstanceEditDialog`, which only hands
 * values down. Extracted verbatim from the dialog to keep it under the
 * file-size ratchet.
 */
export function EditAgentRuntimeField({
  agentCommand,
  disabled,
  isAddHarnessOpen,
  onAddHarnessOpenChange,
  onAgentCommandChange,
  onHarnessSaved,
  onValueChange,
  options,
  selectedRuntime,
  showAgentCommandInput,
  value,
}: {
  agentCommand: string;
  disabled: boolean;
  isAddHarnessOpen: boolean;
  onAddHarnessOpenChange: (open: boolean) => void;
  onAgentCommandChange: (value: string) => void;
  onHarnessSaved: (id: string) => void;
  onValueChange: (value: string) => void;
  options: readonly PersonaDropdownOption[];
  selectedRuntime: AcpRuntimeCatalogEntry | undefined;
  showAgentCommandInput: boolean;
  value: string;
}) {
  return (
    <>
      {/* Provider (runtime) */}
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="edit-agent-runtime"
        >
          Provider
        </label>
        <PersonaDropdownField
          disabled={disabled}
          id="edit-agent-runtime"
          onValueChange={onValueChange}
          options={options}
          placeholder="Choose a provider"
          value={value}
        />
        {selectedRuntime ? (
          <p className="text-xs text-muted-foreground">
            Detected at{" "}
            <span className="font-medium">
              {selectedRuntime.binaryPath ??
                selectedRuntime.command ??
                selectedRuntime.id}
            </span>
          </p>
        ) : null}
        <AddCustomHarnessDialog
          onOpenChange={onAddHarnessOpenChange}
          onSaved={onHarnessSaved}
          open={isAddHarnessOpen}
        />
      </div>
      {showAgentCommandInput ? (
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="edit-agent-command"
          >
            Agent command
          </label>
          <div
            className={cn(
              "flex min-h-11 items-center px-3",
              PERSONA_FIELD_SHELL_CLASS,
            )}
          >
            <Input
              autoCorrect="off"
              className={cn(
                "h-8 px-0 py-0 leading-6",
                PERSONA_FIELD_CONTROL_CLASS,
              )}
              disabled={disabled}
              id="edit-agent-command"
              onChange={(event) => onAgentCommandChange(event.target.value)}
              placeholder="Full path or shell command"
              value={agentCommand}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
