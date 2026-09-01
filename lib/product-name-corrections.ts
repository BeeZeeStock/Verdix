// Step 17H.4B0D4H1B4E2.6 §8-14 — extracted, pure form of the exact
// `corrections` -> submitted-product_name mapping app/(dashboard)/configure/
// [id]/page.tsx's handleApprove uses. This state slot is product_name-only
// by contract: a caller writing anything else into it (e.g. a stringified
// price — the real, found-and-removed bug this step fixed in ReviewPanel's
// own price-correction flow) would silently overwrite the submitted
// product_name and corrupt the /api/corrections learning log with a bogus
// "product_name correction" whose value was actually a price. Extracting
// this mapping to its own pure function makes that contract explicit and
// gives it a regression test surface independent of the surrounding
// 10,000+-line page component.

export type ProductNameCorrections = Record<string, { value: string; remember: boolean }>

export function applyProductNameCorrections<T extends { id: string; product_name: string }>(
  items: T[],
  corrections: ProductNameCorrections,
): T[] {
  return items.map(i => ({
    ...i,
    product_name: corrections[i.id]?.value || i.product_name,
  }))
}

// The same `corrections` entries handleApprove batches into /api/corrections
// POSTs at approve time — pure request-shape derivation, no fetch itself
// (the caller performs the actual network calls; this only decides WHICH
// entries to log and what body each one gets).
export function buildProductNameCorrectionRequests<T extends { id: string; product_name: string }>(
  items: T[],
  corrections: ProductNameCorrections,
  params: { jobId: string; customerName?: string | null },
): Array<{ jobId: string; fieldName: 'product_name'; extractedValue: string | undefined; correctedValue: string; customerName?: string | null; applyToFuture: boolean }> {
  return Object.entries(corrections)
    .filter(([, c]) => c.value)
    .map(([itemId, c]) => {
      const item = items.find(i => i.id === itemId)
      return {
        jobId: params.jobId,
        fieldName: 'product_name' as const,
        extractedValue: item?.product_name,
        correctedValue: c.value,
        customerName: params.customerName,
        applyToFuture: c.remember,
      }
    })
}
