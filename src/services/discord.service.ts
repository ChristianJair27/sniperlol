// Notificaciones de torneo a Discord vía webhook (P1).
// El organizador pega la URL del webhook de su servidor en el panel; a partir
// de ahí el torneo avisa solo: código asignado, serie terminada y campeón.
// Todo fire-and-forget: Discord caído jamás afecta el flujo del torneo.

const WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export function isValidDiscordWebhook(url: string): boolean {
  return WEBHOOK_RE.test(String(url || '').trim());
}

const CRIMSON = 0xe1242e;
const GOLD = 0xc8aa6e;
const GREEN = 0x2fbf8a;

async function post(webhookUrl: string, payload: object): Promise<void> {
  if (!isValidDiscordWebhook(webhookUrl)) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ATAK.GG Torneos', ...payload }),
    });
    if (!res.ok) console.warn(`[discord] webhook respondió ${res.status}`);
  } catch (e: any) {
    console.warn('[discord] webhook falló:', e.message);
  }
}

const frontendUrl = () => process.env.WEB_ORIGIN || process.env.CLIENT_URL || 'https://atakgg.revolution505.com';

const fmtWhen = (iso?: string | null) => iso
  ? new Date(iso).toLocaleString('es-MX', { weekday: 'long', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })
  : null;

/** Código asignado a un enfrentamiento. NO publica el código (los canales de
 *  Discord suelen ser públicos): manda al correo/página, que sí son privados. */
export function notifyDiscordCodeReady(webhookUrl: string | undefined, p: {
  tournamentId: string; tournamentName: string;
  team1: string; team2: string; roundLabel?: string; scheduledAt?: string | null;
}): void {
  if (!webhookUrl) return;
  const when = fmtWhen(p.scheduledAt);
  void post(webhookUrl, {
    embeds: [{
      title: `⚔️ ${p.team1} vs ${p.team2}`,
      description:
        `El enfrentamiento ya tiene código oficial de Riot.\n`
        + (when ? `🗓️ **${when}**\n` : '')
        + `El código llegó por correo a ambos equipos y está en la página del torneo.\n`
        + `Recuerden: **cada equipo juega en su propio lado, tal como se registró.**`,
      url: `${frontendUrl()}/tournaments/${p.tournamentId}?tab=partidas`,
      color: CRIMSON,
      footer: { text: p.tournamentName + (p.roundLabel ? ` · ${p.roundLabel}` : '') },
    }],
  });
}

/** Serie terminada (resultado detectado, reporte manual o W.O.). */
export function notifyDiscordSeriesDone(webhookUrl: string | undefined, p: {
  tournamentId: string; tournamentName: string;
  winner: string; loser: string; score1: number; score2: number; forfeit?: boolean;
}): void {
  if (!webhookUrl) return;
  void post(webhookUrl, {
    embeds: [{
      title: `🏁 ${p.winner} ${Math.max(p.score1, p.score2)} – ${Math.min(p.score1, p.score2)} ${p.loser}`,
      description: p.forfeit
        ? `**${p.winner}** gana por W.O. (el rival no se presentó).`
        : `**${p.winner}** gana la serie. Stats completas en la página del torneo.`,
      url: `${frontendUrl()}/tournaments/${p.tournamentId}?tab=partidas`,
      color: GOLD,
      footer: { text: p.tournamentName },
    }],
  });
}

/** Torneo cerrado con campeón. */
export function notifyDiscordChampion(webhookUrl: string | undefined, p: {
  tournamentId: string; tournamentName: string; champion: string;
}): void {
  if (!webhookUrl) return;
  void post(webhookUrl, {
    embeds: [{
      title: `🏆 ¡${p.champion} es campeón de ${p.tournamentName}!`,
      description: `Clasificación final y estadísticas completas en ATAK.GG.`,
      url: `${frontendUrl()}/tournaments/${p.tournamentId}`,
      color: GREEN,
      footer: { text: 'ATAK.GG · resultados detectados automáticamente' },
    }],
  });
}
