import type { ContractTerms } from '@/lib/types'

/**
 * An intake connector converts a contract from any source format into
 * a Verdix-standard ContractTerms object and a raw document URL.
 *
 * Implemented connectors:
 *   - manual     : PDF uploaded via the UI (app/api/upload/route.ts)
 *
 * Planned connectors:
 *   - docusign   : envelope.completed webhook → fetch envelope PDF
 *   - hubspot    : deal.propertyChange webhook → fetch attached contract
 *   - salesforce : ContractSigned flow trigger → fetch Salesforce File
 */
export interface IntakeConnector {
  /** Human-readable connector name shown in the UI */
  name: string

  /** Stable identifier stored on the job row (e.g. 'manual', 'docusign') */
  connectorId: string

  /**
   * Extract ContractTerms from the connector's raw payload.
   * The payload shape is connector-specific; the output is always ContractTerms.
   */
  extract(payload: unknown): Promise<{
    terms: ContractTerms
    documentUrl: string
    sourceRef?: string  // e.g. DocuSign envelope ID, HubSpot deal ID
  }>
}
