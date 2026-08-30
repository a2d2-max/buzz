import { z } from "zod";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const publicId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u)
  .superRefine((value, ctx) => {
    if (!safePublic(value))
      ctx.addIssue({ code: "custom", message: "unsafe public id" });
  });
const sessionId = publicId.regex(
  /^(?:orca|codex_direct|codex_sub|claude_code):[A-Za-z0-9][A-Za-z0-9._-]*$/u,
);
const publicToken = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u);
const moduleToken = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]{0,63}$/u)
  .superRefine((value, ctx) => {
    if (!safePublic(value))
      ctx.addIssue({ code: "custom", message: "unsafe module name" });
  });
const safeInteger = z.number().int().min(0).max(MAX_SAFE);
const positiveInteger = safeInteger.min(1);
const count = safeInteger.max(10_000);
const nullableId = publicId.nullable();

function unsafeUnicode(value: string): boolean {
  return [...value].some((char) => {
    const point = char.codePointAt(0) ?? 0;
    return (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      (point >= 0x200b && point <= 0x200d) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069) ||
      point === 0xfeff ||
      (point >= 0xfdd0 && point <= 0xfdef) ||
      (point & 0xffff) === 0xfffe ||
      (point & 0xffff) === 0xffff
    );
  });
}

const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/giu;
const FILE_URI = /\bfile:\/\//iu;
const BIDI_OR_PATH_QUERY =
  /(?:^|[\\/])(?:\.{1,2})(?:[\\/]|$)|^(?:[\\/]|~[\\/]|[A-Za-z]:[\\/])|%2f|%5c/iu;
const CANONICAL_UNIX_ROOT =
  /\/(?:Users|etc|home|root|var|tmp|private|opt|System|Library|usr|bin|sbin)(?:[\\/]|$)/u;
