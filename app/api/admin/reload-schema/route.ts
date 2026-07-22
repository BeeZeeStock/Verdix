/**
 * POST /api/admin/reload-schema
 *
 * Triggers an immediate PostgREST schema-cache reload via the
 * reload_pgrst_schema() Postgres helper function (SECURITY DEFINER).
 * Use this after applying migrations manually (e.g. via the Supabase SQL editor)
 * when the cache is stale and API writes are returning schema-miss errors.
 *
 * Platform admin access only.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

export async function POST() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const { error } = await supabaseServer.rpc('reload_pgrst_schema')

  if (error) {
    console.error('[reload-schema] RPC failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.info('[reload-schema] PostgREST schema cache reload triggered')
  return NextResponse.json({ ok: true, message: 'Schema cache reload triggered.' })
}
