// Límites de tasa por ruta.
//
// Hasta ahora la API no tenía ninguno. Con el torneo de la LQC como único
// usuario no importaba; al abrir la creación de torneos al público sí: sin
// límite, un script registra miles de cuentas, crea miles de torneos y agota
// la llave de Riot, que es un recurso compartido e irreemplazable.
//
// IMPORTANTE: esto depende de `app.set('trust proxy', 1)` en server.ts. Detrás
// del proxy de Coolify, sin esa línea, todas las peticiones comparten la IP del
// proxy y un solo abusador bloquearía a todo el mundo.
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';

/** Minutos a milisegundos, para que las ventanas se lean de un vistazo. */
const min = (n: number) => n * 60_000;

function deny(message: string) {
  return (_req: Request, res: Response) => {
    res.status(429).json({ error: message, code: 'RATE_LIMITED' });
  };
}

/**
 * Cuenta por usuario autenticado cuando lo hay, y por IP cuando no.
 *
 * Por IP sola sería injusto: una universidad o un café entero sale por la
 * misma IP. Por usuario sola sería inútil: crear cuentas es gratis. Se usa el
 * identificador más específico disponible.
 *
 * `ipKeyGenerator` normaliza IPv6 a su prefijo /56; usarlo es obligatorio en
 * express-rate-limit v8 para no dejar un hueco trivial de evasión.
 */
function userOrIp(req: Request): string {
  const userId = (req as any).auth?.userId;
  return userId ? `u:${userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

const base: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/**
 * Registro, login y recuperación de contraseña.
 *
 * `verifyPassword` usa scryptSync, que es SÍNCRONO: cada intento bloquea el
 * hilo de Node. Sin este límite, una avalancha de credenciales no solo es
 * fuerza bruta, también tumba el servidor entero.
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: min(15),
  limit: 12,
  handler: deny('Demasiados intentos. Espera unos minutos y vuelve a intentar.'),
});

/** Creación de torneos: generosa para un organizador real, letal para un bot. */
export const createTournamentLimiter = rateLimit({
  ...base,
  windowMs: min(60),
  limit: 12,
  keyGenerator: userOrIp,
  handler: deny('Has creado demasiados torneos seguidos. Intenta de nuevo en una hora.'),
});

/**
 * Cualquier cosa que mande correo. Un correo saliente con texto que controla
 * el atacante es la vía más rápida para que nos marquen como spam y perdamos
 * el dominio para siempre.
 */
export const emailLimiter = rateLimit({
  ...base,
  windowMs: min(60),
  limit: 40,
  keyGenerator: userOrIp,
  handler: deny('Demasiadas invitaciones seguidas. Intenta de nuevo en una hora.'),
});

/**
 * Rutas que gastan cuota de la API de Riot. El límite es bajo a propósito: la
 * llave es compartida por toda la plataforma y si Riot la suspende se cae todo,
 * no solo quien abusó.
 */
export const riotLimiter = rateLimit({
  ...base,
  windowMs: min(5),
  limit: 20,
  keyGenerator: userOrIp,
  handler: deny('Demasiadas sincronizaciones seguidas. Espera unos minutos.'),
});

/** API pública de solo lectura: holgada, pero con techo. */
export const publicApiLimiter = rateLimit({
  ...base,
  windowMs: min(1),
  limit: 120,
  handler: deny('Demasiadas peticiones. Reduce el ritmo.'),
});

/**
 * Callback de Riot. No lleva autenticación por diseño (Riot no firma sus
 * llamadas), así que el techo es la única defensa contra que lo usen de ariete.
 */
export const callbackLimiter = rateLimit({
  ...base,
  windowMs: min(1),
  limit: 90,
  handler: deny('Too many requests'),
});
