import * as React from "react";

import type {
  OpsArtifactSelection,
  loadOpsArtifactText,
} from "../artifactReader";
import type { OpsGlobalCollectionStates } from "../opsGlobalCollections";
import type {
  OpsOverviewCollectionLifecycle,
  OpsOverviewModule,
} from "../opsOverviewCollections";
import type { DormantOpsModuleName } from "../opsDormantContracts";
import type {
  OpsBridgeSnapshotV1,
  OpsModuleData,
  OpsModuleState,
} from "../types";
import { OpsArtifactReader } from "./OpsArtifactReader";

type GlobalState<Module extends DormantOpsModuleName> = NonNullable<
  OpsGlobalCollectionStates[Module]
>;
type OverviewState<Module extends OpsOverviewModule> =
  OpsOverviewCollectionLifecycle<Module>;
type AnySourceState =
  | { status: "contract_invalid" }
  | { status: "disconnected" }
  | { status: "not_requested" }
  | { status: "pending" }
  | { status: "retry_required"; refreshed: true }
  | { status: "unavailable" }
  | { status: "ready"; data?: unknown; items?: unknown[] };

function SourceState({
  children,
  empty,
  label,
  onRetry,
  state,
}: {
  children: React.ReactNode;
  empty: string;
  label: string;
  onRetry?: () => void;
  state: AnySourceState;
}) {
  if (state.status === "pending" || state.status === "not_requested") {
    return <p role="status">Loading {label.toLowerCase()}…</p>;
  }
  if (state.status === "unavailable") {
    return <p role="status">{label} is unavailable.</p>;
  }
  if (state.status === "disconnected") {
    return (
      <div role="status">
        <p>{label} is disconnected.</p>
        {onRetry ? (
          <button
            className="mt-2 min-h-11 rounded-lg border border-border px-3 text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRetry}
            type="button"
          >
            Retry {label}
          </button>
        ) : null}
      </div>
    );
  }
  if (state.status === "contract_invalid") {
    return <p role="alert">{label} contract is invalid.</p>;
  }
  if (state.status === "retry_required") {
    return (
      <div role="status">
        <p>{label} changed again. Retry required.</p>
        {onRetry ? (
          <button
            className="mt-2 min-h-11 rounded-lg border border-border px-3 text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRetry}
            type="button"
          >
            Retry {label}
          </button>
        ) : null}
      </div>
    );
  }
  const values = state.items ?? (Array.isArray(state.data) ? state.data : []);
  return values.length === 0 ? <p>{empty}</p> : children;
}

function Band({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <section aria-label={label} className="min-w-0 border-border border-t py-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </h2>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function Shell({
  children,
  eyebrow,
  title,
}: {
  children: React.ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-auto p-4 [overflow-wrap:anywhere] sm:p-6">
      <p className="font-mono text-2xs uppercase tracking-[0.18em] text-[#C8FF45]">
        {eyebrow}
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-5">{children}</div>
    </main>
  );
}

