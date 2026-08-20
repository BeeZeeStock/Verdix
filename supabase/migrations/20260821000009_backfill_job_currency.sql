-- jobs.currency has always been set once at job creation (a placeholder —
-- 'USD' by default, per app/(dashboard)/configure/new/page.tsx and the
-- column's own DEFAULT) and never updated once contract extraction
-- determines the real currency onto contract_terms.currency. The
-- agreement-list pages (app/(dashboard)/configure, app/(dashboard)/dashboard)
-- display jobs.currency, not contract_terms.currency, so every existing
-- agreement's list-view currency has been silently wrong (confirmed: 15/15
-- most recent jobs showed job.currency='USD' while contract_terms.currency
-- correctly held the real value). The code that writes both going forward
-- is fixed in execute/route.ts and audit/route.ts; this is the one-time
-- catch-up for rows extracted before that fix.
update jobs
set currency = contract_terms.currency
from contract_terms
where contract_terms.job_id = jobs.id
  and contract_terms.currency is not null
  and contract_terms.currency <> jobs.currency;
