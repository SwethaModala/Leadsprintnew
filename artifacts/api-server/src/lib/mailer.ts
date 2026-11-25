import nodemailer, { type Transporter } from "nodemailer";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function smtpConfigured(): boolean {
  return Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASSWORD"));
}

let cachedTransporter: Transporter | undefined;

function transporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASSWORD");
  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD)");
  }
  cachedTransporter = nodemailer.createTransport({
    host,
    port: Number(env("SMTP_PORT") ?? "587"),
    secure: env("SMTP_SECURE") === "true",
    auth: { user, pass },
  });
  return cachedTransporter;
}

export interface WeeklyReportEmailInput {
  to: string;
  businessName: string;
  periodLabel: string;
  leadsReceived: number;
  callsAttempted: number;
  callsConnected: number;
  qualifiedLeads: number;
  appointmentsBooked: number;
  transferRate: number;
  failedActions: number;
  voiceMinutes: number;
  estimatedProviderCost: number;
}

// Business names are operator-entered; never interpolate them into HTML raw.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderWeeklyReportEmail(input: WeeklyReportEmailInput): { subject: string; text: string; html: string } {
  const rows: Array<[string, string]> = [
    ["Leads received", String(input.leadsReceived)],
    ["Calls attempted", String(input.callsAttempted)],
    ["Calls connected", String(input.callsConnected)],
    ["Qualified leads", String(input.qualifiedLeads)],
    ["Appointments booked", String(input.appointmentsBooked)],
    ["Transfer rate", `${Math.round(input.transferRate * 100)}%`],
    ["Failed / uncertain actions", String(input.failedActions)],
    ["Voice minutes used", input.voiceMinutes.toFixed(1)],
    ["Estimated provider cost", `$${input.estimatedProviderCost.toFixed(2)}`],
  ];
  const subject = `LeadSprint weekly report — ${input.businessName} — ${input.periodLabel}`;
  const text = [`${input.businessName} — ${input.periodLabel}`, "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const html = `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px;">
      <h2 style="margin-bottom: 4px;">${escapeHtml(input.businessName)}</h2>
      <p style="color: #667; margin-top: 0;">${escapeHtml(input.periodLabel)}</p>
      <table style="width: 100%; border-collapse: collapse;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding: 6px 0; border-bottom: 1px solid #eee; color:#445;">${label}</td><td style="padding: 6px 0; border-bottom: 1px solid #eee; text-align: right; font-weight: 600;">${value}</td></tr>`,
          )
          .join("")}
      </table>
    </div>`;
  return { subject, text, html };
}

/**
 * Emails the operator (ALERT_EMAIL) when the health check finds failed
 * calls or a stalled queue. Returns `false` when there is nowhere to send
 * it, so the caller can say so rather than pretend someone was told.
 */
export async function sendOpsAlertEmail(subject: string, lines: string[]): Promise<boolean> {
  const to = env("ALERT_EMAIL");
  if (!to || !smtpConfigured()) return false;
  const from = env("SMTP_FROM") ?? env("SMTP_USER")!;
  const text = lines.join("\n");
  const html = `<div style="font-family: -apple-system, Arial, sans-serif;">${lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}</div>`;
  await transporter().sendMail({ from, to, subject, text, html });
  return true;
}

/**
 * Emails one business's own alert address (for example an instant
 * emergency-lead notice). Unlike sendOpsAlertEmail, the recipient is the
 * client's, not the operator's. Returns `false` when there is nowhere to send
 * it (no SMTP, or no recipient). A transport failure is thrown: the caller
 * decides that an alert failing must never fail the request that caused it.
 * Lines carry customer-supplied text, so the HTML part is escaped.
 */
export async function sendBusinessAlertEmail(to: string, subject: string, lines: string[]): Promise<boolean> {
  if (!to.trim() || !smtpConfigured()) return false;
  const from = env("SMTP_FROM") ?? env("SMTP_USER")!;
  const text = lines.join("\n");
  const html = `<div style="font-family: -apple-system, Arial, sans-serif;">${lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}</div>`;
  await transporter().sendMail({ from, to: to.trim(), subject, text, html });
  return true;
}

/**
 * Sends the weekly pilot report by email if SMTP is configured. Returns
 * `false` (not an error) when SMTP isn't set up yet, so this can be called
 * unconditionally from a scheduled job during Phase 1 while email delivery
 * is still being wired up — matches the plan's fail-closed-but-visible
 * pattern used for the voice/calendar providers.
 */
export async function sendWeeklyReportEmail(input: WeeklyReportEmailInput): Promise<boolean> {
  if (!smtpConfigured()) return false;
  const { subject, text, html } = renderWeeklyReportEmail(input);
  const from = env("SMTP_FROM") ?? env("SMTP_USER")!;
  await transporter().sendMail({ from, to: input.to, subject, text, html });
  return true;
}

export interface TeamInvitationEmailInput {
  to: string;
  organizationName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}

/**
 * Sends a team invitation email via SMTP or Resend if configured.
 * Returns `false` if no email provider is configured so callers can fail
 * closed in production or record a safe dev/demo delivery state.
 */
export async function sendTeamInvitationEmail(input: TeamInvitationEmailInput): Promise<boolean> {
  const subject = `You're invited to join ${input.organizationName} on LeadSprint`;
  const expiresLabel = input.expiresAt.toUTCString();
  const text = [
    `${input.inviterName} invited you to join ${input.organizationName} on LeadSprint as ${input.role}.`,
    "",
    `Accept your invitation: ${input.acceptUrl}`,
    "",
    `This invitation expires on ${expiresLabel}.`,
  ].join("\n");
  const html = [
    `<div style="font-family: -apple-system, Arial, sans-serif; line-height: 1.5; color: #111827;">`,
    `<h2 style="margin: 0 0 12px;">Join ${escapeHtml(input.organizationName)} on LeadSprint</h2>`,
    `<p>${escapeHtml(input.inviterName)} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as <strong>${escapeHtml(input.role)}</strong>.</p>`,
    `<p style="margin: 20px 0;"><a href="${escapeHtml(input.acceptUrl)}" style="display: inline-block; background: #0f172a; color: #ffffff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 600;">Accept Invitation</a></p>`,
    `<p style="font-size: 13px; color: #4b5563;">This invitation expires on ${escapeHtml(expiresLabel)}. If you weren't expecting this invitation, you can ignore this email.</p>`,
    `</div>`,
  ].join("");

  if (smtpConfigured()) {
    const from = env("SMTP_FROM") ?? env("SMTP_USER")!;
    await transporter().sendMail({ from, to: input.to, subject, text, html });
    return true;
  }

  const resendKey = env("RESEND_API_KEY");
  const resendFrom = env("RESEND_FROM_EMAIL") ?? env("SMTP_FROM");
  if (resendKey && resendFrom) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [input.to],
        subject,
        text,
        html,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend invitation email failed with status ${response.status}`);
    }
    return true;
  }

  return false;
}