const DELIMITED_ABSOLUTE_PATH =
  /(?:^|[\s=;:,()[\]{}"'`])[\\/](?:[^\s\\/]+(?:[\\/]|$))/u;
const TRAVERSAL_SEGMENT = /(?:^|[^A-Za-z0-9])\.\.[\\/]/u;
const WINDOWS_OR_UNC_PATH = /(?:^|[\s=;:,()[\]{}"'`])[A-Za-z]:[\\/]|\\\\/u;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/iu;
const PRIVATE_KEY =
  /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/giu;
const PRIVATE_KEY_UNCLOSED =
  /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*$/giu;
const ENV_ASSIGNMENT =
  /(["']?)\b((?:[A-Z0-9]+[_-])*(?:SECRET_ACCESS_KEY|SESSION_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_KEY|PRIVATE_KEY|API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL))\b\1(\s*[:=]\s*)(?!\[가림\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/giu;
const TOKEN_ASSIGNMENT =
  /(\btoken\s*[:=]\s*)(?!\[가림\])(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[A-Za-z0-9._~+/=-]{8,})/giu;
const SENSITIVE_HASH =
  /(^|[^A-Za-z0-9_])(["']?(?:capability[\s_-]*hash|launch[\s_-]*token[\s_-]*hash)["']?(?:\s*[:=]\s*|\s+)["']?)([0-9a-f]{64})(?![0-9a-f])(["']?)/gimu;
const INTERNAL_BLOCK_TAG =
  /<\/?(?:analysis|reasoning|thinking|goal[_-]?context|chain[_-]?of[_-]?thought|internal[_-]?reasoning)(?=[\s/>])/giu;
const CREDENTIAL_PATTERNS = [
  /(^|[^A-Za-z0-9])dcap_[A-Za-z0-9_-]{8,}/gu,
  /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
  /(^|[^A-Za-z0-9])(?:sk-(?:ant-)?|gh[pousr]_)[A-Za-z0-9_-]{8,}/gu,
  /(^|[^A-Za-z0-9])xox[a-z]-[A-Za-z0-9_-]{8,}/giu,
  /(^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{8,}/gu,
  /(^|[^A-Za-z0-9])xapp-[A-Za-z0-9-]{8,}/gu,
  /(^|[^A-Za-z0-9])AKIA[A-Z0-9]{16}($|[^A-Za-z0-9])/gu,
];

function matches(pattern: RegExp, value: string): boolean {
  return new RegExp(pattern.source, pattern.flags).test(value);
}

function pathLikePublicText(value: string): boolean {
  if (
    FILE_URI.test(value) ||
    BIDI_OR_PATH_QUERY.test(value) ||
    CANONICAL_UNIX_ROOT.test(value) ||
    TRAVERSAL_SEGMENT.test(value) ||
    WINDOWS_OR_UNC_PATH.test(value)
  )
    return true;
  return DELIMITED_ABSOLUTE_PATH.test(value.replace(URL_SPAN, ""));
}

function containsSensitiveText(value: string): boolean {
  return [
    PRIVATE_KEY,
    PRIVATE_KEY_UNCLOSED,
    ENV_ASSIGNMENT,
    TOKEN_ASSIGNMENT,
    SENSITIVE_HASH,
    INTERNAL_BLOCK_TAG,
    ...CREDENTIAL_PATTERNS,
  ].some((pattern) => matches(pattern, value));
}

function unsafePathOrCredential(value: string): boolean {
  return (
    pathLikePublicText(value) ||
    URL_USERINFO.test(value) ||
    containsSensitiveText(value)
  );
}

function safePublic(value: string): boolean {
  return (
    value === value.normalize("NFC") &&
    !unsafeUnicode(value) &&
    !unsafePathOrCredential(value)
  );
}

function publicText(maximum: number, required = true) {
  return z.string().superRefine((value, ctx) => {
    if (
      (required && [...value].length === 0) ||
      [...value].length > maximum ||
      !safePublic(value)
    ) {
      ctx.addIssue({ code: "custom", message: "unsafe public text" });
    }
  });
}

const searchQuery = publicText(100).refine(
  (value) => !value.includes("\uFFFD"),
  "replacement character is invalid query input",
);

/** Canonical UTC RFC3339 timestamp used by every Task 3 page DTO. */
export const utcTimestamp = z.string().superRefine((value, ctx) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(
      value,
    );
  const milliseconds = match ? `${match[7] ?? ""}000`.slice(0, 3) : "";
  const canonical = match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}Z`
    : "";
  const date = match ? new Date(canonical) : null;
  if (
    !match ||
    !date ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString() !== canonical
  ) {
    ctx.addIssue({ code: "custom", message: "UTC RFC3339 timestamp required" });
  }
});
const nullableTimestamp = z.union([z.null(), utcTimestamp]);

const unique = <T extends z.ZodType>(schema: T, maximum: number) =>
  z
    .array(schema)
    .max(maximum)
    .superRefine((items, ctx) => {
      if (new Set(items).size !== items.length)
        ctx.addIssue({ code: "custom", message: "unique values required" });
    });

/** Exact wire-open capability record. Unknown valid module names are intentionally retained for filtering by callers. */
export const dormantModuleCapabilitySchema = z
  .object({
    name: moduleToken,
    schema_version: z.literal(1),
    paged: z.boolean(),
    collection_revision: safeInteger.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.paged && value.collection_revision === undefined)
      ctx.addIssue({
        code: "custom",
        message: "paged module requires collection revision",
      });
  });

export const dormantPageItemSchemas = {
  work_items: z
    .object({
      id: publicId,
      project_id: publicId,
      title: publicText(280),
      status: z.enum([
        "candidate",
        "active",
        "waiting_approval",
        "blocked",
        "done",
        "failed",
        "archived",
      ]),
      progress: z.number().finite().min(0).max(1),
      last_activity_at: nullableTimestamp,
      session_count: count,
      approval_count: count,
      artifact_count: count,
    })
    .strict(),
  sessions: z
    .object({
      id: sessionId,
      source: z.enum(["orca", "codex_direct", "codex_sub", "claude_code"]),
      parent_session_id: sessionId.nullable(),
      work_item_id: nullableId,
      title: publicText(280),
      activity: z
        .enum([
          "working",
          "waiting_input",
          "idle",
          "done",
          "failed",
          "interrupted",
        ])
        .nullable(),
      health: z.enum([
        "live",
        "stale",
        "disconnected",
        "unknown",
        "context_unavailable",
        "conflicting",
      ]),
      last_activity_at: nullableTimestamp,
      child_count: count,
    })
    .strict()
    .superRefine((value, ctx) => {
      if (!value.id.startsWith(`${value.source}:`))
        ctx.addIssue({
          code: "custom",
          message: "session source must match id",
        });
    }),
  checklist_items: z
    .object({
      id: publicId,
      work_item_id: publicId,
      key: publicText(120),
      title: publicText(280),
      order: safeInteger.max(1_000_000),
      origin: z.enum(["instruction", "agent_plan", "user", "template"]),
      status: z.enum([
        "candidate",
        "todo",
        "in_progress",
        "claimed",
        "done",
        "blocked",
        "failed",
      ]),
      evidence_ids: unique(publicId, 64),
      claimed_by_session_id: sessionId.nullable(),
      claimed_at: nullableTimestamp,
      stage: publicText(80, false).nullable(),
      next_action: publicText(280, false).nullable(),
      depends_on: unique(publicId, 64),
      updated_at: utcTimestamp,
      revision: positiveInteger,
    })
    .strict(),
  decisions: z
    .object({
      id: publicId,
      work_item_id: nullableId,
      source: z.enum(["checklist", "approval", "message", "attention"]),
      source_id: publicId,
      title: publicText(280),
      question: publicText(280),
      options: unique(publicText(120), 16),
      needed_input: publicText(280, false).nullable(),
      impact: publicText(280, false).nullable(),
      queue: z.enum([
        "user_decision",
        "external_wait",
        "agent_autonomous",
        "needs_info",
      ]),
      status: z.enum(["open", "stale"]),
      updated_at: utcTimestamp,
      revision: positiveInteger,
    })
    .strict(),
  approval_index: z
    .object({
      id: publicId,
      work_item_id: publicId,
      action_kind: z.enum([
        "message",
        "provider_run",
        "provider_retry",
        "provider_interrupt",
      ]),
      status: z.enum([
        "draft",
        "pending_approval",
        "awaiting_risk_confirm",
        "approved",
        "delivering",
        "delivered",
        "delivery_unconfirmed",
        "delivery_failed",
        "executing",
        "executed",
        "execution_failed",
        "held",
        "rejected",
        "expired",
        "superseded",
      ]),
      hold_reason: publicText(280, false).nullable(),
      risk_class: unique(
        z.enum([
          "external_message",
          "file_delete",
          "session_stop",
          "git_destructive",
          "deploy",
          "dispatch_create",
          "unclassified_instruction",
        ]),
        7,
      ),
      updated_at: utcTimestamp,
      revision: positiveInteger,
    })
    .strict(),
  evidence: z
    .object({
      id: publicId,
      work_item_id: publicId,
      kind: z.enum([
        "exit_code",
        "test_report",
        "commit_sha",
        "artifact_path",
        "worker_done",
        "file_change",
      ]),
      status: z.enum(["verified", "unverified", "missing"]),
      observed_at: utcTimestamp,
      artifact_id: nullableId,
      artifact_version: positiveInteger.nullable(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if ((value.artifact_id === null) !== (value.artifact_version === null))
        ctx.addIssue({
          code: "custom",
          message: "artifact fields must be both null or both present",
        });
    }),
  audit: z
    .object({
      id: publicId,
      work_item_id: nullableId,
      kind: publicToken,
      summary: publicText(280),
      observed_at: utcTimestamp,
    })
    .strict(),
  search: z
    .object({
      id: publicId,
      kind: z.enum([
        "work_item",
        "session",
        "checklist_item",
        "decision",
        "approval",
        "evidence",
        "audit",
        "artifact",
        "repository",
        "research",
      ]),
      title: publicText(280),
      snippet: publicText(280),
      observed_at: utcTimestamp,
      work_item_id: nullableId,
    })
    .strict(),
} as const;

export type DormantOpsModuleName = keyof typeof dormantPageItemSchemas;
export type DormantOpsItemByModule = {
  [Module in DormantOpsModuleName]: z.infer<
    (typeof dormantPageItemSchemas)[Module]
  >;
};
export type DormantOpsPageRequest = z.infer<typeof dormantPageRequestSchema>;

const page = <Module extends DormantOpsModuleName, Scope extends z.ZodType>(
  module: Module,
  scope: Scope,
) =>
  z
    .object({
      module: z.literal(module),
      scope,
      page_size: z.number().int().min(1).max(200),
      cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict();
/** Closed Task 3 page requests passed to the native bridge. */
export const dormantPageRequestSchema = z.discriminatedUnion("module", [
  page(
    "work_items",
    z.object({ sort: z.literal("last_activity_at_desc") }).strict(),
  ),
  page(
    "sessions",
    z.object({ sort: z.literal("last_activity_at_desc") }).strict(),
  ),
  page(
    "checklist_items",
    z
      .object({ work_item: publicId, sort: z.literal("order_asc_then_id") })
      .strict(),
  ),
  page("decisions", z.object({ sort: z.literal("updated_at_desc") }).strict()),
  page(
    "approval_index",
    z.object({ sort: z.literal("updated_at_desc") }).strict(),
  ),
  page("evidence", z.object({ sort: z.literal("observed_at_desc") }).strict()),
  page("audit", z.object({ sort: z.literal("observed_at_desc") }).strict()),
  page(
    "search",
    z
      .object({
        q: searchQuery,
        kind: dormantPageItemSchemas.search.shape.kind.optional(),
        work: publicId.optional(),
        sort: z.literal("rank_desc_then_observed_at_desc"),
      })
      .strict(),
  ),
]);

/** Decodes one exact paged Task 3 response and binds checklist items to their request scope. */
export function parseDormantPage(
  value: unknown,
  module: DormantOpsModuleName,
  expectedRevision: number,
  scope: unknown,
) {
  const parsed = z
    .object({
      contract_version: z.literal(1),
      revision: safeInteger,
      generated_at: utcTimestamp,
      items: z.array(dormantPageItemSchemas[module]).max(200),
      next_cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success || parsed.data.revision !== expectedRevision) return null;
  if (module === "checklist_items") {
    const work = (scope as { work_item?: unknown }).work_item;
    if (
      typeof work !== "string" ||
      (parsed.data.items as Array<{ work_item_id: string }>).some(
        (item) => item.work_item_id !== work,
      )
    )
      return null;
  }
  return parsed.data;
}
