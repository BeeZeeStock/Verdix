// Step 17H.4B0D4H1B4C — shared rejection message for the AUTO_CONFIGURE-only
// module guard on Model B+ commercial-mutation routes (reconcile-line-items,
// confirm-rule, terms PATCH, reviewer line-items PATCH, reconcile-semantic-
// keys, reconcile-fixed-fee-timing). Each route loads its own job row (shape
// differs per route, so no shared loader) and checks `job.module ===
// 'AUTO_CONFIGURE'` itself, right after the existing org-scoped not-found
// check and before any mutation — this constant only keeps the rejection
// text identical across all six.
export const AUTO_CONFIGURE_ONLY_MESSAGE = 'This operation is only available for auto-configuration jobs.'
