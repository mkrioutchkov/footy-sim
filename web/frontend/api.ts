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
  // read the body once as text so a malformed 200 surfaces as a real error (caught by the screen's try/catch)
  // instead of a null silently cast to T that crashes the screen downstream ("cannot read X of null"). An empty
  // body (incl. 204) legitimately stays null — only a NON-empty body that fails to parse is treated as malformed.
  let data: unknown = null;
  let rawText = '';
  if (res.status !== 204) {
    rawText = await res.text().catch(() => '');
    if (rawText) {
      try { data = JSON.parse(rawText); }
      catch { if (res.ok) throw new ApiError(res.status, 'The server sent a malformed response.'); }
    }
  }
  // Session expired / not logged in: notify the app once so it can drop the stale in-memory user and return
  // to the login screen, instead of every protected screen printing a raw "not logged in" under a live URL.
  if (res.status === 401) { try { window.dispatchEvent(new Event('footy:auth-expired')); } catch { /* non-browser */ } }
  if (!res.ok) {
    const serverMsg = (data as { error?: string } | null)?.error;
    // A non-JSON error body (a proxy's plain-text "Bad Gateway", an upstream 500) is otherwise discarded → the
    // user only ever sees "HTTP 502". Surface a short, non-HTML body as the message; else fall back to the code.
    const bodyMsg = !serverMsg && rawText && rawText.length <= 200 && !/<[a-z!]/i.test(rawText) ? rawText.trim() : '';
    throw new ApiError(res.status, serverMsg || bodyMsg || `HTTP ${res.status}`);
  }
  return data as T;
}

