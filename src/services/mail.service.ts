// Tournament invitation emails — SMTP in prod, Ethereal preview in local dev.
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

const WEB_ORIGIN = process.env.WEB_ORIGIN || process.env.CLIENT_URL || 'http://localhost:8080';

/** Domains that must never receive SMTP (test accounts, fake TLDs). */
const BLOCKED_EMAIL_DOMAINS = new Set([
  'atak.test', 'example.com', 'example.org', 'test', 'localhost', 'invalid',
]);

export function isDeliverableEmail(email: string): boolean {
  const norm = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(norm)) return false;
  const domain = norm.split('@')[1];
  if (BLOCKED_EMAIL_DOMAINS.has(domain)) return false;
  if (domain.endsWith('.test') || domain.endsWith('.local') || domain.endsWith('.invalid')) return false;
  return true;
}

let transporter: Transporter | null = null;

async function ensureTransporter(): Promise<Transporter> {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true';
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
      tls: { minVersion: 'TLSv1.2' },
    });
    console.log('[mail] SMTP configured:', process.env.SMTP_HOST);
    return transporter;
  }

  // Dev fallback: Ethereal — logs a preview URL (no real inbox delivery)
  const testAccount = await nodemailer.createTestAccount();
  transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  console.log('[mail] Dev mode — Ethereal test account. Configure SMTP_HOST for real delivery.');
  return transporter;
}

export interface TournamentInviteEmailParams {
  toEmail: string;
  toName?: string;
  inviterName: string;
  tournamentName: string;
  teamName: string;
  tournamentId: string;
  playerSlotName?: string;
}

export async function sendTournamentInvitationEmail(params: TournamentInviteEmailParams): Promise<{ sent: boolean; previewUrl?: string }> {
  const {
    toEmail, toName, inviterName, tournamentName, teamName, tournamentId, playerSlotName,
  } = params;

  const from = process.env.SMTP_FROM || 'ATAK.GG Torneos <noreply@atak.gg>';
  const dashboardUrl = `${WEB_ORIGIN}/dashboard`;
  const tournamentUrl = `${WEB_ORIGIN}/tournaments/${tournamentId}`;
  const greeting = toName ? `Hola ${toName}` : 'Hola';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:system-ui,sans-serif;color:#e8e8ea;">
  <div style="max-width:520px;margin:32px auto;padding:32px;border-radius:16px;border:1px solid rgba(255,255,255,0.08);background:#111114;">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#e1242e;font-weight:700;">ATAK.GG · Torneos</p>
    <h1 style="margin:0 0 16px;font-size:22px;color:#fff;">Invitación a torneo</h1>
    <p style="margin:0 0 20px;line-height:1.6;color:rgba(255,255,255,0.72);">
      ${greeting}, <strong>${inviterName}</strong> te invitó a jugar en el equipo
      <strong style="color:#ff5a64;">${teamName}</strong> del torneo
      <strong>${tournamentName}</strong>.
      ${playerSlotName ? `<br><span style="color:rgba(255,255,255,0.5);font-size:14px;">Rol en roster: ${playerSlotName}</span>` : ''}
    </p>
    <p style="margin:0 0 24px;line-height:1.6;color:rgba(255,255,255,0.55);font-size:14px;">
      Acepta desde tu Dashboard (asegúrate de tener tu cuenta de LoL vinculada antes de aceptar).
    </p>
    <a href="${dashboardUrl}" style="display:inline-block;padding:12px 24px;background:#e1242e;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">
      Ver invitación en Dashboard
    </a>
    <p style="margin:24px 0 0;font-size:12px;color:rgba(255,255,255,0.35);">
      <a href="${tournamentUrl}" style="color:rgba(255,255,255,0.45);">Ver torneo</a>
    </p>
  </div>
</body>
</html>`;

  const text = `${greeting},\n\n${inviterName} te invitó al equipo "${teamName}" en el torneo "${tournamentName}".\n\nAcepta en tu Dashboard: ${dashboardUrl}\n\nVincula tu cuenta de LoL antes de aceptar.`;

  if (!isDeliverableEmail(toEmail)) {
    console.log(`[mail] Skipped non-deliverable address: ${toEmail} (test/fake domain)`);
    return { sent: false };
  }

  try {
    const transport = await ensureTransporter();
    const info = await transport.sendMail({
      from,
      to: toEmail,
      replyTo: process.env.SMTP_USER || undefined,
      subject: `Invitacion al torneo ${tournamentName} - equipo ${teamName}`,
      text,
      html,
    });

    let previewUrl: string | undefined;
    if (!process.env.SMTP_HOST) {
      previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
      if (previewUrl) {
        console.log(`[mail] Invitation preview for ${toEmail}: ${previewUrl}`);
      }
    } else {
      console.log(`[mail] Invitation sent to ${toEmail} (messageId: ${info.messageId})`);
    }

    return { sent: true, previewUrl };
  } catch (err: any) {
    console.error(`[mail] Failed to send invitation to ${toEmail}:`, err.message);
    return { sent: false };
  }
}