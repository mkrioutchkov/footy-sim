// routes/club.ts — club operations: backroom staff (hire/fire/assignments), finances, squad
// harmony, fitness & rotation, and the club's season-by-season history. Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { getStaffView, hireStaff, fireStaff, saveCoachAssignment } from '../staff.ts';
import { getFinances } from '../finances.ts';
import { getSquadHarmony } from '../harmony.ts';
import { getRotationView, applyRotation } from '../rotation.ts';
import { getHistory, getClubRecords } from '../history.ts';
import { requireTeam } from './shared.ts';

export function registerClubRoutes(app: FastifyInstance): void {
  // Backroom staff: the club's coaches/physios/scouts + the world's hire pool + current effects.
  app.get('/api/staff', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return getStaffView(teamId);
  });
  app.post('/api/staff/hire', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const staffId = Number(req.body?.staffId);
    if (!Number.isInteger(staffId)) return reply.code(400).send({ error: 'staffId required' });
    const r = hireStaff(teamId, staffId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, ...getStaffView(teamId) };
  });
  app.post('/api/staff/fire', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const staffId = Number(req.body?.staffId);
    if (!Number.isInteger(staffId)) return reply.code(400).send({ error: 'staffId required' });
    const r = fireStaff(teamId, staffId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, ...getStaffView(teamId) };
  });

  // Save the category→coach assignment (what ACTIVATES per-category development). A missing/empty assignment reverts
  // to the flat coaching factor (byte-identical). Returns the refreshed staff view so the board re-renders.
  app.put('/api/staff/assignment', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const assignment = (req.body && typeof req.body.assignment === 'object') ? req.body.assignment : null;
    saveCoachAssignment(teamId, assignment);
    return getStaffView(teamId);
  });

  // The club's finances statement: balance, this-season income/expense by category, recent movements.
  app.get('/api/finances', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const fin = getFinances(teamId);
    if (!fin) return reply.code(404).send({ error: 'no team' });
    return fin;
  });

  // Dressing-room harmony: a read-only read of how settled the squad is (from dials + morale).
  app.get('/api/harmony', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const h = getSquadHarmony(teamId);
    if (!h) return reply.code(404).send({ error: 'no squad' });
    return h;
  });

  // Fitness & rotation guidance (§2.10): per-player fitness band + injury-risk %, and "rest X, start Y"
  // suggestions. Read-only.
  app.get('/api/rotation', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const v = getRotationView(teamId);
    if (!v) return reply.code(404).send({ error: 'no squad' });
    return v;
  });

  // Apply one rotation swap (bench a starter, start a bench player) by editing the stored XI directly.
  app.post('/api/rotation/apply', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const r = applyRotation(teamId, Number(req.body?.outSlot), Number(req.body?.inSlot));
    if (!r.ok) return reply.code(400).send({ error: r.error ?? 'could not apply' });
    return { ...r, rotation: getRotationView(teamId) };
  });

  // The club's season-by-season history + honours (populated at each rollover).
  app.get('/api/history', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { history: getHistory(teamId), records: getClubRecords(teamId) };
  });
}