export interface UserT { id: number; username: string; isAdmin?: boolean; }
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
export interface PlayerT { slot: number; name: string; role: string; attrs: Record<string, number>; personality?: PersonalityT | null; age?: number; potential?: number | null; listed?: boolean; askPrice?: number | null; wage?: number; contractYears?: number; fitness?: number; injuredMatches?: number; morale?: number; trainFocus?: string | null; trainIntensity?: string | null; retrainRole?: string | null; roleFamiliarity?: number; seasonGoals?: number; seasonAssists?: number; seasonApps?: number; seasonRatingSum?: number; nationality?: string; }
export interface NationT { key: string; name: string; flag: string; confed: string; }
export interface PlayerSeasonStatT { season: number; club: string; role: string; goals: number; assists: number; apps: number; avgRating: number; }
export interface AttrSnapshotT { season: number; round: number; ovr: number; attrs: Record<string, number>; }
export interface TeamT {
  id: number; name: string; manager: string; leagueId: number;
  userId: number | null; tactics: Tactics; players: PlayerT[];
  formation: string; lineup: number[] | null; budget?: number; wageBudget?: number; wageBill?: number; trainingFocus?: string; trainingIntensity?: string; sacked?: boolean; captainSlot?: number | null;
  planText?: string | null; plan?: PlanT | null;
  setPieceTakers?: { fk: number | null; corner: number | null; pen: number | null; longThrow: number | null } | null;
}
export interface LineupSlotT { slot: number; role: string; homeX: number; homeY: number; playerName: string; fromSlot: number; misfit?: boolean; }
export interface FormationsT { pitchW: number; pitchH: number; formations: Record<string, { role: string; x: number; y: number }[]>; }
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
  weather?: 'clear' | 'rain' | 'wind';
}
export interface DivisionT { tier: number; name: string; season: number; standings: StandingT[]; }
export interface ObjectiveT { kind: string; target: number; season: number; label: string; }
export interface LeagueT {
  leagueId: number; myTeamId: number; standings: StandingT[]; fixtures: FixtureT[];
  season?: number; tier?: number; divisionName?: string; world?: DivisionT[]; seasonComplete?: boolean;
  objective?: ObjectiveT | null; promote?: number;
  confidence?: { value: number; status: string } | null; boardMood?: string | null; pressAvailable?: boolean;
  boardMessages?: { kind: 'reaction' | 'expectation'; text: string }[];
  world_turn?: { mode: 'solo' | 'shared'; turn: number; intervalMin?: number; lastAdvanced?: number | null; nextTurnAt?: number | null; canAdvance: boolean; autonomy?: 'assistant' | 'full' };
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
  awards?: { teamId: number; player: string; slot: number; type: 'pots' | 'young_pots'; headline: string; avg: number }[];
}
export interface FreeAgentT { id: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; }
export interface MarketPlayerT { slot: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; contractYears: number; listed: boolean; askPrice: number | null; starter: boolean; onLoan: boolean; loanFrom: string | null; loanUntil: number | null; }
export interface TransferWindowT { open: boolean; window: 'summer' | 'winter' | null; current: number; total: number; label: string; deadline: number | null; closesIn: number; deadlineDay: boolean; }
export interface TransferTargetT { id: number; name: string; club: string; clubTeamId: number; role: string; age: number; overall: number; potential: number | null; value: number; askPrice: number | null; releaseClause: number | null; wage: number; }
export interface MarketT { budget: number; wageBudget: number; wageBill: number; squadMax: number; squadMin: number; window: TransferWindowT; freeAgents: FreeAgentT[]; squad: MarketPlayerT[]; transferTargets: TransferTargetT[]; backing?: string | null; }
export interface ShortlistRowT { id: number; name: string; club: string; role: string; age: number; overall: number; value: number; listed: boolean; releaseClause: number | null; mine: boolean; onLoan: boolean; }
export interface ScoutedPlayerT { id: number; name: string; club: string; clubTeamId: number; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; askPrice: number | null; releaseClause: number | null; buyable: boolean; shortlisted: boolean; attrs: { key: string; lo: number; hi: number }[] | null; }
export interface OfferT { id: number; playerId: number; playerName: string; club: string; fee: number; status: string; counterFee: number | null; }
export interface IncomingOfferT { id: number; club: string; playerSlot: number | null; playerName: string; fee: number; status: string; }
export interface FreeAgentOfferT { id: number; agentId: number; name: string; role: string; wage: number; years: number; demand: number; status: string; }
export interface TransferT { teamId: number; teamName: string; type: 'sign' | 'buy_listed'; player: string; role: string; fee: number; from?: string; }
export interface CupTieT { id: number; round: number; slot: number; home: string | null; away: string | null; homeTeamId: number | null; awayTeamId: number | null; played: boolean; homeScore: number | null; awayScore: number | null; homePens: number | null; awayPens: number | null; winnerTeamId: number | null; }
export interface CupT { rounds: { round: number; name: string; ties: CupTieT[] }[]; totalRounds: number; champion: string | null; myTeamId: number; }

export interface PlayerRatingT { id: number; name: string; team: 'home' | 'away'; role: string; rating: number; goals: number; assists: number; shots: number; tackles: number; }
export interface TimelineEventT { minute: number; team: 'home' | 'away'; name: string; type: 'goal' | 'yellow' | 'red' | 'penalty' | 'woodwork'; clockMs?: number; }
export interface MatchFactsT { homeScore: number; awayScore: number; possessionHome: number; shots: { home: number; away: number }; shotsOnTarget: number; saves: number; corners: number; timeline: TimelineEventT[]; ratings: PlayerRatingT[]; }
export interface ReportT { homeName: string; awayName: string; headline: string; body: string; facts: MatchFactsT; ratings: PlayerRatingT[]; shootout?: { home: number; away: number; winner: 'home' | 'away' } | null; }

// The persisted shout review for a watched match (GET /api/tactics) — empty `shouts` if the match
// was watched without shouting (or never live-watched). side/scores omitted when there's no log.
export interface ShoutReviewT { minute: number; text: string; directives: number; formationChange: boolean; morale: number; }
export interface TacticsReviewT { side?: 'home' | 'away'; scores?: { home: number; away: number }; shouts: ShoutReviewT[]; }

