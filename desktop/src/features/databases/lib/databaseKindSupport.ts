import { createDedicatedKindSupport } from "@/shared/lib/dedicatedKindSupport";

const schemaKindSupport = createDedicatedKindSupport(
  "databases:schema:dedicated-kind-rejected:",
);
const rowKindSupport = createDedicatedKindSupport(
  "databases:row:dedicated-kind-rejected:",
);

/** True while this relay's kind-30624 rejection verdict is fresh. */
export function databaseSchemaKindMarkedUnsupported(
  relayUrl: string,
  nowMs: number,
): boolean {
  return schemaKindSupport.markedUnsupported(relayUrl, nowMs);
}

/** Records an unknown-kind rejection for database schema events. */
export function markDatabaseSchemaKindRejected(
  relayUrl: string,
  nowMs: number,
): void {
  schemaKindSupport.markRejected(relayUrl, nowMs);
}

/** Clears the schema-kind rejection after a successful dedicated publish. */
export function markDatabaseSchemaKindAccepted(relayUrl: string): void {
  schemaKindSupport.markAccepted(relayUrl);
}

/** True while this relay's kind-30625 rejection verdict is fresh. */
export function databaseRowKindMarkedUnsupported(
  relayUrl: string,
  nowMs: number,
): boolean {
  return rowKindSupport.markedUnsupported(relayUrl, nowMs);
}

/** Records an unknown-kind rejection for database row events. */
export function markDatabaseRowKindRejected(
  relayUrl: string,
  nowMs: number,
): void {
  rowKindSupport.markRejected(relayUrl, nowMs);
}

/** Clears the row-kind rejection after a successful dedicated publish. */
export function markDatabaseRowKindAccepted(relayUrl: string): void {
  rowKindSupport.markAccepted(relayUrl);
}
