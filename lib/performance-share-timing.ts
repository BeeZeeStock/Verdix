// Step 17E.1, item B — a contract whose start date hasn't arrived yet has
// NO eligible billing period at all; asking "which operational inputs are
// missing" is the wrong question in that case (there is nothing to enter
// them FOR). Pure so app/api/jobs/[id]/performance-share/route.ts's
// contract-date short-circuit is independently testable from the DB
// round-trip around it.
export function hasContractStarted(contractStartDate: string | null | undefined, asOf: Date = new Date()): boolean {
  if (!contractStartDate) return true // no stated date — never blocked by this check
  return asOf >= new Date(contractStartDate + 'T00:00:00')
}
