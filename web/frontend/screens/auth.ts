// ── auth screen ── extracted from app.ts (Round: appts-audit, pass 3): the sign-in / register card. It
// holds no state outside its own form; a successful sign-in calls shell.rerender(), which boot wires to
// route() — the same indirection every other screen module uses instead of importing the router.

import { api } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, setUser, rerender } from '../ui/shell.ts';

// ── auth ──
export function screenAuth() {
  document.title = 'Sign in · Footy Manager';
  let tab: 'login' | 'register' = 'login';
  let submitting = false;
  const err = h('div', { id: 'auth-error', class: 'err', role: 'status', 'aria-live': 'polite' });
  const uname = h('input', { id: 'f-uname', placeholder: 'username', autocomplete: 'username', required: true, minlength: '2', maxlength: '32', 'aria-describedby': 'auth-error' }) as HTMLInputElement;
  const pass = h('input', { id: 'f-pass', type: 'password', placeholder: 'password', autocomplete: 'current-password', required: true, minlength: '4', 'aria-describedby': 'auth-error' }) as HTMLInputElement;
  const submit = h('button', { type: 'submit' }, 'Sign in');

  async function go() {
    if (submitting) return;
    submitting = true;
    err.textContent = '';
    submit.setAttribute('disabled', 'true');
    try {
      const fn = tab === 'login' ? api.login : api.register;
      const r = await fn(uname.value.trim(), pass.value);
      setUser(r.user);
      rerender();
    } catch (e: any) { err.textContent = e.message; submitting = false; submit.removeAttribute('disabled'); }
  }
  const form = h('form', { id: 'auth-form', role: 'tabpanel', 'aria-labelledby': 'auth-tab-login', onsubmit: (e: SubmitEvent) => { e.preventDefault(); void go(); } },
    h('div', { class: 'field' }, h('label', { for: 'f-uname' }, 'Username'), uname),
    h('div', { class: 'field' }, h('label', { for: 'f-pass' }, 'Password'), pass),
    submit, err);

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account access' });
  const tLogin = h('button', { id: 'auth-tab-login', type: 'button', class: 'active', role: 'tab', tabindex: '0', 'aria-selected': 'true', 'aria-controls': 'auth-form' }, 'Log in');
  const tReg = h('button', { id: 'auth-tab-register', type: 'button', role: 'tab', tabindex: '-1', 'aria-selected': 'false', 'aria-controls': 'auth-form' }, 'Register');
  const setTab = (t: 'login' | 'register') => {
    tab = t; err.textContent = '';
    tLogin.classList.toggle('active', t === 'login');
    tReg.classList.toggle('active', t === 'register');
    tLogin.setAttribute('aria-selected', String(t === 'login'));
    tReg.setAttribute('aria-selected', String(t === 'register'));
    tLogin.tabIndex = t === 'login' ? 0 : -1;
    tReg.tabIndex = t === 'register' ? 0 : -1;
    form.setAttribute('aria-labelledby', t === 'login' ? 'auth-tab-login' : 'auth-tab-register');
    pass.autocomplete = t === 'login' ? 'current-password' : 'new-password';
    submit.textContent = t === 'login' ? 'Sign in' : 'Create account';
    document.title = `${t === 'login' ? 'Sign in' : 'Create account'} · Footy Manager`;
  };
  tLogin.addEventListener('click', () => setTab('login'));
  tReg.addEventListener('click', () => setTab('register'));
  const tabKey = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const current = document.activeElement === tReg ? 'register' : 'login';
    const next = e.key === 'Home' ? 'login' : e.key === 'End' ? 'register' : current === 'login' ? 'register' : 'login';
    setTab(next); (next === 'login' ? tLogin : tReg).focus();
  };
  tLogin.addEventListener('keydown', tabKey);
  tReg.addEventListener('keydown', tabKey);
  tabs.append(tLogin, tReg);

  mount(h('div', { class: 'center' },
    h('div', { class: 'card auth-card' },
      h('div', { class: 'brand', style: 'font-size:24px;margin-bottom:6px' }, 'FOOTY ', h('span', { class: 'a' }, 'MANAGER')),
      h('div', { class: 'muted', style: 'margin-bottom:18px' }, 'Build a team. Set your tactics. Play the season.'),
      tabs,
      form,
    ),
  ));
}