export interface NewsItemT { player: string; type: 'hat_trick' | 'brace' | 'red_card' | 'star' | 'long_injury' | 'pots' | 'young_pots' | 'press'; headline: string; season: number; slot: number; }
export interface InboxItemT { category?: string; icon: string; text: string; hash?: string | null; }
export interface InboxRowT extends InboxItemT { id: number; season: number; round: number; read: boolean; }

export interface LeaderRowT { name: string; club: string; role: string; value: number; isMine: boolean; }
export interface LeadersT { division: string; scorers: LeaderRowT[]; assists: LeaderRowT[]; ratings: LeaderRowT[]; teamOfSeason: LeaderRowT[]; }

export interface ScoutAttrT { key: string; lo: number; hi: number; }
export interface ScoutPlayerT { name: string; role: string; age: number; overall: number; potential: number | null; danger: boolean; attrs: ScoutAttrT[] | null; }
export interface ScoutFormT { round: number; opponent: string; venue: 'H' | 'A'; gf: number; ga: number; result: 'W' | 'D' | 'L'; }
export interface ScoutT {
  opponent: { teamId: number; name: string; manager: string; formation: string; position: number | null;
    played: number; won: number; drawn: number; lost: number; gf: number; ga: number; gd: number; points: number; };
  venue: 'home' | 'away'; round: number; roundsAway: number; approach: string[]; form: ScoutFormT[]; keyPlayers: ScoutPlayerT[]; bench: ScoutPlayerT[];
}

export interface StaffMemberT { id: number; role: 'coach' | 'physio' | 'scout'; name: string; rating: number; cost: number; specialty?: string | null; }
export interface StaffEffectsT { training: number; injuryReduction: number; recoverBonus: number; scoutDepth: number; }
export interface CategoryBoardT { category: string; stars: number; coverage: number; factor: number; assigned: number[]; }
export interface StaffViewT { staff: StaffMemberT[]; pool: StaffMemberT[]; budget: number; max: number; effects: StaffEffectsT; categories: CategoryBoardT[]; suggestion: Record<string, number[]>; assignmentSet: boolean; }

export interface FinanceEntryT { season: number; kind: string; amount: number; note: string; }
export interface FinanceSeasonT { season: number; income: number; expense: number; net: number; }
export interface FinancesT {
  balance: number; season: number; income: number; expense: number;
  wageBill: number; wageBudget: number;
  byKind: { kind: string; amount: number }[]; recent: FinanceEntryT[]; history: FinanceSeasonT[];
}

export interface TrainAttrDeltaT { key: string; before: number; after: number; delta: number; }
export interface TrainLineT {
  slot: number; name: string; role: string; age: number; focus: string; individual: boolean;
  ovrBefore: number; ovrAfter: number; ovrDelta: number;
  attrs: TrainAttrDeltaT[]; factors: string[];
}
export interface CategoryFactorT { category: string; stars: number; coverage: number; factor: number; assigned: number[]; }
export interface TrainingReportT { season: number; round: number; teamFocus: string; coachBoost: number; harmonyFactor: number; lines: TrainLineT[]; categoryFactors?: CategoryFactorT[]; }

export interface ContractOfferT { id: number; playerSlot: number | null; playerName: string; wage: number; years: number; status: string; counterWage: number | null; counterYears: number | null; }
export interface AcademyProspectT { id: number; name: string; role: string; age: number; overall: number; potential: number | null; attrs: Record<string, number>; }
export interface TalkToneT { key: string; label: string; blurb: string; }
export interface TalkReactionT { slot: number; name: string; role: string; delta: number; reaction: string; }
export interface ContractOfferEventT { player: string; result: 'accepted' | 'countered' | 'rejected' | 'expired'; wage: number; years: number; counterWage?: number; counterYears?: number; }

export interface RotationPlayerT { slot: number; name: string; role: string; fitness: number; injured: boolean; injuredMatches: number; risk: number; band: 'injured' | 'fresh' | 'ok' | 'tired' | 'exhausted'; starter: boolean; }
export interface RotationSuggestionT { outSlot: number; outName: string; outFitness: number; inSlot: number; inName: string; inFitness: number; role: string; reason: string; urgent: boolean; }
export interface RotationT { players: RotationPlayerT[]; suggestions: RotationSuggestionT[]; atRisk: number; expectedInjuries: number; physioMitigation: number; }

