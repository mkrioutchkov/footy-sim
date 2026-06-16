// Thin client for the game backend. Same-origin in prod; Vite proxies /api in dev.

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.error as string)) || `HTTP ${res.status}`);
  return data as T;
}

export interface UserT { id: number; username: string; }
export interface Tactics {
  aggression: number; passingDirectness: number; overlapFrequency: number;
  midfieldFreedom: number; defensiveLineHeight: number;
}
export interface PersonalityT {
  traits: { temperament: number; criticismResponse: number; praiseResponse: number; bigGame: number; consistency: number; leadership: number; professionalism: number; ego: number };
  nationality: string; backstory: string; tagline: string;
}
export interface PlayerT { slot: number; name: string; role: string; attrs: Record<string, number>; personality?: PersonalityT | null; }
export interface TeamT {
  id: number; name: string; manager: string; leagueId: number;
  userId: number | null; tactics: Tactics; players: PlayerT[];
  formation: string; lineup: number[] | null;
}
export interface LineupSlotT { slot: number; role: string; homeX: number; homeY: number; playerName: string; fromSlot: number; }
export interface LineupResultT { formation: string; lineup: number[] | null; slots: LineupSlotT[]; note: string; }
export interface StandingT {
  teamId: number; name: string; manager: string; isUser: boolean;
  played: number; won: number; drawn: number; lost: number;
  gf: number; ga: number; gd: number; points: number;
}
export interface FixtureT {
  id: number; round: number; home: string; away: string;
  homeTeamId: number; awayTeamId: number; played: boolean;
  homeScore: number | null; awayScore: number | null; involvesMe: boolean;
}
export interface LeagueT { leagueId: number; myTeamId: number; standings: StandingT[]; fixtures: FixtureT[]; }

export const api = {
  me: () => req<{ user: UserT | null; teamId?: number | null }>('GET', '/me'),
  register: (username: string, password: string) => req<{ user: UserT }>('POST', '/register', { username, password }),
  login: (username: string, password: string) => req<{ user: UserT }>('POST', '/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/logout'),
  createTeam: (name: string, tactics?: Tactics) => req<{ teamId: number; leagueId: number }>('POST', '/team', { name, tactics }),
  team: () => req<TeamT>('GET', '/team'),
  setTactics: (tactics: Tactics) => req<{ tactics: Tactics }>('PUT', '/tactics', { tactics }),
  setLineup: (text: string) => req<LineupResultT>('PUT', '/lineup', { text }),
  generatePersonalities: () => req<TeamT>('POST', '/personalities'),
  league: () => req<LeagueT>('GET', '/league'),
  playFixture: (id: number) => req<{ result: { homeScore: number; awayScore: number; alreadyPlayed: boolean }; standings: StandingT[] }>('POST', `/fixtures/${id}/play`),
  playNext: () => req<{ fixtureId: number; result: { homeScore: number; awayScore: number }; standings: StandingT[] }>('POST', '/play-next'),
  advance: () => req<{ round: number; myFixtureId: number; myResult: { homeScore: number; awayScore: number } | null; standings: StandingT[] }>('POST', '/advance'),
};
