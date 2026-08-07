// routes/auth.ts — account/session routes: register / login / logout / me. Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { registerUser, loginUser, destroySession } from '../auth.ts';
import { teamForUser } from '../game.ts';
import { currentUser, setSession } from './shared.ts';

export function registerAuthRoutes(app: FastifyInstance): void {
  // ── auth routes ──
  app.post('/api/register', async (req: any, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password || String(username).length < 2 || String(password).length < 4)
      return reply.code(400).send({ error: 'username (2+) and password (4+) required' });
    try {
      const user = registerUser(String(username).trim().slice(0, 32), String(password));
      setSession(reply, user.id);
      return { user };
    } catch { return reply.code(409).send({ error: 'username taken' }); }
  });

  app.post('/api/login', async (req: any, reply) => {
    const { username, password } = req.body ?? {};
    const user = loginUser(String(username ?? '').trim(), String(password ?? ''));
    if (!user) return reply.code(401).send({ error: 'invalid credentials' });
    setSession(reply, user.id);
    return { user };
  });

  app.post('/api/logout', async (req: any, reply) => {
    destroySession(req.cookies?.sid);
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req: any) => {
    const user = currentUser(req);
    if (!user) return { user: null };
    return { user, teamId: teamForUser(user.id) };
  });
}
