-- Add ingest API key to org_subscriptions.
-- This key is used by enterprise customers to push usage events
-- to /api/v1/usage instead of exposing a pull endpoint.
ALTER TABLE org_subscriptions
  ADD COLUMN IF NOT EXISTS ingest_api_key text UNIQUE;
