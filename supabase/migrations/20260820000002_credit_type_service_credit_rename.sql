-- ServiceCredit.credit_type: 'sla' renamed to 'service_credit' (clearer,
-- doesn't tie the taxonomy to formal SLA terminology when the underlying
-- concept is any availability/uptime-triggered credit) and 'conditional_credit'
-- added as a new value for milestone/multi-period-threshold credits. This
-- rewrites the data for existing rows so the app-level type/UI can rely on
-- 'sla' never appearing again, rather than having to special-case it forever.
update contract_terms
set service_credits = (
  select jsonb_agg(
    case when elem->>'credit_type' = 'sla'
         then jsonb_set(elem, '{credit_type}', '"service_credit"')
         else elem end
  )
  from jsonb_array_elements(service_credits) elem
)
where service_credits @> '[{"credit_type":"sla"}]';
