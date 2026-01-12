// src/routes/tournaments.routes.ts
import { Router } from 'express';
import { createProvider, createTournament, generateCodes } from '../services/riot-tournament.js';

const router = Router();

// Datos stub base
const tournamentsStub = [
  {
    id: 'lqc-split-primavera-2026',
    name: 'LQC Split Primavera 2026',
    status: 'abiertas',
    participants: 22,
    maxParticipants: 32,
    prize: '$15,000 MXN + Skins + Trofeo',
    startDate: '2026-03-15',
    format: 'Liga regular + Playoffs Double Elimination',
    description: 'Torneo oficial de la Liga Queretana. Clasifica a playoffs y compite por el título.',
  },
  {
    id: 'copa-atak-2026',
    name: 'Copa ATAK.GG x LQC',
    status: 'abiertas',
    participants: 48,
    maxParticipants: 64,
    prize: 'RP, Skins y Coaching profesional',
    startDate: '2026-02-20',
    format: '5v5 Single Elimination',
    description: 'Torneo abierto comunitario con premios para todos los rangos.',
  },
  {
    id: 'lqc-otono-2025',
    name: 'LQC Otoño 2025',
    status: 'finalizado',
    participants: 28,
    maxParticipants: 32,
    prize: '$12,000 MXN',
    startDate: '2025-09-10',
    format: 'Liga + Playoffs',
    description: 'Campeón: Team Eclipse QRO',
    standings: [
      { position: 1, team: 'Eclipse QRO', wins: 9, losses: 0, points: 27 },
      { position: 2, team: 'Dragones Querétaro', wins: 7, losses: 2, points: 21 },
      { position: 3, team: 'Corregidora Warriors', wins: 6, losses: 3, points: 18 },
      { position: 4, team: 'ATAK Academy', wins: 5, losses: 4, points: 15 },
      { position: 5, team: 'Santiago Knights', wins: 4, losses: 5, points: 12 },
    ],
  },
];

// Copia dinámica para modificar participantes en tiempo de ejecución
let dynamicTournaments = tournamentsStub.map(t => ({ ...t }));

// Mapa de inscripciones en memoria
const registrations = new Map<string, any[]>();

// GET: Lista de torneos
router.get('/', (req, res) => {
  res.json(dynamicTournaments.map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    participants: t.participants,
    maxParticipants: t.maxParticipants,
    prize: t.prize,
    startDate: t.startDate,
    format: t.format,
    description: t.description,
  })));
});

// GET: Detalles de un torneo
router.get('/:id', (req, res) => {
  const tournament = dynamicTournaments.find(t => t.id === req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });

  const response: any = {
    id: tournament.id,
    name: tournament.name,
    status: tournament.status,
    participants: tournament.participants,
    maxParticipants: tournament.maxParticipants,
    prize: tournament.prize,
    startDate: tournament.startDate,
    format: tournament.format,
    description: tournament.description,
  };

  if ((tournament as any).standings) {
    response.standings = (tournament as any).standings;
  }

  res.json(response);
});

// POST: Inscribir equipo (incrementa participantes)
router.post('/:id/register', (req, res) => {
  const { id } = req.params;
  const { teamName, captainRiotId, players, contact } = req.body;

  if (!teamName || !captainRiotId || !players || players.length < 5) {
    return res.status(400).json({ error: 'Datos incompletos o menos de 5 jugadores' });
  }

  const tournamentIndex = dynamicTournaments.findIndex(t => t.id === id);
  if (tournamentIndex === -1) return res.status(404).json({ error: 'Torneo no encontrado' });

  const tournament = dynamicTournaments[tournamentIndex];
  if (tournament.status !== 'abiertas') {
    return res.status(400).json({ error: 'Inscripciones cerradas' });
  }

  // Incrementar participantes
  dynamicTournaments[tournamentIndex].participants += 1;

  // Guardar inscripción
  if (!registrations.has(id)) registrations.set(id, []);
  registrations.get(id)!.push({ teamName, captainRiotId, players, contact });

  console.log(`Equipo inscrito: ${teamName} en ${tournament.name}`);

  res.json({
    success: true,
    message: '¡Equipo inscrito correctamente!',
    teamName,
    currentParticipants: dynamicTournaments[tournamentIndex].participants,
  });
});

// GET: Equipos inscritos en un torneo
router.get('/:id/registrations', (req, res) => {
  const { id } = req.params;
  const regs = registrations.get(id) || [];
  res.json(regs);
});

// POST: Crear torneo oficial Riot + códigos
router.post('/create-riot', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre del torneo requerido' });

  try {
    let providerId = req.app.locals.riotProviderId;
if (!providerId) {
  const provider = await createProvider();
  providerId = provider.id;
  req.app.locals.riotProviderId = providerId;
  console.log('Provider ID guardado para reutilizar:', providerId);
}

    const tournament = await createTournament(providerId, name);
    const codes = await generateCodes(tournament.id, 32);

    res.json({
      success: true,
      riotTournamentId: tournament.id,
      codes,
      message: '¡Torneo oficial creado! Comparte los códigos en el cliente de LoL.',
    });
  } catch (err: any) {
    console.error('Error completo:', err);
    res.status(500).json({ 
      error: err.message || 'Error creando torneo oficial Riot' 
    });
  }
});

router.post('/tournament-callback', (req, res) => {
  console.log('Callback recibido de Riot:', req.body);
  res.status(200).send('OK');
});

export default router;