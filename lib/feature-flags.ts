import { supabaseServer } from './supabase'

const SELF_SERVICE_SIGNUP_KEY = 'self_service_signup_enabled'

/**
 * Pure — no DB access. `verdix_settings.value` is stored as a JSON string
 * ("true"/"false") per the existing live_checkout_active convention, so a
 * JS boolean `true` never actually comes back from Supabase — only the
 * string 'true'. Handled here so callers don't have to know that.
 */
export function parseBooleanSetting(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue
  return value === true || value === 'true'
}

/** Defaults to true (current behavior) when the row hasn't been seeded yet. */
export async function isSelfServiceSignupEnabled(): Promise<boolean> {
  const { data } = await supabaseServer
    .from('verdix_settings')
    .select('value')
    .eq('key', SELF_SERVICE_SIGNUP_KEY)
    .maybeSingle()
  return parseBooleanSetting(data?.value, true)
}

/**
 * Pure — governs whether an unrecognized identity may auto-create a new
 * organization. When self-service signup is disabled, an unknown Google or
 * credentials identity must never gain org access by simply authenticating —
 * access only comes from an admin-provisioned invite.
 */
export function shouldAutoCreateOrg(hasMembership: boolean, selfServiceEnabled: boolean): boolean {
  return !hasMembership && selfServiceEnabled
}
