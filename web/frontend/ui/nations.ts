// §national-teams: a tiny nation-key → flag-emoji cache, loaded once at boot so bios/squads render flags
// synchronously. flagOf('') / unknown → '' (no flag), so it's safe before the fetch resolves.
// Extracted from app.ts (Round: appts-audit) — the profile, squad and internationals screens all read it.
import { api } from '../api.ts';

let nationMap: Map<string, { flag: string; name: string }> | null = null;
export function nationsLoaded(): boolean { return nationMap != null; }
export function flagOf(key?: string | null): string { return (key && nationMap?.get(key)?.flag) || ''; }
export function nationNameOf(key?: string | null): string { return (key && nationMap?.get(key)?.name) || ''; }
export async function loadNations() { try { const r = await api.nations(); nationMap = new Map(r.nations.map(n => [n.key, { flag: n.flag, name: n.name }])); } catch { nationMap = new Map(); } }
