// PostgREST changes how it embeds a related table based on whether the
// child's foreign key column has a unique constraint: jobs -> contract_terms
// used to embed as an array (contract_terms.job_id had no uniqueness, so
// PostgREST assumed one-to-many) until 20260820000001_contract_terms_job_id_unique.sql
// added one — PostgREST then correctly recognized the relationship as
// one-to-one and started returning a single object instead of a one-element
// array. Every call site written against the old array shape
// (`job.contract_terms as ContractTerms[]` then `?.[0]`) silently started
// reading `undefined` off a single object with no error, no crash — a
// contract with real customer_name/dates/terms rendered as if none of it
// had been extracted, and the approve route fell back to pushing an empty
// {} as ContractTerms to the billing platform. Defensive against either
// shape so this is correct regardless of the exact embedding PostgREST
// chooses to apply, rather than re-encoding an assumption about it.
export function unwrapEmbedded<T>(value: T | T[] | null | undefined): T | undefined {
  if (value == null) return undefined
  return Array.isArray(value) ? value[0] : value
}
