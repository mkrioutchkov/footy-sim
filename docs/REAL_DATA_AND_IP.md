# Real teams & players — can footy-sim use them? (IP brief)

> **Audience: a coding agent / the dev deciding whether to put real clubs, players,
> crests, or attributes into footy-sim.** Companion to
> [`STATSBOMB_DATA.md`](STATSBOMB_DATA.md) (which covers the *data-source* licence
> question). This file covers the *broader* trademark / likeness / facts question.
>
> **Not legal advice.** Product/strategy guidance grounded in the case law. Get a
> qualified IP lawyer (AU + UK/EU/US) before selling anything with a real-player
> element. The dev is **based in Australia**; the game is intended for **global**
> release — both matter (see Jurisdiction).

---

## Bottom line

**Not a flat "no" — but "no" to shipping real teams/players in the sold binary.**
"Real teams and players" is really *four separate legal questions* under *four
regimes*, and footy-sim's current architecture (procedural `genAttrs` + the
`spec.json`/`loadTeam` data seam) already sits on the safe side of all of them.
The industry-standard answer (Football Manager, PES/eFootball) is: **ship fictional
content; expose a data seam; let *users* add real data locally.** Do that and the
dev distributes nothing infringing.

## The four layers

| Layer | Status | Why |
|---|---|---|
| Club **crests/badges, kits, competition logos** (Premier League, UCL, FIFA marks) | 🔴 **Hard block — never ship** | Registered trademarks **+** artwork copyright (AU Trade Marks Act 1995 / Copyright Act 1968; equivalents everywhere). No "it's a fact" escape. FM omits these even when it keeps names. |
| Real player **faces / photos / 3D scans** | 🔴 **Hard block** | Direct likeness — what FIFPro licences exist to clear. (N/A today; footy-sim has no faces.) |
| A **recognizable player** — real club + shirt number + position + accurate attributes, **even un-named** | 🔴 **High-risk** | This is footy-sim's *exact data model*. US courts: an *unnamed* avatar matching a real player's number/position/biometrics is an actionable likeness — *Keller v EA* (9th Cir 2013), *Hart v EA* (3d Cir 2013). NL extended it to a *stylised, non-photographic* character (*Edgar Davids*). Maradona's estate forced a Konami settlement despite the fake-name trick. **Stripping the name does not make a famous player safe.** |
| Real club / player **names as data strings** | 🟠 **Grey** | Names are uncopyrightable facts (*Feist*; AU *IceTV v Nine*). Low risk in AU/UK (no image right) and US (*CBC v MLB Advanced Media* shields name+public-stats DBs). But Germany protects the bare name (§12 BGB), EU personality rights bite for stars, and a litigious club can sue (*Man Utd v SEGA/SI* settled → FM renamed "Man UFC"). |
| The **data source** (StatsBomb, Transfermarkt, FBref, FotMob, paid APIs) | 🔴 **Hard block** | Contract/ToS + (in EU) database right. StatsBomb already barred — see [`STATSBOMB_DATA.md`](STATSBOMB_DATA.md). |
| **Your own** attribute numbers (pace 84, finishing 12) | 🟢 **Clean as IP** | Numbers you generate are your opinion, not anyone's data — exactly what `genAttrs` does. You may **not** lift EA/FM/StatsBomb rating tables (protected compilation + ToS). The *numbers* are clean; binding them to a real identity re-imports the likeness risk. |

**The reconciling principle:** a data licence only governs whether you may *copy the
file*. It never grants trademark or personality rights in the clubs/players the data
describes. So even a CC0 source (OpenFootball/Wikidata) clears only the *copy*
question — you'd still hit the crest/kit (trademark) and player-identity (publicity)
walls. The StatsBomb and IP analyses are **additive, not overlapping**.

## Recommended path: fictional in-box + community editor

This is ~90% of the current architecture already.

1. **Keep `genAttrs` (web/backend/game.ts) generating fictional players with their
   own numbers** as the only shipped dataset. Never seed a real squad into
   `spec.json`, the SQLite seed, or `formations.ts`.
