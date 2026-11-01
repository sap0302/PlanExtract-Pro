import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

/**
 * Admin identities live in this app's environment, not in the main app's User
 * table. That keeps the two sign-ins fully independent: a session here is never
 * valid on the product app, and vice versa.
 */

// Compared against when no admin is configured or the email doesn't match, so a
// wrong email and a wrong password take the same amount of time to reject.
const DUMMY_HASH = "$2b$12$Ky1MyGGVJJH2v3XlKMoTleXQ4wG.WlxUJ2AAVPqBSlZ5CqI6dQoBW";

const BCRYPT_HASH = /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/;

type AdminAccount = { email: string; passwordHash: string; name: string };

function configuredAdmin(): AdminAccount | null {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (!email || !passwordHash || !BCRYPT_HASH.test(passwordHash)) return null;

  return {
    email,
    passwordHash,
    name: process.env.ADMIN_NAME?.trim() || "Administrator",
  };
}

/**
 * Returns why sign-in can't work, or null when it can.
 *
 * The malformed-hash case is called out separately because dotenv expands `$`
 * in .env files: an unescaped bcrypt hash silently becomes an empty string, and
 * every login then fails with no indication of why.
 */
export function adminConfigError(): string | null {
  const email = process.env.ADMIN_EMAIL?.trim();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();

  if (!email || !passwordHash) {
    return "No administrator is configured. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH, then restart this app.";
  }
  if (!BCRYPT_HASH.test(passwordHash)) {
    return "ADMIN_PASSWORD_HASH is not a valid bcrypt hash. In a .env file every $ must be escaped as \\$, otherwise it is read as a variable reference and stripped.";
  }
  return null;
}

/**
 * Distinct cookie names, because Auth.js defaults to `authjs.session-token` in
 * both apps and cookies ignore the port: on localhost the product app's session
 * cookie is sent to this app, which then fails to decrypt it with its own
 * secret and throws JWTSessionError. Renaming keeps the two sessions from ever
 * being handed to the wrong app, on localhost and on a shared parent domain.
 */
const useSecureCookies = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "").startsWith(
  "https://"
);
const securePrefix = useSecureCookies ? "__Secure-" : "";
const hostPrefix = useSecureCookies ? "__Host-" : "";

const cookieDefaults = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: useSecureCookies,
} as const;

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  cookies: {
    sessionToken: {
      name: `${securePrefix}planextract-admin.session-token`,
      options: cookieDefaults,
    },
    callbackUrl: {
      name: `${securePrefix}planextract-admin.callback-url`,
      options: cookieDefaults,
    },
    csrfToken: {
      name: `${hostPrefix}planextract-admin.csrf-token`,
      options: cookieDefaults,
    },
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const admin = configuredAdmin();
        const matchesEmail = admin !== null && admin.email === email;

        const passwordMatches = await bcrypt.compare(
          password,
          matchesEmail ? admin.passwordHash : DUMMY_HASH
        );
        if (!matchesEmail || !passwordMatches) return null;

        return { id: "admin", name: admin.name, email: admin.email };
      },
    }),
  ],
});
