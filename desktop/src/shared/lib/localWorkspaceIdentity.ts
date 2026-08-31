export const LOCAL_WORKSPACE_ID_STORAGE_KEY = "raou-local-workspace-id.v1";

type StoragePort = Pick<Storage, "getItem" | "setItem">;

type LocalWorkspaceIdentityService = {
  getId: () => string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createLocalWorkspaceIdentityService({
  createUuid,
  storage,
}: {
  createUuid: () => string;
  storage: StoragePort;
}): LocalWorkspaceIdentityService {
  let memoryId: string | null = null;

  return {
    getId() {
      try {
        const stored = storage.getItem(LOCAL_WORKSPACE_ID_STORAGE_KEY);
        if (stored && UUID_PATTERN.test(stored)) {
          memoryId = stored;
          return stored;
        }
      } catch {
        // Restricted webviews may deny storage reads. The in-memory identity
        // below keeps the shell usable and stable for the process lifetime.
      }

      if (memoryId) return memoryId;

      const next = createUuid();
      memoryId = next;
      try {
        storage.setItem(LOCAL_WORKSPACE_ID_STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; this identifier is local metadata, not a
        // credential, and must never gate startup.
      }
      return next;
    },
  };
}

const localWorkspaceIdentity = createLocalWorkspaceIdentityService({
  createUuid: () => crypto.randomUUID(),
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  },
});

export function getLocalWorkspaceId(): string {
  return localWorkspaceIdentity.getId();
}