export interface HarmonyPlayerT { slot: number; name: string; tag: 'leader' | 'pro' | 'disruptive' | 'unsettled'; note: string; }
export interface HarmonyT { harmony: number; status: 'united' | 'settled' | 'restless' | 'fractured'; avgMorale: number; players: HarmonyPlayerT[]; }
export interface ConcernT { slot: number; name: string; morale: number; kind: 'unsettled' | 'benched_star' | 'wantaway'; reason: string; contractYears: number; canReassure: boolean; }
export interface BoardMeetingT { available: boolean; confidence: { value: number; status: string } | null; grants: { funds: number; wages: number }; }
export interface ManagerSpellT { team: string; seasons: number; from: number; to: number; titles: number; promotions: number; relegations: number; }
export interface ManagerCareerT {
  clubs: number; seasons: number; played: number; won: number; drawn: number; lost: number; gf: number; ga: number; points: number;
  winPct: number; titles: number; promotions: number; relegations: number; cups: number; objectivesMet: number; objectivesSet: number;
  bestFinish: { position: number; division: string; season: number } | null; spells: ManagerSpellT[];
  reputation?: { tier: string; label: string; score: number; blurb: string };
}

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
  teamPlan: (text: string) => req<{ planText: string; plan: PlanT; setPieceTakers: TeamT['setPieceTakers']; note: string; error: string | null }>('POST', '/team/plan', { text }),
  quickTactics: (preset: string) => req<{ planText: string; plan: PlanT }>('POST', '/team/quick-tactics', { preset }),
  setLineup: (text: string) => req<LineupResultT>('PUT', '/lineup', { text }),
  autoLineup: () => req<{ formation: string; lineup: number[] | null; note: string }>('POST', '/lineup/auto'),
  formations: () => req<FormationsT>('GET', '/formations'),
  generatePersonalities: () => req<TeamT>('POST', '/personalities', {}),   // send a body so Fastify can't 415 on a bodyless POST
  league: () => req<LeagueT>('GET', '/league'),
  playFixture: (id: number) => req<{ result: { homeScore: number; awayScore: number; alreadyPlayed: boolean }; standings: StandingT[] }>('POST', `/fixtures/${id}/play`),
  playNext: () => req<{ fixtureId: number; result: { homeScore: number; awayScore: number }; standings: StandingT[] }>('POST', '/play-next'),
  advance: () => req<{ round: number; myFixtureId: number; myResult: { homeScore: number; awayScore: number } | null; transfers: TransferT[]; development?: { players: number }; injuries?: { teamId: number; player: string; matches: number }[]; cup?: { round: number; champion: number | null; myTie: { homeScore: number; awayScore: number; homePens: number | null; awayPens: number | null; opponent: string; won: boolean } | null } | null; rollover?: RolloverT | null; contractOffers?: ContractOfferEventT[]; listingsExpired?: { teamId: number; teamName: string; player: string; role: string }[]; incomingBids?: { player: string; fee: number; from: string }[]; faOffers?: { player: string; role: string; wage: number; years: number; type: 'fa_signed' | 'fa_rejected' | 'fa_expired' | 'fa_gone' }[]; income?: number; inbox: InboxItemT[]; digestHeadline: string; standings: StandingT[] }>('POST', '/advance'),
  cup: () => req<CupT>('GET', '/cup'),
  market: () => req<MarketT>('GET', '/market'),
  buyAgent: (agentId: number) => req<{ ok: boolean; placed: 'xi' | 'bench'; value: number; name: string; market: MarketT }>('POST', '/market/buy', { agentId }),
  offerFreeAgent: (agentId: number, wage: number, years: number) => req<{ ok: boolean; player?: string; market: MarketT; faOffers: FreeAgentOfferT[] }>('POST', '/freeagent/offer', { agentId, wage, years }),
  freeAgentOffers: () => req<{ offers: FreeAgentOfferT[] }>('GET', '/freeagent/offers'),
  listPlayer: (slot: number, price?: number) => req<{ ok: boolean; askPrice: number; value: number; market: MarketT }>('POST', '/market/list', { slot, price }),
  unlistPlayer: (slot: number) => req<{ ok: boolean; market: MarketT }>('POST', '/market/unlist', { slot }),
  bid: (playerId: number, fee: number) => req<{ ok: boolean; status: 'pending' | 'accepted' | 'countered' | 'rejected'; counterFee?: number; player?: string; club?: string; fee?: number; placed?: 'xi' | 'bench'; error?: string; market: MarketT }>('POST', '/transfer/bid', { playerId, fee }),
  loan: (playerId: number) => req<{ ok: boolean; player?: string; from?: string; market: MarketT }>('POST', '/transfer/loan', { playerId }),
  loanOut: (slot: number, clubId?: number) => req<{ ok: boolean; player?: string; from?: string; market: MarketT }>('POST', '/transfer/loan-out', { slot, clubId }),
  shortlist: () => req<{ shortlist: ShortlistRowT[]; ids: number[] }>('GET', '/shortlist'),
  toggleShortlist: (playerId: number, add: boolean) => req<{ ok: boolean; shortlisted: boolean; shortlist: ShortlistRowT[]; ids: number[] }>('POST', '/shortlist', { playerId, add }),
  searchPlayers: (f: { role?: string; maxAge?: number; minOverall?: number; maxValue?: number; name?: string; shortlisted?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (f.role) qs.set('role', f.role);
    if (f.maxAge != null) qs.set('maxAge', String(f.maxAge));
    if (f.minOverall != null) qs.set('minOverall', String(f.minOverall));
    if (f.maxValue != null) qs.set('maxValue', String(f.maxValue));
    if (f.name) qs.set('name', f.name);
    if (f.shortlisted) qs.set('shortlisted', '1');
    const s = qs.toString();
    return req<{ depth: number; players: ScoutedPlayerT[] }>('GET', `/search${s ? `?${s}` : ''}`);
  },
  endLoan: (slot: number) => req<{ ok: boolean; player?: string; from?: string; market: MarketT }>('POST', '/transfer/loan/end', { slot }),
  offers: () => req<{ offers: OfferT[] }>('GET', '/offers'),
  withdrawOffer: (id: number) => req<{ ok: boolean; offers: OfferT[] }>('POST', `/offer/${id}/withdraw`),
  matchOffer: (id: number) => req<{ ok: boolean; status: string; player?: string; fee?: number; market: MarketT; offers: OfferT[] }>('POST', `/offer/${id}/match`),
  incomingOffers: () => req<{ incoming: IncomingOfferT[] }>('GET', '/incoming-offers'),
  acceptOffer: (id: number) => req<{ ok: boolean; club?: string; player?: string; fee?: number; market: MarketT; incoming: IncomingOfferT[] }>('POST', `/offer/${id}/accept`),
  rejectOffer: (id: number) => req<{ ok: boolean; incoming: IncomingOfferT[] }>('POST', `/offer/${id}/reject`),
  setTraining: (focus: string) => req<{ ok: boolean; focus: string }>('PUT', '/training', { focus }),
  setCaptain: (slot: number) => req<{ ok: boolean; captainSlot: number | null }>('PUT', '/captain', { slot }),
  setSetPieceTakers: (takers: { fk: number | null; corner: number | null; pen: number | null; longThrow: number | null }) => req<{ ok: boolean; setPieceTakers: TeamT['setPieceTakers'] }>('POST', '/set-piece-takers', takers),
  teamTalk: (fixtureId: number, tone?: string) => req<{ tones: TalkToneT[]; pending: { tone: string; reactions: TalkReactionT[] } | null; tone: string; reactions: TalkReactionT[] }>('GET', `/teamtalk?fixture=${fixtureId}${tone ? `&tone=${encodeURIComponent(tone)}` : ''}`),
  setTeamTalk: (fixtureId: number, tone: string) => req<{ ok: boolean; tone: string; reactions: TalkReactionT[] }>('POST', '/teamtalk', { fixtureId, tone }),
  academy: () => req<{ prospects: AcademyProspectT[] }>('GET', '/academy'),
  promoteProspect: (id: number) => req<{ ok: boolean; player?: string; prospects: AcademyProspectT[] }>('POST', `/academy/${id}/promote`),
  setPlayerTraining: (slot: number, focus: string) => req<{ ok: boolean; focus: string | null }>('PUT', '/training/player', { slot, focus }),
  trainingReport: () => req<{ report: TrainingReportT | null }>('GET', '/training-report'),
  setPlayerStory: (slot: number, backstory: string, tagline: string) =>
    req<{ slot: number; personality: PersonalityT; value: number }>('PUT', `/player/${slot}/story`, { backstory, tagline }),
  pressQuestion: () => req<{ available: boolean; question?: string; options?: { tone: string; label: string; text: string }[] }>('GET', '/press'),
  press: (text: string, tone?: string) => req<{ reactions: { slot: number; name: string; delta: number; quote?: string }[]; lifted: number; unsettled: number; boardDelta?: number; confidence?: { value: number; status: string } | null; team: TeamT }>('POST', '/press', { text, tone }),
  interactPlayer: (slot: number, tone: string) => req<{ ok: boolean; delta: number; morale: number; reaction: string; name: string }>('POST', `/player/${slot}/interact`, { tone }),
  playerCareer: (slot: number) => req<{ career: PlayerSeasonStatT[] }>('GET', `/player/${slot}/career`),
  playerProgression: (slot: number) => req<{ progression: AttrSnapshotT[] }>('GET', `/player/${slot}/progression`),
  concerns: () => req<{ concerns: ConcernT[] }>('GET', '/concerns'),
  resolveConcern: (slot: number, action: 'reassure' | 'accept' | 'reject') =>
    req<{ ok: boolean; action: string; moraleDelta?: number; morale?: number; listed?: boolean; askPrice?: number; message: string; concerns: ConcernT[]; team: TeamT }>('POST', `/concerns/${slot}`, { action }),
  board: () => req<BoardMeetingT>('GET', '/board'),
  career: () => req<ManagerCareerT>('GET', '/career'),
  boardRequest: (kind: 'funds' | 'wages') =>
    req<{ granted: boolean; kind?: string; amount?: number; budget?: number; wageBudget?: number; message: string; meeting: BoardMeetingT; team: TeamT }>('POST', '/board/request', { kind }),
  renewPreview: (slot: number) =>
    req<{ currentWage: number; newWage: number; delta: number; years: number; affordable: boolean }>('GET', `/player/${slot}/renew-preview`),
  // §2.2 contract negotiation: propose a renewal (resolved at the next matchday), then match/withdraw.
  renewOffer: (slot: number, wage: number, years: number) =>
    req<{ ok: boolean; offers: ContractOfferT[] }>('POST', `/player/${slot}/renew-offer`, { wage, years }),
  contractOffers: () => req<{ offers: ContractOfferT[] }>('GET', '/contract-offers'),
  matchContractOffer: (id: number) => req<{ ok: boolean; player?: string; wage?: number; years?: number; offers: ContractOfferT[] }>('POST', `/contract-offer/${id}/match`),
  withdrawContractOffer: (id: number) => req<{ ok: boolean; offers: ContractOfferT[] }>('POST', `/contract-offer/${id}/withdraw`),
  report: (id: number, cup = false) => req<ReportT>('GET', `/report?${cup ? 'cup' : 'fixture'}=${id}`),
  tactics: (fixtureId: number) => req<TacticsReviewT>('GET', `/tactics?fixture=${fixtureId}`),
  scout: (fixtureId: number) => req<ScoutT>('GET', `/scout?fixture=${fixtureId}`),
  news: (limit?: number) => req<{ news: NewsItemT[] }>('GET', limit ? `/news?limit=${limit}` : '/news'),
  inbox: (limit?: number) => req<{ inbox: InboxRowT[]; unread: number }>('GET', limit ? `/inbox?limit=${limit}` : '/inbox'),
  markInboxRead: (opts: { id?: number; all?: boolean }) => req<{ ok: boolean; unread: number }>('POST', '/inbox/read', opts),
  leaders: () => req<LeadersT>('GET', '/leaders'),
  history: () => req<{ history: SeasonHistoryT[]; records: ClubRecordsT }>('GET', '/history'),
  staff: () => req<StaffViewT>('GET', '/staff'),
  hireStaff: (staffId: number) => req<StaffViewT & { name?: string }>('POST', '/staff/hire', { staffId }),
  fireStaff: (staffId: number) => req<StaffViewT>('POST', '/staff/fire', { staffId }),
  saveCoachAssignment: (assignment: Record<string, number[]> | null) => req<StaffViewT>('PUT', '/staff/assignment', { assignment }),
  setPlayerIntensity: (slot: number, value: string) => req<{ ok: boolean; intensity: string | null }>('PUT', '/training/player-intensity', { slot, value }),
  setTeamIntensity: (value: string) => req<{ ok: boolean; intensity: string }>('PUT', '/training/team-intensity', { value }),
  applyTrainingPreset: (name: string) => req<{ ok: boolean; preset?: { focus: string; intensity: string; label: string } }>('PUT', '/training/preset', { name }),
  setPlayerRetrain: (slot: number, role: string) => req<{ ok: boolean; retrainRole: string | null }>('PUT', '/training/retrain', { slot, role }),
  finances: () => req<FinancesT>('GET', '/finances'),
  harmony: () => req<HarmonyT>('GET', '/harmony'),
  rotation: () => req<RotationT>('GET', '/rotation'),
  applyRotation: (outSlot: number, inSlot: number) => req<{ ok: boolean; lineup: number[] | null; rotation: RotationT }>('POST', '/rotation/apply', { outSlot, inSlot }),
  // §autonomous: the world lobby — browse shared worlds, claim an unclaimed team, leave, set autonomy.
  worlds: () => req<{ worlds: JoinableWorldT[]; hasTeam: boolean }>('GET', '/worlds'),
  worldTeams: (id: number) => req<{ teams: ClaimableTeamT[] }>('GET', `/worlds/${id}/teams`),
  claimTeam: (worldId: number, teamId: number) => req<{ ok: boolean; teamId: number }>('POST', `/worlds/${worldId}/claim`, { teamId }),
  leaveWorld: () => req<{ ok: boolean }>('POST', '/worlds/leave'),
  setAutonomy: (mode: 'assistant' | 'full') => req<{ ok: boolean; autonomy: string }>('POST', '/autonomy', { mode }),
  nations: () => req<{ nations: NationT[]; confeds: Record<string, string> }>('GET', '/nations'),
  tournaments: () => req<{ tournaments: TournamentT[]; fieldable: FieldableNationT[] }>('GET', '/tournaments'),
  nationSquad: (key: string) => req<{ squad: { name: string; role: string; overall: number }[] }>('GET', `/nation/${key}/squad`),
};
export interface TournamentTieT { round: number; slot: number; home: string | null; away: string | null; homeScore: number | null; awayScore: number | null; homePens: number | null; awayPens: number | null; winner: string | null }
export interface TournamentT { id: number; season: number; kind: string; confed: string | null; name: string; champion: string | null; ties: TournamentTieT[] }
export interface FieldableNationT { key: string; confed: string; count: number; strength: number }
export interface JoinableWorldT { worldId: number; name: string; season: number; turn: number; intervalMin: number; unclaimed: number; total: number }
export interface ClaimableTeamT { teamId: number; name: string; tier: number; division: string; overall: number; claimed: boolean; manager: string }
