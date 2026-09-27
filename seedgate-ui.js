// seedgate-ui.js: optional drop-in "SEAL 8×" button for seedgate.js. No dependencies, no alert/confirm/prompt.
// Theme it by setting CSS variables on any ancestor:
//   --sg-fg --sg-bg --sg-accent --sg-muted --sg-border --sg-ok --sg-error --sg-radius --sg-font --sg-pad --sg-max-width
import { normalizeSeed } from './seedgate.js';

const CSS = `
.sg-wrap{display:flex;flex-direction:column;gap:6px;max-width:var(--sg-max-width,320px);font:var(--sg-font,600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--sg-fg,#ecebe6)}
.sg-btn{appearance:none;cursor:pointer;font:inherit;letter-spacing:.06em;text-transform:uppercase;text-align:center;padding:var(--sg-pad,9px 14px);border-radius:var(--sg-radius,6px);border:1px solid var(--sg-border,currentColor);background:var(--sg-bg,#111114);color:var(--sg-fg,#ecebe6);transition:border-color .15s,color .15s,opacity .15s}
.sg-btn:hover:not(:disabled){border-color:var(--sg-accent,#c8ff4d);color:var(--sg-accent,#c8ff4d)}
.sg-btn:disabled{cursor:default;opacity:.62}
.sg-btn:focus-visible,.sg-link:focus-visible,.sg-input:focus-visible{outline:2px solid var(--sg-accent,#c8ff4d);outline-offset:2px}
.sg-wrap[data-state=idle] .sg-btn{border-color:var(--sg-accent,#c8ff4d)}
.sg-wrap[data-state=sealed] .sg-btn{border-color:var(--sg-ok,#6dffa8);color:var(--sg-ok,#6dffa8);opacity:1}
.sg-wrap[data-state=busy] .sg-btn{animation:sg-pulse 1.2s ease-in-out infinite;opacity:1}
.sg-wrap[data-state=error] .sg-btn,.sg-wrap[data-state=check] .sg-btn{border-color:var(--sg-error,#ff7a7a)}
.sg-small{padding:6px 10px;font-size:.92em}
.sg-note{font-weight:400;color:var(--sg-muted,#a3a09a);min-height:1.35em;overflow-wrap:anywhere}
.sg-note.sg-err{color:var(--sg-error,#ff7a7a)}
.sg-note a{color:inherit;text-underline-offset:2px}
.sg-link{appearance:none;background:none;border:0;padding:0;align-self:flex-start;cursor:pointer;font:inherit;font-weight:400;color:var(--sg-muted,#a3a09a);text-decoration:underline;text-underline-offset:2px}
.sg-link:hover{color:var(--sg-fg,#ecebe6)}
.sg-restore{display:flex;gap:6px}
.sg-restore[hidden]{display:none}
.sg-input{flex:1;min-width:0;font:inherit;font-weight:400;padding:6px 8px;border-radius:var(--sg-radius,6px);border:1px solid var(--sg-border,currentColor);background:var(--sg-input-bg,transparent);color:inherit}
@keyframes sg-pulse{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.sg-wrap[data-state=busy] .sg-btn{animation:none}}
`;

function injectCss() {
  if (document.getElementById('seedgate-ui-css')) return;
  const style = document.createElement('style');
  style.id = 'seedgate-ui-css';
  style.textContent = CSS;
  document.head.prepend(style); // prepend so host styles win
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}
const short = (x) => (x ? `${x.slice(0, 6)}…${x.slice(-4)}` : '?');

/**
 * mountSealButton({ gate, getSeed, onUnlocked, container }) -> { el, refresh, destroy }
 * onUnlocked({ seed, receipt, certificate, fresh }) is called right after a successful seal (fresh: true)
 * and whenever the user clicks the sealed button to export again (fresh: false). It may return a promise.
 * onRestored(receipt) (optional) fires when a pasted receipt belongs to a different seed than the current one.
 */
