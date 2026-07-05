// src/routes/ai-public.routes.ts
// API de IA compartible (proxy autenticado hacia nuestro Ollama self-hosted).
// NO exponemos Ollama directo (no tiene auth). Aquí ponemos API-key + rate-limit
// y una interfaz genérica (chat/generate) para que terceros (p.ej. el reproductor
// de música de un amigo) implementen lo que quieran: playlists, daily discovery,
// radios por género, etc. — todo con prompts.
import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';

const router = Router();

// Ollama: OLLAMA_URL viene con /api/chat; derivamos la base para llegar a otros paths.
const OLLAMA_URL  = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';
const OLLAMA_BASE = OLLAMA_URL.replace(/\/api\/.*$/, '');
const MODEL       = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const TIMEOUT     = Number(process.env.AI_PUBLIC_TIMEOUT || 120000);
const MAX_CHARS   = Number(process.env.AI_MAX_INPUT_CHARS || 24000); // límite de prompt/mensajes

// ── API keys (coma-separadas en env AI_API_KEYS) ──────────────────────────────
const KEYS = new Set(
  (process.env.AI_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)
);
function requireAiKey(req: Request, res: Response, next: NextFunction) {
  if (!KEYS.size) return res.status(503).json({ ok: false, error: 'AI API no configurada (falta AI_API_KEYS en el servidor)' });
  const raw = (req.header('x-api-key') || req.header('authorization') || '').trim();
  const key = raw.replace(/^Bearer\s+/i, '');
  if (!key || !KEYS.has(key)) {
    return res.status(401).json({ ok: false, error: 'API key inválida o ausente. Envía el header: x-api-key: <tu-llave>' });
  }
  (req as any).aiKey = key;
  next();
}

// ── Rate limit por llave (ventana deslizante en memoria) ──────────────────────
const RL_MAX = Number(process.env.AI_RATE_PER_MIN || 60);
const hits = new Map<string, number[]>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const id = (req as any).aiKey || req.ip || 'anon';
  const now = Date.now();
  const arr = (hits.get(id) || []).filter(t => now - t < 60000);
  if (arr.length >= RL_MAX) {
    return res.status(429).json({ ok: false, error: `Límite de ${RL_MAX} peticiones/min alcanzado. Reintenta en un momento.` });
  }
  arr.push(now);
  hits.set(id, arr);
  next();
}

// ── Docs de uso (público, sin key) ────────────────────────────────────────────
router.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'ATAK AI API',
    engine: 'ollama',
    model_default: MODEL,
    auth: 'Header  x-api-key: <tu-llave>',
    rate_limit_per_min: RL_MAX,
    endpoints: {
      'GET  /api/ai/health':  'Estado del modelo (si el host de la IA está encendido).',
      'POST /api/ai/chat':     'Chat estilo OpenAI. body: { messages:[{role,content}], model?, temperature?, json?, max_tokens? }',
      'POST /api/ai/generate': 'Completado simple. body: { prompt, system?, model?, temperature?, json? }',
    },
    tip: 'Usa json:true para obtener JSON estructurado (ideal para playlists/recomendaciones).',
  });
});

// ── Salud / disponibilidad del modelo ─────────────────────────────────────────
router.get('/health', requireAiKey, async (_req, res) => {
  try {
    const { data } = await axios.get(`${OLLAMA_BASE}/api/tags`, { timeout: 8000 });
    const models = Array.isArray(data?.models) ? data.models.map((m: any) => m.name) : [];
    res.json({ ok: true, up: true, model_default: MODEL, models });
  } catch (e: any) {
    res.status(502).json({ ok: false, up: false, error: 'El host de la IA no responde (¿PC/Ollama encendido?).' });
  }
});

type Msg = { role: string; content: string };

// ── Chat (estilo OpenAI) ──────────────────────────────────────────────────────
router.post('/chat', requireAiKey, rateLimit, async (req, res) => {
  const b = req.body || {};
  const messages: Msg[] = Array.isArray(b.messages) ? b.messages : [];
  if (!messages.length || !messages.every(m => m && typeof m.content === 'string' && typeof m.role === 'string')) {
    return res.status(400).json({ ok: false, error: 'body.messages debe ser [{ role, content }]' });
  }
  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (totalChars > MAX_CHARS) {
    return res.status(413).json({ ok: false, error: `Entrada demasiado grande (${totalChars} > ${MAX_CHARS} chars).` });
  }

  const model = (typeof b.model === 'string' && b.model.trim()) || MODEL;
  const temperature = typeof b.temperature === 'number' ? b.temperature : 0.7;
  const num_predict = typeof b.max_tokens === 'number' ? Math.min(b.max_tokens, 4096) : undefined;

  try {
    const { data } = await axios.post(`${OLLAMA_BASE}/api/chat`, {
      model,
      messages,
      stream: false,
      ...(b.json ? { format: 'json' } : {}),
      options: { temperature, ...(num_predict ? { num_predict } : {}) },
    }, { timeout: TIMEOUT });

    const content = data?.message?.content ?? '';
    res.json({
      ok: true,
      model,
      content,
      message: data?.message ?? { role: 'assistant', content },
      ...(b.json ? { json: safeJson(content) } : {}),
    });
  } catch (e: any) {
    handleOllamaError(e, res);
  }
});

// ── Generate (completado simple) ──────────────────────────────────────────────
router.post('/generate', requireAiKey, rateLimit, async (req, res) => {
  const b = req.body || {};
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) return res.status(400).json({ ok: false, error: 'body.prompt es requerido' });
  if (prompt.length > MAX_CHARS) return res.status(413).json({ ok: false, error: `Prompt demasiado grande (> ${MAX_CHARS} chars).` });

  const model = (typeof b.model === 'string' && b.model.trim()) || MODEL;
  const temperature = typeof b.temperature === 'number' ? b.temperature : 0.7;

  try {
    const { data } = await axios.post(`${OLLAMA_BASE}/api/generate`, {
      model,
      prompt,
      ...(b.system ? { system: String(b.system) } : {}),
      stream: false,
      ...(b.json ? { format: 'json' } : {}),
      options: { temperature },
    }, { timeout: TIMEOUT });

    const content = data?.response ?? '';
    res.json({ ok: true, model, content, ...(b.json ? { json: safeJson(content) } : {}) });
  } catch (e: any) {
    handleOllamaError(e, res);
  }
});

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
function handleOllamaError(e: any, res: Response) {
  const code = e?.code;
  if (code === 'ECONNABORTED') return res.status(504).json({ ok: false, error: 'La IA tardó demasiado (timeout).' });
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') {
    return res.status(502).json({ ok: false, error: 'El host de la IA no responde (¿PC/Ollama encendido?).' });
  }
  console.error('[ai-public] ollama error:', e?.response?.status, e?.message);
  res.status(502).json({ ok: false, error: 'Error hablando con el modelo.' });
}

export default router;
