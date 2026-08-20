-- lib/meter-mapping-status.ts's isMeterMappingResolved already treats a
-- 'meter_or_manual_input' row as resolved via EITHER a confirmed meter_key
-- OR manual_value_configured — but that column never actually existed, and
-- nothing read or wrote it. A metric like chargeback count (explicitly
-- classified meter_or_manual_input) had no way to be resolved except by
-- picking a billing meter, even though the whole point of that
-- classification is that a reviewer may not have one and should be able to
-- say "we'll enter this manually each period" instead.
alter table contract_meter_mappings
  add column if not exists manual_value_configured boolean not null default false;
