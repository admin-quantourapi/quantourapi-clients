-- Read-only key scope (2026-09-10): view-layer keys for agents/advisors.
-- TRUE when the linked quantourApiKey resolved as read-only via /v1/ping at
-- link time; gates every local portfolio write in client_api. NULL on legacy
-- rows = treated as false (full access).
ALTER TABLE settings ADD `key_read_only` INTEGER;
