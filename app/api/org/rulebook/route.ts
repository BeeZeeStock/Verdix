/**
 * GET /api/org/rulebook
 *
 * Step 5D — the Organization Rulebook management page's data source. Lists
 * every rule (any status) for the caller's own organization — the only
 * route in this codebase that returns draft/disabled rulebook rows, and
 * strictly for display; nothing here feeds resolution.
 *
 * Security (item 13): organizationId is NEVER read from the request — it
 * comes exclusively from requireOrg()'s trusted OrgContext, exactly like
 * every other org-scoped route in this codebase (app/api/jobs/[id]/*,
 * app/api/org/*). listAllOrganizationRules filters by that id at the query
 * itself; there is no code path here that could return another
 * organization's rows.
 */
import { NextResponse } from 'next/server'
import { requireOrg } from '@/lib/org'
import { listAllOrganizationRules } from '@/lib/rulebook/organization-rules-service'

export async function GET() {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const rules = await listAllOrganizationRules(org.orgId)
  return NextResponse.json({ rules })
}
