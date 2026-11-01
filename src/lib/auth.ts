import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });
        if (!user) return null;

        const passwordMatch = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash
        );
        if (!passwordMatch) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
          emailConfirmed: user.emailVerifiedAt !== null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session: updateData }) {
      if (user) {
        token.id = user.id;
        const u = user as {
          role?: string;
          mustChangePassword?: boolean;
          emailConfirmed?: boolean;
        };
        token.role = u.role;
        token.mustChangePassword = u.mustChangePassword;
        token.emailConfirmed = u.emailConfirmed;
      }
      // Handle client-side session update after password change
      if (trigger === "update" && updateData?.mustChangePassword === false) {
        token.mustChangePassword = false;
      }
      // Refreshed after the user follows the verification link, so the gate
      // clears without making them sign in again.
      if (trigger === "update" && updateData?.emailConfirmed === true) {
        token.emailConfirmed = true;
      }
      // The link is often opened on another device, so a token that still
      // says unverified re-checks the database. Only unverified sessions pay
      // for this lookup, and a failed lookup leaves the token as it was.
      if (token.emailConfirmed === false && typeof token.id === "string") {
        try {
          const fresh = await prisma.user.findUnique({
            where: { id: token.id },
            select: { emailVerifiedAt: true },
          });
          if (fresh?.emailVerifiedAt) token.emailConfirmed = true;
        } catch {
          // Leave the gate in place until the next request can confirm.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = (token.role as string) || "user";
        session.user.mustChangePassword = (token.mustChangePassword as boolean) || false;
        session.user.emailConfirmed = (token.emailConfirmed as boolean) ?? true;
      }
      return session;
    },
  },
});
