import nodemailer, { type Transporter } from "nodemailer";
import type { EmailMessage, EmailTransport } from "./types";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

const DEFAULT_FROM = "PlanExtract Pro <info@steppenstoneco.com>";

/** Returns null when SMTP isn't configured, which callers treat as "email disabled" rather than an error. */
export function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
  if (!host) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isFinite(port) || port <= 0) return null;

  const user = process.env.SMTP_USER?.trim() || undefined;
  const password = process.env.SMTP_PASSWORD || undefined;

  // A username without its password is half-configured. Reporting that as ready
  // would replace an honest "email is off" warning with per-send auth failures.
  if (user && !password) return null;

  return {
    host,
    port,
    // Implicit TLS is port 465; everything else upgrades via STARTTLS.
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    user,
    password,
    from,
  };
}

export function createSmtpTransport(config: SmtpConfig): EmailTransport {
  let transporter: Transporter | null = null;

  // Built on first send so an unreachable SMTP host doesn't cost anything at import time.
  function getTransporter(): Transporter {
    transporter ??= nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    });
    return transporter;
  }

  return {
    async send(message: EmailMessage) {
      await getTransporter().sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}