2. **Never ship crests, kits, or competition logos** — generic/procedural
   placeholders only, and *not* recolour-clones of real badges or registered strips
   (Newcastle's stripes are a mark). Absolute no-ship line in every build.
3. **Invented or location-derived club/competition names** by default (the PES
   "Man Red"/"London FC" posture). Keep a rename-substitution layer so any club can
   be swapped out fast if it objects.
4. **Expose `loadTeam`/`spec.json` as a documented user import/editor + data-pack
   format** so the *community* maps real names/attrs onto fictional slots locally.
   **Do not author, bundle, host, auto-download, or link-promote a real-name pack
   yourself** — that flips you from facilitator to contributory infringer
   (*MGM v Grokster*).
5. **Non-affiliation disclaimer**, and never use a real club/player name or face in
   store pages / trailers in a way implying endorsement (this is the AU + UK
   false-endorsement trigger — see below).
6. **Sourcing for real *facts*** (dev only, or for a user-installed pack): CC0
   **OpenFootball** / **Wikidata structured data**. Never Wikipedia *prose*
   (CC-BY-SA would copyleft your code); never scraped Transfermarkt/FBref; never
   StatsBomb-derived ratings.

**Not recommended:** baking real names into a *sold* binary (an un-cleared grey-zone
bet, and least safe in DE/FR/NL); or full **FIFPro + league + club licensing** (the
EA/FM route — realistically seven-figure, infeasible for an indie; revisit only as a
funded studio, FIFPro first).

## Jurisdiction — Australia base, global release

A worldwide commercial release is governed by the **strictest applicable market**,
so **design to the toughest standard** regardless of where the dev sits. Being
based in Australia mainly affects *home-court* exposure — it does **not** shield a
globally distributed product from US or EU claims (those courts reach foreign sellers
who target their market via Steam/app stores).

- **Australia (home):** *No* statutory image / personality / publicity right (like
  the UK). A real player is reachable only via **passing off** + **Australian
  Consumer Law s18** (misleading/deceptive conduct) / **false endorsement** — which
  require a **misrepresentation that the player endorses or is associated with the
  game** (*Pacific Dunlop v Hogan* 1989; *Henderson v Radio Corp*; *Talmax v
  Telstra*). A neutral, plainly-unofficial sim has **low** player exposure at home;
  **marketing that implies endorsement is the real trigger.** On *data*, Australia
  is **more permissive than the EU**: copyright protects expression not facts, and
  *IceTV v Nine* (2009 HCA) + *Telstra v Phone Directories* (2010) **rejected "sweat
  of the brow"**, so factual compilations (names, fixtures, schedules) get little
  protection — and Australia has **no EU-style sui generis database right** at all.
  Crests/kits/logos remain hard trademark+copyright blocks (Trade Marks Act 1995,
  Copyright Act 1968).
- **United States:** *Hardest on player identity* — state right of publicity
  (Cal. Civ. §3344 + common law, ~half the states, often post-mortem), and a
  realistic sim is the *least* protected (*Keller*, *Hart*; stripping the name
  doesn't help). *Softest on club names* — the First Amendment / *Rogers v Grimaldi*
  protects real brand/team names used for realism (*AM General/Humvee*, *E.S.S./GTA*),
  and *CBC* protects name+public-stats databases.
- **UK:** No image right (*Rihanna v Topshop*; *Proactive v Rooney*); player reachable
  only via passing-off needing **endorsement misrepresentation** (*Irvine v
  TalkSport*) — like Australia. Crests/kits/competition logos hard-blocked; club
  *names* contested-but-defensible (*Man Utd v SEGA* settled).
- **EU / Continental:** *Highest-risk* for real players — strong statutory
  personality rights (Germany §12 BGB name + §22 KUG portrait; France Art 9 Code
  civil; NL *portretrecht*), no First-Amendment/`Rogers` shield, plus the **sui
  generis database right** (Dir. 96/9/EC) blocking bulk data extraction. A player in
  DE/FR/NL can forum-shop for the strongest protection.

**Net:** "name only, no face, no endorsement framing" is safest in **AU/UK**,
defensible in the **US** for non-famous players, and **least safe in DE/FR/NL**.
Ship fictional defaults so the product is clean everywhere; geofence/lawyer-check
DE/FR/NL specifically before any real-player commercial feature.

## Open data sources (copy-clear ≠ shippable)

| Source | Licence | Gives | Shippable in a sold game? |
|---|---|---|---|
| **OpenFootball** | CC0 | Real club/league/cup names, structures, fixtures, squads (name+position+nationality) — no ratings | Copy-clear; **not** clear to bake real names into a sold binary (CC0 ≠ trademark/publicity). Good for dev or user packs. |
| **Wikidata** (structured data) | CC0 | Player facts: DOB, height, position, nationality, club | Facts ship freely; real **names** still hit trademark/publicity. Never Wikipedia *prose* (CC-BY-SA). |
| **football-data.org** | Proprietary ToS, attribution | Competitions, fixtures, standings, squads | Live companion feed with credit only; not a shippable static asset. |
| **TheSportsDB / API-Football** | Proprietary ToS | Metadata, some artwork/stats | Free tiers often forbid app-store publishing; **logos are third-party marks** — never ship crests from here. |
| **Transfermarkt / FBref / FotMob** | ToS + EU DB right + upstream (Opta) | Richest data incl. xG | **Not** shippable or lawfully scrapable. Private dev intuition at most. |
| **StatsBomb open data** | Its own licence | Event-level data | **Not** shippable; see [`STATSBOMB_DATA.md`](STATSBOMB_DATA.md). |

## Sources

US: *Keller v EA* 724 F.3d 1268 (9th Cir 2013); *Hart v EA* 717 F.3d 141 (3d Cir
2013); *CBC v MLB Advanced Media* 505 F.3d 818 (8th Cir 2007); *Rogers v Grimaldi*;
*Feist v Rural*; Cal. Civ. Code §3344. UK/EU: *Irvine v TalkSport*; *Fenty (Rihanna)
v Topshop* [2015] EWCA; *Proactive v Rooney* [2011]; *Football Dataco v Yahoo*
(CJEU C-604/10); *British Horseracing Board v William Hill* (C-203/02); DB Directive
96/9/EC; §12 BGB, §22 KUG, Art 9 Code civil, NL *portretrecht* / *Edgar Davids*.
Industry: FIFPro collective licensing; *Man Utd v SEGA/SI* (settled); Maradona estate
v Konami (settled); FM "Real Names Fix" + PES option-file norm. Australia:
[Personality rights — passing off + ACL s18](https://anisimoff.com.au/the-sincerest-form-of-flattery-or-a-grande-mistake-a-look-at-the-law-surrounding-the-use-of-look-alikes/);
*Pacific Dunlop v Hogan* [1989] FCA 185; *Henderson v Radio Corp*; *Talmax v
Telstra*; [*IceTV v Nine* (2009) HCA 14](https://eresources.hcourt.gov.au/showCase/2009/HCA/14)
+ *Telstra v Phone Directories* (no "sweat of the brow"); Copyright Act 1968,
Trade Marks Act 1995.

*Added 2026-06-16. Not legal advice — verify with an IP lawyer before any commercial
real-player feature.*