export function mountSealButton({
  gate, getSeed, onUnlocked, onRestored, container,
  label = 'SEAL 8×', sealedLabel = 'SEALED ✓ · EXPORT 8×', watchMs = 750,
} = {}) {
  if (!gate || typeof getSeed !== 'function') throw new TypeError('mountSealButton needs { gate, getSeed }');
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) throw new Error('mountSealButton: container not found');
  injectCss();

  const wrap = el('div', 'sg-wrap');
  const btn = el('button', 'sg-btn');
  const note = el('div', 'sg-note');
  const toggle = el('button', 'sg-link', 'Have a receipt? Paste tx hash');
  const form = el('form', 'sg-restore');
  const input = el('input', 'sg-input');
  const go = el('button', 'sg-btn sg-small', 'Restore');
  btn.type = toggle.type = 'button';
  go.type = 'submit';
  note.setAttribute('aria-live', 'polite');
  toggle.setAttribute('aria-expanded', 'false');
  Object.assign(input, { placeholder: '0x… transaction hash', spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', 'Transaction hash of your seal');
  form.hidden = true;
  form.append(input, go);
  wrap.append(btn, note, toggle, form);
  host.appendChild(wrap);

  let seed = null, mode = 'idle', gen = 0, busy = false, ownTx = null, pending = null;
  const readSeed = () => { try { return normalizeSeed(getSeed()); } catch { return null; } };
  const buyLabel = () => `${label} · ${gate.priceLabel}`;

  function set(m, text, msg = '', { err = false, link = null, disabled = false } = {}) {
    mode = m;
    wrap.dataset.state = m;
    btn.textContent = text;
    btn.disabled = disabled;
    say(msg, { err, link });
  }
  function say(msg, { err = false, link = null } = {}) {
    note.classList.toggle('sg-err', err);
    note.textContent = msg;
    if (link?.href) {
      const a = el('a', '', link.text);
      Object.assign(a, { href: link.href, target: '_blank', rel: 'noopener noreferrer' });
      note.append(msg ? ' ' : '', a);
    }
  }
  const sealedNote = (r) => [`Sealed by ${short(r.from)} · block ${r.blockNumber}.`, { link: { text: 'view tx', href: gate.txUrl(r.txHash) } }];

  async function refresh() {
    if (busy) return;
    const my = ++gen;
    seed = readSeed();
    if (seed == null) return set('invalid', buyLabel(), 'This seed cannot be sealed.', { disabled: true, err: true });
    const r = gate.receipt(seed);
    if (r) return set('sealed', sealedLabel, ...sealedNote(r));
    if (pending?.seed === seed) {
      ownTx = pending.txHash;
      return set('check', 'Check transaction', 'Your payment was sent but not confirmed yet. Check again before paying twice.', { link: { text: 'view tx', href: gate.txUrl(ownTx) } });
    }
    const wallet = gate.hasWallet();
    if (!wallet) set('nowallet', 'Install a wallet to seal', `Needs a browser wallet on ${gate.chainName} (Rabby, MetaMask, Coinbase Wallet). Already sealed? Paste your tx hash.`, { disabled: true });
    else if (!gate.payeeSet) return set('unset', buyLabel(), 'Sealing is off: the payee address is not configured.', { disabled: true });
    else set('idle', buyLabel(), 'Checking the claim registry…');
    if (!gate.payeeSet) return;

    const status = await gate.claimStatus(seed).catch(() => 'unknown');
    const entry = status.startsWith('claimed') ? (await gate.registry())?.get(seed) : null;
    if (my !== gen || busy) return;
    if (status === 'claimed') {
      return set('claimed', `Claimed · ${short(entry?.from)}`, `Seed ${seed} was sealed first by ${short(entry?.from)}.`, { disabled: true, link: entry && { text: 'view tx', href: gate.txUrl(entry.txHash) } });
    }
    if (status === 'claimed-by-you' && entry) {
      ownTx = entry.txHash;
      return set('restore-own', 'Restore my seal', 'Your connected wallet sealed this seed. Restore the receipt on this device.');
    }
    if (mode === 'idle') say(status === 'unclaimed' ? `Unclaimed. The first seal owns seed ${seed} on-chain.` : 'Claim registry unavailable right now. You can still seal.');
  }

  function unlock(r, fresh) {
    if (r.seed === readSeed()) set('sealed', sealedLabel, ...sealedNote(r));
    else refresh().then(() => say(`Sealed seed ${r.seed}.`));
    Promise.resolve()
      .then(() => onUnlocked?.({ seed: r.seed, receipt: r, certificate: gate.certificate(r.seed, r), fresh }))
      .catch((e) => say(`Export failed: ${e?.message ?? e}`, { err: true }));
  }

  const busyText = { connecting: 'Connect wallet…', checking: 'Checking claim…', confirm: 'Confirm in wallet…', pending: 'Waiting for block…', verifying: 'Verifying…' };
  async function doClaim() {
    const s = seed;
    busy = true;
    try {
      const r = await gate.claim(s, {
        onStatus: (st, info) => {
          if (st === 'sealed') return;
          if (st === 'pending') pending = { seed: s, txHash: info.txHash };
          const msg = st === 'confirm' ? `Sending ${gate.priceLabel} to ${gate.payeeLabel} on ${gate.chainName}.` : st === 'pending' ? 'Transaction sent.' : '';
          set('busy', busyText[st] ?? 'Working…', msg, { disabled: true, link: info?.url && { text: 'view tx', href: info.url } });
        },
      });
      pending = null;
      busy = false;
      unlock(r, true);
    } catch (e) {
      busy = false;
      if (e.code === 'TX_FAILED') pending = null; // reverted: nothing paid but gas, safe to retry
      if (e.code === 'USER_REJECTED') { await refresh(); return say('Cancelled. Nothing was sent.'); }
      if (e.code === 'ALREADY_CLAIMED') return refresh();
      if (pending?.seed === s) {
        ownTx = pending.txHash;
        input.value = ownTx;
        return set('check', 'Check transaction', e.message, { err: true, link: { text: 'view tx', href: gate.txUrl(ownTx) } });
      }
      set('error', `Retry · ${buyLabel()}`, e.message ?? String(e), { err: true });
    }
  }

  async function doRestore(hash) {
    if (busy) return;
    busy = true;
    const before = mode;
    set('busy', 'Verifying…', '', { disabled: true });
    const v = await gate.restore(hash).catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
    busy = false;
    if (!v.ok) {
      if (before === 'check') return set('check', 'Check transaction', `Not confirmed yet: ${v.reason}`, { err: true, link: { text: 'view tx', href: gate.txUrl(ownTx) } });
      await refresh();
      return say(`Could not restore: ${v.reason}`, { err: true });
    }
    if (pending?.txHash === v.receipt.txHash) pending = null;
    form.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    input.value = '';
    if (v.receipt.seed === readSeed()) return unlock(v.receipt, before === 'check');
    await refresh();
    say(`Receipt restored for seed ${v.receipt.seed}.`);
    try { onRestored?.(v.receipt); } catch { /* host callback */ }
  }

  btn.addEventListener('click', () => {
    if (mode === 'sealed') { const r = gate.receipt(seed); return r ? unlock(r, false) : refresh(); }
    if (mode === 'restore-own' || mode === 'check') return doRestore(ownTx);
    if (mode === 'idle' || mode === 'error') return doClaim();
  });
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) input.focus();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); doRestore(input.value); });

  const onWallet = () => refresh();
  window.addEventListener('ethereum#initialized', onWallet, { once: true }); // wallets that inject late
  const timer = watchMs > 0 ? setInterval(() => { if (!busy && readSeed() !== seed) refresh(); }, watchMs) : null;
  refresh();

  return {
    el: wrap,
    refresh,
    destroy() { clearInterval(timer); window.removeEventListener('ethereum#initialized', onWallet); wrap.remove(); },
  };
}
