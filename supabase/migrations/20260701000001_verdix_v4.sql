-- v4: raw_extraction safety-net column
-- Stores the full LLM JSON so novel fields are never lost even if not yet
-- promoted to their own column. The application insert now picks columns
-- explicitly, making the schema resilient to future extraction fields.

alter table contract_terms
  add column if not exists raw_extraction jsonb;
