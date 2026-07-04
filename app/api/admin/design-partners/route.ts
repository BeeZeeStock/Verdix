import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseServer
    .from('design_partner_applications')
    .select('id, company, contact_name, contact_email, contact_role, company_size, pain_point, status, created_at')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PATCH(req: Request) {
  const { id, status } = await req.json()
  const validStatuses = ['new', 'contacted', 'approved', 'declined']
  if (!id || !validStatuses.includes(status)) {
    return NextResponse.json({ error: 'id and valid status required' }, { status: 400 })
  }

  const { error } = await supabaseServer
    .from('design_partner_applications')
    .update({ status })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
