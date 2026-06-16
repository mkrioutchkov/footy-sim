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
export interface PlayerT { slot: number; name: string; role: string; attrs: Record<string, number>; personality?: PersonalityT | null; age?: number; potential?: number | null; listed?: boolean; askPrice?: number | null; wage?: number; contractYears?: number; fitness?: number; injuredMatches?: number; morale?: number; }
export interface TeamT {
  id: number; name: string; manager: string; leagueId: number;
  userId: number | null; tactics: Tactics; players: PlayerT[];
  formation: string; lineup: number[] | null; budget?: number; trainingFocus?: string;
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
export interface DivisionT { tier: number; name: string; season: number; standings: StandingT[]; }
export interface LeagueT {
  leagueId: number; myTeamId: number; standings: StandingT[]; fixtures: FixtureT[];
  season?: number; tier?: number; divisionName?: string; world?: DivisionT[]; seasonComplete?: boolean;
}
export interface RolloverT {
  season: number;
  divisions: { tier: number; name: string; champion: string }[];
  promoted: { teamId: number; team: string; fromTier: number; toTier: number }[];
  relegated: { teamId: number; team: string; fromTier: number; toTier: number }[];
  prizeMoney: { teamId: number; team: string; amount: number }[];
  contracts: { teamId: number; player: string; type: 'renewed' | 'released' }[];
  youth: { teamId: number; type: 'retired' | 'intake'; player: string; age: number }[];
}
export interface FreeAgentT { id: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; }
export interface MarketPlayerT { slot: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; contractYears: number; listed: boolean; askPrice: number | null; starter: boolean; }
export interface TransferWindowT { open: boolean; window: 'summer' | 'winter' | null; current: number; total: number; label: string; }
export interface TransferTargetT { id: number; name: string; club: string; clubTeamId: number; role: string; age: number; overall: number; potential: number | null; value: number; askPrice: number | null; wage: number; }
export interface MarketT { budget: number; wageBudget: number; wageBill: number; squadMax: number; squadMin: number; window: TransferWindowT; freeAgents: FreeAgentT[]; squad: MarketPlayerT[]; transferTargets: TransferTargetT[]; }
export interface TransferT { teamId: number; teamName: string; type: 'sign' | 'buy_listed'; player: string; role: string; fee: number; from?: string; }
export interface CupTieT { id: number; round: number; slot: number; home: string | null; away: string | null; homeTeamId: number | null; awayTeamId: number | null; played: boolean; homeScore: number | null; awayScore: number | null; winnerTeamId: number | null; }
export interface CupT { rounds: { round: number; name: string; ties: CupTieT[] }[]; totalRounds: number; champion: string | null; myTeamId: number; }

export interface PlayerRatingT { id: number; name: string; team: 'home' | 'away'; role: string; rating: number; goals: number; assists: number; shots: number; tackles: number; }
export interface TimelineEventT { minute: number; team: 'home' | 'away'; name: string; type: 'goal' | 'yellow' | 'red'; }
export interface MatchFactsT { homeScore: number; awayScore: number; possessionHome: number; shots: { home: number; away: number }; shotsOnTarget: number; saves: number; corners: number; timeline: TimelineEventT[]; ratings: PlayerRatingT[]; }
export interface ReportT { homeName: string; awayName: string; headline: string; body: string; facts: MatchFactsT; ratings: PlayerRatingT[]; }

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
  advance: () => req<{ round: number; myFixtureId: number; myResult: { homeScore: number; awayScore: number } | null; transfers: TransferT[]; development?: { players: number }; injuries?: { teamId: number; player: string; matches: number }[]; cup?: { round: number; champion: number | null; myTie: { homeScore: number; awayScore: number; opponent: string; won: boolean } | null } | null; rollover?: RolloverT | null; standings: StandingT[] }>('POST', '/advance'),
  cup: () => req<CupT>('GET', '/cup'),
  market: () => req<MarketT>('GET', '/market'),
  buyAgent: (agentId: number) => req<{ ok: boolean; placed: 'xi' | 'bench'; value: number; name: string; market: MarketT }>('POST', '/market/buy', { agentId }),
  listPlayer: (slot: number, price?: number) => req<{ ok: boolean; askPrice: number; value: number; market: MarketT }>('POST', '/market/list', { slot, price }),
  unlistPlayer: (slot: number) => req<{ ok: boolean; market: MarketT }>('POST', '/market/unlist', { slot }),
  bid: (playerId: number, fee: number) => req<{ ok: boolean; status: 'accepted' | 'countered' | 'rejected'; counterFee?: number; player?: string; club?: string; fee?: number; placed?: 'xi' | 'bench'; error?: string; market: MarketT }>('POST', '/transfer/bid', { playerId, fee }),
  setTraining: (focus: string) => req<{ ok: boolean; focus: string }>('PUT', '/training', { focus }),
  setPlayerStory: (slot: number, backstory: string, tagline: string) =>
    req<{ slot: number; personality: PersonalityT; value: number }>('PUT', `/player/${slot}/story`, { backstory, tagline }),
  press: (text: string) => req<{ reactions: { slot: number; name: string; delta: number }[]; lifted: number; unsettled: number; team: TeamT }>('POST', '/press', { text }),
  renewPlayer: (slot: number, years?: number) =>
    req<{ ok: boolean; wage: number; years: number }>('PUT', `/player/${slot}/renew`, { years }),
  report: (fixtureId: number) => req<ReportT>('GET', `/report?fixture=${fixtureId}`),
};
