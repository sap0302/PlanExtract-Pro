import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      mustChangePassword: boolean;
      // Named to avoid colliding with NextAuth's own `emailVerified: Date | null`.
      emailConfirmed: boolean;
    } & DefaultSession["user"];
  }
}
