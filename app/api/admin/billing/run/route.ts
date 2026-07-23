import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { runBillingForOrg } from '@/lib/billing-engine'

// POST /api/admin/billing/run
// Body: { org_id, dry_run?, period_start?, period_end? }
export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const body = await req.json() as {
    org_id:        string
    dry_run?:      boolean
    period_start?: string
    period_end?:   string
  }

  if (!body.org_id) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

  try {
    const result = await runBillingForOrg(body.org_id, {
      dryRun:      body.dry_run,
      periodStart: body.period_start,
      periodEnd:   body.period_end,
    })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
