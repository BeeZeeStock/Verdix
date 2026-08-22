import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'
import Credentials from 'next-auth/providers/credentials'

if (!process.env.AUTH_SECRET) {
  throw new Error('AUTH_SECRET environment variable is not set')
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        // Never call .auth.signInWithPassword on the shared `supabaseServer`
        // singleton (lib/supabase.ts) — supabase-js attaches whichever
        // session currently exists on a client instance to the
        // Authorization header of every subsequent request from THAT
        // instance, regardless of `persistSession: false` (which only
        // controls storage persistence, not in-memory session state). Since
        // `supabaseServer` is a module-level singleton reused by every
        // server-side query in this app, signing in on it here would
        // silently downgrade every later query in this process from
        // service_role to this end-user's own `authenticated` role —
        // process-order-dependent authorization, and a real, confirmed
        // production bug (see lib/auth-client-isolation.test.ts). A fresh,
        // disposable client — used once for this password check, then
        // discarded — is the fix; `createServerClient()` already exists in
        // lib/supabase.ts for exactly this (it returns a brand-new client
        // per call, never the shared singleton).
        const { createServerClient } = await import('./supabase')
        const authClient = createServerClient()
        const { data, error } = await authClient.auth.signInWithPassword({
          email: credentials.email as string,
          password: credentials.password as string,
        })

        if (error || !data.user) return null

        return {
          id: data.user.id,
          email: data.user.email,
          name: data.user.user_metadata?.full_name ?? data.user.email,
        }
      },
    }),
  ],
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async signIn({ user }) {
      const email = user?.email
      if (!email) return true

      // Activate any pending invitations for this email
      const { supabaseServer } = await import('./supabase')
      await supabaseServer
        .from('org_memberships')
        .update({ status: 'active' })
        .eq('user_email', email)
        .eq('status', 'invited')

      return true
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub
      if (token.provider) session.user.provider = token.provider as string
      return session
    },
    async jwt({ token, user, account }) {
      // Use email as the stable identifier — OAuth provider IDs change across sessions
      if (user?.email) token.sub = user.email
      else if (user?.id) token.sub = user.id
      // Store the sign-in provider on first login so the session can expose it
      if (account?.provider) token.provider = account.provider
      return token
    },
  },
  session: { strategy: 'jwt' },
})
