import Link from 'next/link'
import { VerdixLogo } from '@/components/VerdixLogo'

export const metadata = {
  title: 'Blog | Verdix',
  description: 'News, guides and thinking from the Verdix team on contract billing, partner reconciliation and revenue operations.',
}

const posts = [
  {
    slug: 'from-contract-clause-to-billable-metric',
    title: 'From contract clause to billable metric',
    excerpt: 'A price in a contract is not yet a billing rule. Learn how to turn commercial language into a reliable billable metric connected to operational data, pricing rules and invoice workflows.',
    category: 'Finance operations · Product',
    date: 'August 2026',
    readTime: '8 min read',
  },
  {
    slug: 'what-do-you-need-to-launch-usage-based-pricing',
    title: 'What do you need to launch usage-based pricing?',
    excerpt: 'Usage-based pricing requires more than tracking product activity. Learn how to define billable usage, connect contract terms, calculate charges and integrate with your existing billing stack.',
    category: 'Finance operations · Product',
    date: 'July 2026',
    readTime: '10 min read',
  },
  {
    slug: 'metering-billing-invoicing-payments',
    title: 'Metering, billing, invoicing and payments: what does each system actually do?',
    excerpt: 'The terminology around modern billing can be confusing. Here is what each layer in the billing stack actually does — and where agreement operations fits in.',
    category: 'Finance operations · Product',
    date: 'July 2026',
    readTime: '9 min read',
  },
  {
    slug: 'why-contract-to-cash-is-still-manual',
    title: 'Why contract-to-cash is still a manual workflow in modern SaaS',
    excerpt: 'Modern SaaS companies use CRM, CLM, billing and payment software, yet bespoke contract-to-cash workflows remain manual. Here is why.',
    category: 'Finance operations · Revenue',
    date: 'July 2026',
    readTime: '8 min read',
  },
  {
    slug: 'why-bespoke-enterprise-contracts-are-difficult-to-bill',
    title: 'Why bespoke enterprise contracts are still difficult to bill',
    excerpt: 'Bespoke SaaS contracts enable flexible enterprise deals, but they create complex billing work across Finance, RevOps and Product. Here is why.',
    category: 'Finance operations',
    date: 'July 2026',
    readTime: '7 min read',
  },
]

export default function BlogIndex() {
  return (
    <div className="min-h-screen" style={{ background: '#FAF8F4' }}>

      {/* Nav */}
      <header className="border-b border-forest/10 sticky top-0 z-20 backdrop-blur-sm" style={{ background: 'rgba(250,248,244,0.95)' }}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <VerdixLogo size={24} />
            <span className="font-sans font-semibold text-[15px]" style={{ color: '#1A3D2B', letterSpacing: '0.02em' }}>Verdix</span>
          </Link>
          <div className="flex items-center gap-5 text-sm">
            <Link href="/login" className="text-stone hover:text-forest transition-colors">Sign in</Link>
            <Link href="/signup" className="bg-forest text-white font-medium px-4 py-2 rounded-xl hover:bg-sage transition-colors" style={{ fontSize: 13 }}>
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-14 md:py-20">

        {/* Header */}
        <div className="mb-12">
          <div className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#4A7C59' }}>Blog</div>
          <h1 className="font-display font-light text-ink text-3xl mb-3">Ideas and thinking from Verdix</h1>
          <p className="text-stone leading-relaxed">On contract billing, partner reconciliation and revenue operations for B2B companies.</p>
        </div>

        {/* Post list */}
        <div className="space-y-4">
          {posts.map(post => (
            <Link
              key={post.slug}
              href={`/blog/${post.slug}`}
              className="block bg-white border border-forest/10 rounded-2xl p-7 hover:border-forest/30 hover:shadow-sm transition-all group"
            >
              <div className="flex items-center gap-3 mb-4">
                <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4A7C59' }}>{post.category}</span>
                <span className="text-stone/30">·</span>
                <span className="text-xs text-stone">{post.date}</span>
                <span className="text-stone/30">·</span>
                <span className="text-xs text-stone">{post.readTime}</span>
              </div>
              <h2 className="font-display font-light text-ink text-xl mb-3 group-hover:text-forest transition-colors leading-snug">{post.title}</h2>
              <p className="text-stone text-sm leading-relaxed mb-4">{post.excerpt}</p>
              <span className="text-sm font-medium flex items-center gap-1.5 transition-all group-hover:gap-2.5" style={{ color: '#1A3D2B' }}>
                Read post
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </span>
            </Link>
          ))}
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-forest/10 py-8 text-center mt-16" style={{ background: '#fff' }}>
        <div className="flex items-center justify-center gap-2.5 mb-3">
          <VerdixLogo size={20} />
          <span className="font-sans font-semibold text-sm" style={{ color: '#1A3D2B' }}>Verdix</span>
        </div>
        <div className="flex items-center justify-center gap-6 text-xs text-stone mb-3">
          <Link href="/privacy" className="hover:text-forest transition-colors">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-forest transition-colors">Terms</Link>
          <a href="mailto:bilal@lynoraai.com" className="hover:text-forest transition-colors">Contact</a>
        </div>
        <p className="text-xs text-stone/50">Verdix is a product by Lynora AB · Org. nr 559516-1190 · Sweden</p>
      </footer>

    </div>
  )
}
