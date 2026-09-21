-- Durable, retryable projections from canonical A2D2 task events into a
-- replaceable Plane engine. A2D2 events remain authoritative. This schema
-- stores no API-key value: `api_key_env` names a server-side secret source.

CREATE TABLE engine_projection_bindings (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider = 'plane'),
    origin TEXT NOT NULL,
    workspace_slug TEXT NOT NULL CHECK (
        workspace_slug ~ '^[A-Za-z0-9_-]{1,48}$'
    ),
    project_id UUID NOT NULL,
    api_key_env TEXT NOT NULL CHECK (api_key_env ~ '^[A-Z][A-Z0-9_]{0,127}$'),
    state_map JSONB NOT NULL CHECK (
        jsonb_typeof(state_map) = 'object'
        AND state_map ?& ARRAY['todo', 'doing', 'done']
        AND state_map - ARRAY['todo', 'doing', 'done'] = '{}'::JSONB
        AND jsonb_typeof(state_map->'todo') = 'string'
        AND jsonb_typeof(state_map->'doing') = 'string'
        AND jsonb_typeof(state_map->'done') = 'string'
        AND state_map->>'todo' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND state_map->>'doing' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND state_map->>'done' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, id),
    UNIQUE (community_id, provider)
);

CREATE TABLE engine_principal_mappings (
    community_id UUID NOT NULL,
    binding_id UUID NOT NULL,
    a2d2_pubkey BYTEA NOT NULL CHECK (octet_length(a2d2_pubkey) = 32),
    engine_user_id UUID NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, binding_id, a2d2_pubkey),
    UNIQUE (community_id, binding_id, engine_user_id),
    FOREIGN KEY (community_id, binding_id)
        REFERENCES engine_projection_bindings(community_id, id) ON DELETE CASCADE
);

CREATE TABLE engine_projection_heads (
    community_id UUID NOT NULL,
    binding_id UUID NOT NULL,
    entity_kind TEXT NOT NULL CHECK (entity_kind = 'community_task'),
    entity_key TEXT NOT NULL CHECK (length(entity_key) BETWEEN 1 AND 512),
    task_d_tag TEXT NOT NULL,
    author_pubkey BYTEA NOT NULL CHECK (octet_length(author_pubkey) = 32),
    desired_event_id BYTEA NOT NULL CHECK (octet_length(desired_event_id) = 32),
    desired_generation BIGINT NOT NULL CHECK (desired_generation >= 1),
    applied_event_id BYTEA CHECK (
        applied_event_id IS NULL OR octet_length(applied_event_id) = 32
    ),
    applied_generation BIGINT NOT NULL DEFAULT 0 CHECK (
        applied_generation >= 0 AND applied_generation <= desired_generation
    ),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 4096),
    engine_entity_id UUID,
    create_state TEXT NOT NULL DEFAULT 'safe' CHECK (
        create_state IN ('safe', 'uncertain')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, binding_id, entity_kind, entity_key),
    FOREIGN KEY (community_id, binding_id)
        REFERENCES engine_projection_bindings(community_id, id) ON DELETE CASCADE,
    CHECK (
        (lease_token IS NULL AND lease_expires_at IS NULL)
        OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX idx_engine_projection_heads_pending
    ON engine_projection_heads (community_id, next_attempt_at, updated_at)
    WHERE desired_generation > applied_generation;

CREATE INDEX engine_projection_heads_reconcile_idx
    ON engine_projection_heads (
        community_id, binding_id, next_attempt_at, updated_at, entity_kind, entity_key
    )
    WHERE desired_generation > 0;

CREATE INDEX idx_engine_projection_heads_engine_entity
    ON engine_projection_heads (community_id, binding_id, engine_entity_id)
    WHERE engine_entity_id IS NOT NULL;
