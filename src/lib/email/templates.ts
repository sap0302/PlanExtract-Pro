import { TOKEN_TTL_MS } from "@/lib/email-verification";
import type { EmailMessage } from "./types";

const APP_NAME = "PlanExtract Pro";

function appUrl(): string {
  const base = process.env.APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

export function verificationUrl(token: string): string {
  return `${appUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

// Applicant-supplied values reach the HTML body, so they are escaped rather than interpolated raw.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(params: {
  heading: string;
  greeting: string;
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  footnote: string;
}): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr>
        <td>
          <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(params.heading)}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${escapeHtml(params.greeting)}</p>
          ${params.bodyHtml}
          <p style="margin:0 0 24px;">
            <a href="${params.ctaUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;">${escapeHtml(params.ctaLabel)}</a>
          </p>
          <p style="margin:0;font-size:12px;color:#71717a;line-height:1.6;">
            ${escapeHtml(params.footnote)}<br />${params.ctaUrl}
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding-top:24px;font-size:11px;color:#a1a1aa;text-align:center;">
          &copy; 2025&ndash;2026 Serdar Piriyev. Built for Steppe &amp; Stone.
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const ttlDays = Math.round(TOKEN_TTL_MS / (24 * 60 * 60 * 1000));

/**
 * Sent when an admin approves an access request. The account exists at this
 * point but stays unusable until the recipient follows the link, which is what
 * proves they actually own the address they signed up with.
 */
export function accountApprovedEmail(params: {
  name: string | null;
  email: string;
  token: string;
}): EmailMessage {
  const url = verificationUrl(params.token);
  const greeting = params.name?.trim() ? `Hi ${params.name.trim()},` : "Hi,";

  const text = [
    greeting,
    "",
    `Your access request for ${APP_NAME} has been approved.`,
    "",
    `Confirm your email address to activate your account: ${url}`,
    "",
    `This link expires in ${ttlDays} days. Once confirmed, sign in with ${params.email} and the password you chose when you requested access.`,
    "",
    "— Steppe & Stone",
  ].join("\n");

  const html = layout({
    heading: "Your access request was approved",
    greeting,
    bodyHtml: `
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
            Confirm your email address to activate your <strong>${APP_NAME}</strong> account.
            After that you can sign in with <strong>${escapeHtml(params.email)}</strong> and the
            password you chose when you requested access.
          </p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#71717a;">
            This link expires in ${ttlDays} days.
          </p>`,
    ctaLabel: "Confirm email address",
    ctaUrl: url,
    footnote: "If the button doesn't work, paste this link into your browser:",
  });

  return {
    to: params.email,
    subject: `Confirm your email to activate your ${APP_NAME} account`,
    text,
    html,
  };
}

/** Re-sends the confirmation link for an account that is approved but still unverified. */
export function verificationResendEmail(params: {
  name: string | null;
  email: string;
  token: string;
}): EmailMessage {
  const url = verificationUrl(params.token);
  const greeting = params.name?.trim() ? `Hi ${params.name.trim()},` : "Hi,";

  const text = [
    greeting,
    "",
    `Here is a new link to confirm your email address for ${APP_NAME}: ${url}`,
    "",
    `This link expires in ${ttlDays} days and replaces any earlier one.`,
    "",
    "— Steppe & Stone",
  ].join("\n");

  const html = layout({
    heading: "Confirm your email address",
    greeting,
    bodyHtml: `
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
            Here is a new link to confirm <strong>${escapeHtml(params.email)}</strong> for your
            <strong>${APP_NAME}</strong> account. It expires in ${ttlDays} days and replaces any
            earlier link.
          </p>`,
    ctaLabel: "Confirm email address",
    ctaUrl: url,
    footnote: "If the button doesn't work, paste this link into your browser:",
  });

  return {
    to: params.email,
    subject: `Confirm your email for ${APP_NAME}`,
    text,
    html,
  };
}
