import { supabaseServer } from './supabase'

export interface LearnedRule {
  field_name: string
  extracted_value: string
  corrected_value: string
  correction_reason: string | null
  customer_name: string | null
  apply_to_future: boolean
  created_at: string
}

export async function buildLearningContext(customerName?: string): Promise<string> {
  let query = supabaseServer
    .from('extraction_corrections')
    .select('field_name, extracted_value, corrected_value, correction_reason, customer_name, apply_to_future, created_at')
    .eq('apply_to_future', true)
    .order('created_at', { ascending: false })
    .limit(50)

  if (customerName) {
    query = supabaseServer
      .from('extraction_corrections')
      .select('field_name, extracted_value, corrected_value, correction_reason, customer_name, apply_to_future, created_at')
      .eq('apply_to_future', true)
      .or(`customer_name.eq.${customerName},customer_name.is.null`)
      .order('created_at', { ascending: false })
      .limit(50)
  }

  const { data, error } = await query
  if (error || !data?.length) return ''

  const rules = (data as LearnedRule[])
    .map(r => {
      const scope = r.customer_name ? `for ${r.customer_name}` : 'globally'
      const reason = r.correction_reason ? ` (reason: ${r.correction_reason})` : ''
      return `- Field "${r.field_name}": when you see "${r.extracted_value}", the correct value is "${r.corrected_value}"${reason} [${scope}]`
    })
    .join('\n')

  return `\n\n<learned_rules>\nThe following corrections have been applied by human reviewers. Apply them automatically:\n${rules}\n</learned_rules>`
}
