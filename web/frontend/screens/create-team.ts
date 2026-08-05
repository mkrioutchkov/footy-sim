// ── create team ── extracted from app.ts (Round: appts-audit). Every screen falls back to this when the
// manager has no club yet, so it lives in its own module rather than in the router.
import { api } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, rerender, setOnboarding, toast, getUser } from '../ui/shell.ts';
import { header, syncNav } from '../ui/nav.ts';

// ── create team ──
export function screenCreateTeam() {
  setOnboarding(true); syncNav();   // no club yet → hide the team-gated bottom bar (this screen bypasses route())
  const name = h('input', { id: 'f-clubname', placeholder: 'e.g. Brisbane Roar', value: `${getUser()!.username} FC` }) as HTMLInputElement;
  const planInput = h('textarea', { class: 'tactics-input', rows: '3',
    placeholder: 'Optional — your tactical plan in plain English: "high press, build from the back, full-backs bomb on, sit deeper if 2-0 up". You can set or change it any time from Tactics.' }) as HTMLTextAreaElement;
  const err = h('div', { class: 'err', role: 'alert' });
  const create = h('button', { type: 'submit' }, 'Create team & start season') as HTMLButtonElement;
  const submit = async () => {
    if (create.disabled) return;
    err.textContent = '';
    create.disabled = true; create.textContent = 'Creating your club…';
    try {
      await api.createTeam(name.value.trim());
      const plan = planInput.value.trim();
      // P3: don't block entry on the LLM plan compile (~40s on a cold model — it used to freeze the
      // create screen with no feedback, and a timeout left you on a broken screen). Drop into the
      // dashboard immediately and compile the standing plan in the BACKGROUND; a toast reports how it landed.
      if (plan) {
        toast('Compiling your tactical plan in the background…');
        void api.teamPlan(plan)
          .then(r => toast(r.error ? 'Couldn’t read your plan — set it from the Tactics screen.' : '✓ Tactical plan set.'))
          .catch(() => toast('Couldn’t read your plan — set it from the Tactics screen.'));
      }
      rerender();
    } catch (e: any) { err.textContent = e.message; create.disabled = false; create.textContent = 'Create team & start season'; }
  };
  // A real <form> so Enter in the club-name field submits natively (Enter in the plan textarea still adds a
  // newline). Mirrors the auth screen's form.
  const form = h('form', { onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
    h('div', { class: 'field' }, h('label', { for: 'f-clubname' }, 'Club name'), name),
    h('div', { class: 'section-title' }, 'Tactical plan'),
    planInput,
    h('div', { style: 'margin-top:16px' }, create), err);
  mount(header(), h('div', { class: 'wrap' },
    h('div', { class: 'card' },
      h('h2', {}, 'Create your club'),
      h('div', { class: 'muted', style: 'margin-bottom:16px' }, 'We’ll generate your squad — a starting XI plus bench — and drop you into an 8-team league against AI managers.'),
      form,
      h('div', { class: 'muted', style: 'margin-top:14px;font-size:13px;border-top:1px solid var(--line);padding-top:12px' },
        'Prefer to play against other managers? ',
        h('a', { href: '#/worlds', style: 'color:var(--accent);cursor:pointer' }, 'Join a shared world →'),
        ' — claim an unclaimed club in a live world that advances on a schedule.'),
    ),
  ));
}
