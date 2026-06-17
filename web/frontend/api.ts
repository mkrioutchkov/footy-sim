// Thin client for the game backend. Same-origin in prod; Vite proxies /api in dev.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
  } catch {
    // Network failure (offline, server down) — fetch rejects rather than resolving.
    throw new ApiError(0, 'Network error — is the server running?');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data && (data.error as string)) || `HTTP ${res.status}`);
  return data as T;
}

export interface UserT { id: number; username: string; }
export interface Tactics {
  aggression: number; passingDirectness: number; overlapFrequency: number;
  midfieldFreedom: number; defensiveLineHeight: number;
}
export interface DirectiveT { playerId: number; kind: string; targetId?: number; teamScope?: number; intensity?: number; when?: { fromMin?: number; toMin?: number; scoreState?: string; scoreBy?: number }; }
export interface PlanT { summary: string; directives: DirectiveT[]; }
export interface PersonalityT {
  traits: { temperament: number; criticismResponse: number; praiseResponse: number; bigGame: number; consistency: number; leadership: number; professionalism: number; ego: number };
  nationality: string; backstory: string; tagline: string;
}
export interface PlayerT { slot: number; name: string; role: string; attrs: Record<string, number>; personality?: PersonalityT | null; age?: number; potential?: number | null; listed?: boolean; askPrice?: number | null; wage?: number; contractYears?: number; fitness?: number; injuredMatches?: number; morale?: number; }
export interface TeamT {
  id: number; name: string; manager: string; leagueId: number;
  userId: number | null; tactics: Tactics; players: PlayerT[];
  formation: string; lineup: number[] | null; budget?: number; trainingFocus?: string;
  planText?: string | null; plan?: PlanT | null;
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
export interface ObjectiveT { kind: string; target: number; season: number; label: string; }
export interface LeagueT {
  leagueId: number; myTeamId: number; standings: StandingT[]; fixtures: FixtureT[];
  season?: number; tier?: number; divisionName?: string; world?: DivisionT[]; seasonComplete?: boolean;
  objective?: ObjectiveT | null; promote?: number;
  confidence?: { value: number; status: string } | null; boardMood?: string | null;
}
export interface RolloverT {
  season: number;
  divisions: { tier: number; name: string; champion: string }[];
  promoted: { teamId: number; team: string; fromTier: number; toTier: number }[];
  relegated: { teamId: number; team: string; fromTier: number; toTier: number }[];
  prizeMoney: { teamId: number; team: string; amount: number }[];
  contracts: { teamId: number; player: string; type: 'renewed' | 'released' }[];
  youth: { teamId: number; type: 'retired' | 'intake'; player: string; age: number }[];
  board?: { teamId: number; tone: string; message: string }[];
}
export interface FreeAgentT { id: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; }
export interface MarketPlayerT { slot: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; contractYears: number; listed: boolean; askPrice: number | null; starter: boolean; onLoan: boolean; }
export interface TransferWindowT { open: boolean; window: 'summer' | 'winter' | null; current: number; total: number; label: string; }
export interface TransferTargetT { id: number; name: string; club: string; clubTeamId: number; role: string; age: number; overall: number; potential: number | null; value: number; askPrice: number | null; wage: number; }
export interface MarketT { budget: number; wageBudget: number; wageBill: number; squadMax: number; squadMin: number; window: TransferWindowT; freeAgents: FreeAgentT[]; squad: MarketPlayerT[]; transferTargets: TransferTargetT[]; backing?: string | null; }
export interface TransferT { teamId: number; teamName: string; type: 'sign' | 'buy_listed'; player: string; role: string; fee: number; from?: string; }
export interface CupTieT { id: number; round: number; slot: number; home: string | null; away: string | null; homeTeamId: number | null; awayTeamId: number | null; played: boolean; homeScore: number | null; awayScore: number | null; winnerTeamId: number | null; }
export interface CupT { rounds: { round: number; name: string; ties: CupTieT[] }[]; totalRounds: number; champion: string | null; myTeamId: number; }

export interface PlayerRatingT { id: number; name: string; team: 'home' | 'away'; role: string; rating: number; goals: number; assists: number; shots: number; tackles: number; }
export interface TimelineEventT { minute: number; team: 'home' | 'away'; name: string; type: 'goal' | 'yellow' | 'red'; }
export interface MatchFactsT { homeScore: number; awayScore: number; possessionHome: number; shots: { home: number; away: number }; shotsOnTarget: number; saves: number; corners: number; timeline: TimelineEventT[]; ratings: PlayerRatingT[]; }
export interface ReportT { homeName: string; awayName: string; headline: string; body: string; facts: MatchFactsT; ratings: PlayerRatingT[]; }

export interface NewsItemT { player: string; type: 'hat_trick' | 'brace' | 'red_card' | 'star' | 'long_injury' | 'pots' | 'young_pots'; headline: string; season: number; slot: number; }

export interface ScoutAttrT { key: string; lo: number; hi: number; }
export interface ScoutPlayerT { name: string; role: string; age: number; overall: number; potential: number | null; danger: boolean; attrs: ScoutAttrT[] | null; }
export interface ScoutFormT { round: number; opponent: string; venue: 'H' | 'A'; gf: number; ga: number; result: 'W' | 'D' | 'L'; }
export interface ScoutT {
  opponent: { teamId: number; name: string; manager: string; formation: string; position: number | null;
    played: number; won: number; drawn: number; lost: number; gf: number; ga: number; gd: number; points: number; };
  venue: 'home' | 'away'; round: number; approach: string[]; form: ScoutFormT[]; keyPlayers: ScoutPlayerT[];
}

export interface StaffMemberT { id: number; role: 'coach' | 'physio' | 'scout'; name: string; rating: number; cost: number; }
export interface StaffEffectsT { training: number; injuryReduction: number; recoverBonus: number; scoutDepth: number; }
export interface StaffViewT { staff: StaffMemberT[]; pool: StaffMemberT[]; budget: number; max: number; effects: StaffEffectsT; }

export interface FinanceEntryT { season: number; kind: string; amount: number; note: string; }
export interface FinanceSeasonT { season: number; income: number; expense: number; net: number; }
export interface FinancesT {
  balance: number; season: number; income: number; expense: number;
  wageBill: number; wageBudget: number;
  byKind: { kind: string; amount: number }[]; recent: FinanceEntryT[]; history: FinanceSeasonT[];
}

export interface HarmonyPlayerT { slot: number; name: string; tag: 'leader' | 'pro' | 'disruptive' | 'unsettled'; note: string; }
export interface HarmonyT { harmony: number; status: 'united' | 'settled' | 'restless' | 'fractured'; avgMorale: number; players: HarmonyPlayerT[]; }

export interface ClubRecordsT {
  seasons: number; titles: number; promotions: number; relegations: number; cups: number;
  bestFinish: { position: number; tier: number; season: number } | null;
  mostPoints: { points: number; season: number } | null;
  mostGoals: { gf: number; season: number } | null;
}
export interface SeasonHistoryT {
  season: number; tier: number; division: string; position: number;
  played: number; won: number; drawn: number; lost: number; gf: number; ga: number; points: number;
  champion: boolean; promoted: boolean; relegated: boolean; cupWon: boolean; pots: string | null;
  objective: { kind: string; target: number; met: boolean } | null;
  board: { tone: string; message: string; confidence: number } | null;
}

export const api = {
  me: () => req<{ user: UserT | null; teamId?: number | null }>('GET', '/me'),
  register: (username: string, password: string) => req<{ user: UserT }>('POST', '/register', { username, password }),
  login: (username: string, password: string) => req<{ user: UserT }>('POST', '/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/logout'),
  createTeam: (name: string, tactics?: Tactics) => req<{ teamId: number; leagueId: number }>('POST', '/team', { name, tactics }),
  team: () => req<TeamT>('GET', '/team'),
  setTactics: (tactics: Tactics) => req<{ tactics: Tactics }>('PUT', '/tactics', { tactics }),
  teamPlan: (text: string) => req<{ planText: string; plan: PlanT; note: string; error: string | null }>('POST', '/team/plan', { text }),
  setLineup: (text: string) => req<LineupResultT>('PUT', '/lineup', { text }),
  generatePersonalities: () => req<TeamT>('POST', '/personalities', {}),   // send a body so Fastify can't 415 on a bodyless POST
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
  loan: (playerId: number) => req<{ ok: boolean; player?: string; from?: string; market: MarketT }>('POST', '/transfer/loan', { playerId }),
  setTraining: (focus: string) => req<{ ok: boolean; focus: string }>('PUT', '/training', { focus }),
  setPlayerStory: (slot: number, backstory: string, tagline: string) =>
    req<{ slot: number; personality: PersonalityT; value: number }>('PUT', `/player/${slot}/story`, { backstory, tagline }),
  press: (text: string) => req<{ reactions: { slot: number; name: string; delta: number; quote?: string }[]; lifted: number; unsettled: number; team: TeamT }>('POST', '/press', { text }),
  renewPlayer: (slot: number, years?: number) =>
    req<{ ok: boolean; wage: number; years: number }>('PUT', `/player/${slot}/renew`, { years }),
  report: (fixtureId: number) => req<ReportT>('GET', `/report?fixture=${fixtureId}`),
  scout: (fixtureId: number) => req<ScoutT>('GET', `/scout?fixture=${fixtureId}`),
  news: () => req<{ news: NewsItemT[] }>('GET', '/news'),
  history: () => req<{ history: SeasonHistoryT[]; records: ClubRecordsT }>('GET', '/history'),
  staff: () => req<StaffViewT>('GET', '/staff'),
  hireStaff: (staffId: number) => req<StaffViewT & { name?: string }>('POST', '/staff/hire', { staffId }),
  fireStaff: (staffId: number) => req<StaffViewT>('POST', '/staff/fire', { staffId }),
  finances: () => req<FinancesT>('GET', '/finances'),
  harmony: () => req<HarmonyT>('GET', '/harmony'),
};
