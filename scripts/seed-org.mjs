/**
 * One-time script: creates Lynora AB org for bilal.zahoor@yahoo.com
 * and assigns all existing jobs (currently user_id = bilal.zahoor@yahoo.com) to that org.
 *
 * Run with:
 *   node scripts/seed-org.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const OWNER_EMAIL = 'bilal.zahoor@yahoo.com'
const ORG_NAME = 'Lynora AB'
const ORG_SLUG = `lynora-ab-${Date.now().toString(36)}`

async function main() {
  // 1. Create org
  console.log(`Creating org "${ORG_NAME}"...`)
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .insert({ name: ORG_NAME, slug: ORG_SLUG })
    .select('id')
    .single()

  if (orgErr) {
    console.error('Failed to create org:', orgErr.message)
    process.exit(1)
  }
  console.log(`  Created org: ${org.id}`)

  // 2. Create owner membership
  console.log(`Creating owner membership for ${OWNER_EMAIL}...`)
  const { error: memberErr } = await supabase
    .from('org_memberships')
    .insert({ org_id: org.id, user_email: OWNER_EMAIL, role: 'owner', status: 'active' })

  if (memberErr) {
    console.error('Failed to create membership:', memberErr.message)
    process.exit(1)
  }
  console.log('  Membership created.')

  // 3. Assign all existing jobs to this org
  console.log(`Updating jobs where user_id = '${OWNER_EMAIL}'...`)
  const { data: updated, error: updateErr } = await supabase
    .from('jobs')
    .update({ org_id: org.id })
    .eq('user_id', OWNER_EMAIL)
    .select('id')

  if (updateErr) {
    console.error('Failed to update jobs:', updateErr.message)
    process.exit(1)
  }
  console.log(`  Updated ${updated?.length ?? 0} jobs.`)

  console.log('\nDone! Org ID:', org.id)
}

main()
