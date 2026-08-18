/**
 * Verifies a cron-triggered request. Accepts either:
 *   - `Authorization: Bearer <CRON_SECRET>` — the header Vercel Cron
 *     automatically attaches to every invocation once CRON_SECRET is set as
 *     a project env var (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
 *   - `x-cron-secret: <CRON_SECRET>` — this codebase's own pre-existing
 *     convention, kept for any external/manual trigger already using it.
 * Fails closed: an unset CRON_SECRET rejects every request, same as before.
 */
export function isAuthorizedCronRequest(req: Request): boolean {
  const configured = process.env.CRON_SECRET
  if (!configured) return false

  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (bearer === configured) return true

  const legacyHeader = req.headers.get('x-cron-secret')
  return legacyHeader === configured
}
