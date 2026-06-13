// Fake name pools — no real players/clubs (copyright). Generic football flavour.

const FIRST = [
  'Marco', 'Luca', 'Diego', 'Bruno', 'Andre', 'Felix', 'Mateo', 'Kai', 'Leon', 'Noah',
  'Tomas', 'Ivan', 'Sami', 'Omar', 'Yuki', 'Hugo', 'Milan', 'Pavel', 'Dario', 'Enzo',
  'Rafa', 'Nico', 'Theo', 'Aron', 'Jude', 'Cole', 'Reece', 'Finn', 'Otto', 'Emre',
  'Sven', 'Lars', 'Joel', 'Remy', 'Idris', 'Kwame', 'Tariq', 'Sergio', 'Vito', 'Anton',
];

const LAST = [
  'Voss', 'Marin', 'Costa', 'Berg', 'Falk', 'Reyes', 'Moretti', 'Novak', 'Sørensen', 'Haas',
  'Bauer', 'Conti', 'Ferro', 'Bruna', 'Dahl', 'Vidal', 'Lange', 'Roca', 'Stein', 'Cruz',
  'Aziz', 'Okafor', 'Mensah', 'Tanaka', 'Kovac', 'Petrov', 'Lindqvist', 'Modric', 'Bianchi', 'Pena',
  'Wolff', 'Keane', 'Doyle', 'Frost', 'Webb', 'Hale', 'Nash', 'Salah', 'Cole', 'Dembe',
];

const CLUB_PRE = [
  'Athletic', 'Real', 'Inter', 'Sporting', 'Dynamo', 'Olympic', 'United', 'City', 'Royal', 'FC',
  'Atletico', 'Borough', 'North', 'East', 'Port', 'Lake', 'River', 'Iron', 'Crown', 'Phoenix',
];
const CLUB_NOUN = [
  'Rovers', 'Wanderers', 'Albion', 'Rangers', 'Town', 'County', 'Hotspur', 'Forest', 'Athletic',
  'Harbour', 'Vale', 'Heath', 'Park', 'Bridge', 'Castle', 'Falcons', 'Wolves', 'Lions', 'Eagles', 'Dragons',
];

function pick<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

export function randomPlayerName(): string {
  return `${pick(FIRST)} ${pick(LAST)}`;
}

export function randomTeamName(): string {
  // Either "<Pre> <Noun>" or "<Noun> <Pre>" for variety.
  return Math.random() < 0.5
    ? `${pick(CLUB_PRE)} ${pick(CLUB_NOUN)}`
    : `${pick(CLUB_NOUN)} ${pick(CLUB_PRE)}`;
}
