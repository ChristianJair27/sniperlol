// Validación de entrada para crear y editar torneos.
//
// Antes el handler solo comprobaba que `name` y `startDate` existieran. Todo lo
// demás (nombre, descripción, premio, URLs, fechas, número de equipos) entraba
// crudo a la base y salía crudo por la API pública, que consume además la web
// de la LQC. Con la creación abierta al público eso es:
//   - texto sin tope → filas enormes y la tabla creciendo sin control,
//   - URLs sin esquema → `javascript:` guardado y servido como enlace,
//   - maxParticipants sin tope → inscripciones ilimitadas en ese torneo,
//   - startDate sin parsear → fechas basura y endDate NaN en Arena.
//
// Los topes son deliberadamente holgados: un organizador real nunca los toca.
import { z } from 'zod';

/** Texto de una línea: recorta espacios y prohíbe caracteres de control. */
const line = (max: number) =>
  z.string()
    .trim()
    .max(max)
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), 'Texto inválido');

/**
 * URL http/https únicamente.
 *
 * El esquema importa más que el formato: `javascript:alert(1)` y
 * `data:text/html,...` son URLs válidas para el parser y XSS almacenado en
 * cuanto alguien las pinta como href o src.
 */
export const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  }, 'La URL debe empezar con http:// o https://');

/** Fecha en cualquier formato que Date entienda, rechazando Invalid Date. */
const dateish = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Fecha inválida');

const GAME_MAPS = ['SR', 'ARAM', 'ARENA'] as const;
const PICK_TYPES = ['BLIND_PICK', 'DRAFT_MODE', 'ALL_RANDOM', 'TOURNAMENT_DRAFT'] as const;
const BRACKETS = ['single_elim', 'round_robin', 'swiss'] as const;

export const createTournamentSchema = z.object({
  name: line(120).min(3, 'El nombre necesita al menos 3 caracteres'),
  startDate: dateish,
  prize: line(200).optional(),
  format: line(200).optional(),
  description: z.string().trim().max(2000).optional(),
  // 256 equipos es más de lo que cualquier liga amateur mueve, y acota el coste
  // de generar códigos y de pintar el bracket.
  maxParticipants: z.coerce.number().int().min(2).max(256).optional(),
  checkinDeadline: dateish.optional(),
  isPrivate: z.coerce.boolean().optional(),
  createRiot: z.boolean().optional(),
  gameMap: z.enum(GAME_MAPS).optional(),
  teamSize: z.coerce.number().int().min(1).max(5).optional(),
  pickType: z.enum(PICK_TYPES).optional(),
  bracketType: z.enum(BRACKETS).optional(),
  seriesTo: z.coerce.number().int().min(1).max(3).optional(),
  finalSeriesTo: z.coerce.number().int().min(1).max(3).optional(),
  swissRounds: z.coerce.number().int().min(1).max(12).optional(),
  durationHours: z.coerce.number().int().min(1).max(72).optional(),
});

export type CreateTournamentBody = z.infer<typeof createTournamentSchema>;

/** Campos de texto y enlaces que admite PATCH /:id. El resto ya se validaba. */
export const patchTournamentTextSchema = z.object({
  name: line(120).min(3).optional(),
  prize: line(200).optional(),
  description: z.string().trim().max(2000).optional(),
  season: line(60).optional(),
  patch: line(20).optional(),
  logoUrl: httpUrl.nullable().optional(),
  bannerUrl: httpUrl.nullable().optional(),
  rulesUrl: httpUrl.nullable().optional(),
  registrationUrl: httpUrl.nullable().optional(),
});

/** Primer mensaje de error de zod, ya en castellano legible. */
export function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Datos inválidos';
  const field = i.path.join('.');
  return field ? `${field}: ${i.message}` : i.message;
}
