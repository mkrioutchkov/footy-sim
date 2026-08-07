// routes/training.ts — training: club focus, per-player focus/intensity overrides, the club
// intensity dial, one-click presets, position retraining, and the matchday training report.
// Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { setTrainingFocus, setPlayerTrainingFocus, setPlayerTrainingIntensity, setTeamTrainingIntensity, applyTrainingPreset, TRAINING_PRESETS, setPlayerRetrain, RETRAIN_ROLES, getTrainingReport, TRAINABLE, VALID_FOCUS, VALID_INTENSITY, VALID_TEAM_INTENSITY } from '../training.ts';
import { requireTeam, idParam } from './shared.ts';

export function registerTrainingRoutes(app: FastifyInstance): void {
  // Set the club's training focus ('balanced' or a trainable attribute). Drives the
  // development tick that runs each matchday.
  app.put('/api/training', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const focus = String(req.body?.focus ?? '');
    if (!VALID_FOCUS.has(focus)) return reply.code(400).send({ error: `focus must be one of: balanced, position, ${TRAINABLE.join(', ')}` });
    return setTrainingFocus(teamId, focus);
  });

  // Set ONE player's training focus, overriding the club focus (audit §2.7). An empty value (or
  // 'club') clears the override so he follows the club focus again.
  app.put('/api/training/player', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    const focus = String(req.body?.focus ?? '');
    // a non-empty focus must be valid; '' / 'club' are the allowed "clear" sentinels
    if (focus && focus !== 'club' && !VALID_FOCUS.has(focus)) return reply.code(400).send({ error: `focus must be one of: balanced, position, ${TRAINABLE.join(', ')}` });
    const r = setPlayerTrainingFocus(teamId, slot, focus);
    if (!r.ok) return reply.code(404).send({ error: 'no such player in your squad' });
    return r;
  });

  // Set ONE player's training intensity (double|normal|half|rest). ''/'normal'/invalid clears to the normal default.
  app.put('/api/training/player-intensity', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    const value = String(req.body?.value ?? '');
    if (value && value !== 'normal' && !VALID_INTENSITY.has(value)) return reply.code(400).send({ error: 'intensity must be one of: double, normal, half, rest' });
    const r = setPlayerTrainingIntensity(teamId, slot, value);
    if (!r.ok) return reply.code(404).send({ error: 'no such player in your squad' });
    return r;
  });

  // Set the CLUB-WIDE training intensity dial (light|normal|heavy). 'normal'/invalid = the byte-identical
  // default; the whole squad trains at this level unless a player carries his own intensity override.
  app.put('/api/training/team-intensity', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const level = String(req.body?.value ?? '');
    if (level && !VALID_TEAM_INTENSITY.has(level)) return reply.code(400).send({ error: 'intensity must be one of: light, normal, heavy' });
    return setTeamTrainingIntensity(teamId, level);
  });

  // Apply a one-click training PRESET (a named focus + club-intensity schedule). Sets both the club
  // focus and the club intensity dial in one go (per-player overrides untouched).
  app.put('/api/training/preset', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const name = String(req.body?.name ?? '');
    if (!Object.prototype.hasOwnProperty.call(TRAINING_PRESETS, name)) return reply.code(400).send({ error: `preset must be one of: ${Object.keys(TRAINING_PRESETS).join(', ')}` });
    const r = applyTrainingPreset(teamId, name);
    if (!r.ok) return reply.code(400).send({ error: r.error ?? 'could not apply preset' });
    return r;
  });

  // Start/clear a position RETRAIN for one player ('' or his current role clears it → he settles).
  // A valid different role starts a settling-in period during which he develops a little slower.
  app.put('/api/training/retrain', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    const role = String(req.body?.role ?? '');
    if (role && role !== 'clear' && !(RETRAIN_ROLES as readonly string[]).includes(role)) return reply.code(400).send({ error: `role must be one of: ${RETRAIN_ROLES.join(', ')}` });
    const r = setPlayerRetrain(teamId, slot, role === 'clear' ? '' : role);
    if (!r.ok) return reply.code(404).send({ error: 'no such player in your squad' });
    return r;
  });

  // The latest per-matchday training report for the club (null until the first matchday develops
  // the squad): attribute drift per player + the factors behind it + the staff/harmony contribution.
  app.get('/api/training-report', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { report: getTrainingReport(teamId) };
  });
}