export function OpsKnowledgeView({
  evidence,
  loadArtifact,
  onRetryEvidence,
  onRetryResearch,
  research,
}: {
  evidence: GlobalState<"evidence">;
  loadArtifact?: typeof loadOpsArtifactText;
  onRetryEvidence?: () => void;
  onRetryResearch?: () => void;
  research: OverviewState<"research">;
}) {
  const [selected, setSelected] = React.useState<OpsArtifactSelection | null>(
    null,
  );
  const trigger = React.useRef<HTMLButtonElement>(null);
  const researchItems = research.status === "ready" ? research.items : [];
  const evidenceItems = evidence.status === "ready" ? evidence.items : [];
  return (
    <Shell eyebrow="Verified sources" title="Knowledge">
      <Band label="Research releases">
        <SourceState
          empty="No signed research releases."
          label="Research"
          onRetry={onRetryResearch}
          state={research}
        >
          <ul className="space-y-2">
            {researchItems.map((item) => (
              <li className="border-border border-l-2 pl-3" key={item.id}>
                <p className="font-medium text-foreground">{item.title}</p>
                <p className="text-xs">
                  {item.status} · {item.updated_at ?? "No observed time"}
                </p>
              </li>
            ))}
          </ul>
        </SourceState>
      </Band>
      <Band label="Evidence sources">
        <SourceState
          empty="No research evidence is available."
          label="Evidence"
          onRetry={onRetryEvidence}
          state={evidence}
        >
          <ul className="space-y-2">
            {evidenceItems.map((item) => (
              <li className="flex min-w-0 items-center gap-3" key={item.id}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{item.id}</p>
                  <p className="text-xs">
                    {item.kind} · {item.status} · {item.observed_at}
                  </p>
                </div>
                {item.artifact_id && item.artifact_version ? (
                  <button
                    className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    data-ops-interactive
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setSelected({
                        id: item.artifact_id as string,
                        kind: item.kind,
                        status: item.status,
                        title: item.id,
                        version: item.artifact_version as number,
                      });
                    }}
                    type="button"
                  >
                    Open evidence
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </SourceState>
      </Band>
      {selected ? (
        <OpsArtifactReader
          artifact={selected}
          loadArtifact={loadArtifact}
          onClose={() => setSelected(null)}
          returnFocus={trigger.current}
        />
      ) : null}
    </Shell>
  );
}

export function OpsConnectionsView({
  connections,
  health,
  onRetryRepositories,
  onRetrySessions,
  repositories,
  sessions,
}: {
  connections: OpsModuleState<OpsModuleData["connections"]>;
  health: OpsBridgeSnapshotV1["health"];
  onRetryRepositories?: () => void;
  onRetrySessions?: () => void;
  repositories: OverviewState<"repositories">;
  sessions: GlobalState<"sessions">;
}) {
  const repositoryItems =
    repositories.status === "ready" ? repositories.items : [];
  const sessionItems = sessions.status === "ready" ? sessions.items : [];
  return (
    <Shell eyebrow="Local source map" title="Connections">
      <Band label="Runtime health">
        <ul className="grid gap-2 sm:grid-cols-3">
          {Object.entries(health).map(([name, status]) => (
            <li className="border-border border-l-2 pl-3" key={name}>
              <p className="font-medium capitalize text-foreground">{name}</p>
              <p className="text-xs">{status}</p>
            </li>
          ))}
        </ul>
        {connections.status === "ready" && connections.data.length > 0 ? (
          connections.data.map((connection) => (
            <p key={connection.id}>
              <span className="text-foreground">{connection.name}</span> ·{" "}
              {connection.status}
            </p>
          ))
        ) : (
          <SourceState
            empty="No source connections."
            label="Connections"
            state={connections}
          >
            {null}
          </SourceState>
        )}
      </Band>
      <Band label="Local repositories">
        <SourceState
          empty="No repository observations."
          label="Repositories"
          onRetry={onRetryRepositories}
          state={repositories}
        >
          {repositoryItems.map((repository) => (
            <p key={repository.id}>
              <span className="font-medium text-foreground">
                {repository.name}
              </span>{" "}
              · {repository.branch} · {repository.clean ? "clean" : "changed"}
            </p>
          ))}
        </SourceState>
      </Band>
      <Band label="Session sources">
        <SourceState
          empty="No active session sources."
          label="Sessions"
          onRetry={onRetrySessions}
          state={sessions}
        >
          <p>{sessionItems.length} canonical session records</p>
        </SourceState>
      </Band>
      <Band label="Microsoft Teams">
        <p className="font-medium text-foreground">Microsoft Teams</p>
        <p>Not configured · read-only inbound activity only.</p>
      </Band>
    </Shell>
  );
}

function routeLabel(route: Record<string, unknown>, index: number): string {
  const from =
    typeof route.from === "string" ? route.from : `Route ${index + 1}`;
  const to = typeof route.to === "string" ? route.to : "unresolved";
  return `${from} → ${to}`;
}

export function OpsRoutingView({
  audit,
  onOpenWorkflows,
  onRetryAudit,
  workflowRouting,
}: {
  audit: GlobalState<"audit">;
  onOpenWorkflows?: () => void;
  onRetryAudit?: () => void;
  workflowRouting: OpsModuleState<OpsModuleData["workflow_routing"]>;
}) {
  const auditItems = audit.status === "ready" ? audit.items : [];
  return (
    <Shell eyebrow="Observed policy" title="Routing">
      <Band label="Workflow routing">
        {workflowRouting.status === "ready" ? (
          <>
            <p>Status · {workflowRouting.data.status}</p>
            {workflowRouting.data.routes.map((route, index) => (
              <p className="text-foreground" key={routeLabel(route, index)}>
                {routeLabel(route, index)}
              </p>
            ))}
          </>
        ) : (
          <SourceState
            empty="No routing projection."
            label="Workflow routing"
            state={workflowRouting}
          >
            {null}
          </SourceState>
        )}
        {onOpenWorkflows ? (
          <button
            className="min-h-11 rounded-lg border border-border px-3 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-ops-interactive
            onClick={onOpenWorkflows}
            type="button"
          >
            Open Workflows
          </button>
        ) : null}
      </Band>
      <Band label="Routing audit">
        <SourceState
          empty="No routing audit."
          label="Audit"
          onRetry={onRetryAudit}
          state={audit}
        >
          {auditItems.map((item) => (
            <p key={item.id}>{item.summary}</p>
          ))}
        </SourceState>
      </Band>
    </Shell>
  );
}

export function OpsSafetyView({
  approvals,
  audit,
  moduleStates,
  mutationsDisabled,
  onRetryApprovals,
  onRetryAudit,
}: {
  approvals: GlobalState<"approval_index">;
  audit: GlobalState<"audit">;
  moduleStates: Record<string, { status: string } | undefined>;
  mutationsDisabled: boolean;
  onRetryApprovals?: () => void;
  onRetryAudit?: () => void;
}) {
  const approvalItems = approvals.status === "ready" ? approvals.items : [];
  const auditItems = audit.status === "ready" ? audit.items : [];
  return (
    <Shell eyebrow="Fail-closed posture" title="Safety">
      <p className="mb-4 text-sm text-[#F2C45C]">
        {mutationsDisabled
          ? "Read-only safety boundary is active."
          : "Read-only policy view; no action controls are mounted."}
      </p>
      <Band label="Approval queue">
        <SourceState
          empty="No approvals are waiting."
          label="Approvals"
          onRetry={onRetryApprovals}
          state={approvals}
        >
          {approvalItems.map((item) => (
            <p key={item.id}>
              <span className="text-foreground">{item.status}</span> ·{" "}
              {item.action_kind} · {item.hold_reason ?? "No hold"}
            </p>
          ))}
        </SourceState>
      </Band>
      <Band label="Contract health">
        {Object.entries(moduleStates).map(([module, state]) => (
          <p key={module}>
            {module} · {state?.status ?? "unavailable"}
          </p>
        ))}
      </Band>
      <Band label="Safety audit">
        <SourceState
          empty="No safety audit."
          label="Audit"
          onRetry={onRetryAudit}
          state={audit}
        >
          {auditItems.map((item) => (
            <p key={item.id}>{item.summary}</p>
          ))}
        </SourceState>
      </Band>
    </Shell>
  );
}
