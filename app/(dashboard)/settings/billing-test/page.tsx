'use client'

import { BillingTestSimulator } from '@/app/_components/BillingTestSimulator'

export default function BillingTestPage() {
  return (
    <div className="p-4 md:p-8 max-w-3xl space-y-8">
      <div>
        <h1 className="font-display font-light text-ink text-2xl mb-1">Billing test</h1>
        <p className="text-stone text-sm leading-relaxed">
          Simulate a usage reading for any meter still in <span className="text-amber-600 font-medium">Test</span> mode
          and preview the resulting overage exactly as the real billing run would compute it — without creating
          any invoices. Once the numbers look right, switch the meter to <span className="text-forest font-medium">Live</span> on
          the <a href="/settings/meters" className="text-forest underline hover:no-underline">Billing meters</a> page.
        </p>
      </div>

      <div className="bg-white border border-forest/10 rounded-2xl px-6 py-6">
        <BillingTestSimulator />
      </div>
    </div>
  )
}
