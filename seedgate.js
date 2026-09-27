// seedgate.js: sell high-res exports of one seed for ETH on Base, with on-chain provenance and no backend.
// Zero dependencies. Built against EIP-1193 (provider), EIP-3326/3085 (switch/add chain), the Ethereum JSON-RPC
// spec and the Blockscout API v2. A client-side gate is a SOFT gate. See README.md for the threat model.

export const VERSION = 'v1';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const APP_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const NUM_SEED_RE = /^-?\d{1,78}$/;
const TOKEN_SEED_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const WEI_PER_ETH = 10n ** 18n;

export const CHAINS = Object.freeze({
  8453: { name: 'Base', currency: 'Ether', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', api: 'https://base.blockscout.com/api/v2' },
  84532: { name: 'Base Sepolia', currency: 'Sepolia Ether', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', api: 'https://base-sepolia.blockscout.com/api/v2' },
});

export class SeedGateError extends Error {
  constructor(code, message, extra) { super(message); this.name = 'SeedGateError'; this.code = code; Object.assign(this, extra); }
}
const err = (code, message, extra) => new SeedGateError(code, message, extra);

// ---------------------------------------------------------------- pure helpers

/** Decimal ETH string -> wei bigint. '0.002' -> 2000000000000000n. Never uses floating point. */
export function parseEther(value) {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string') throw new TypeError('parseEther expects a decimal string like "0.002"');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2])) throw new RangeError(`Not a decimal ETH amount: "${value}"`);
  const frac = m[2] ?? '';
  if (frac.length > 18) throw new RangeError(`More than 18 decimals: "${value}"`);
  return BigInt(m[1] || '0') * WEI_PER_ETH + BigInt(frac.padEnd(18, '0'));
}

/** Wei bigint -> trimmed decimal ETH string. 2000000000000000n -> '0.002'. */
export function formatEther(wei) {
  const w = toWei(wei);
  const frac = (w % WEI_PER_ETH).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${w / WEI_PER_ETH}.${frac}` : `${w / WEI_PER_ETH}`;
}

/** Wei (bigint or decimal-integer string) -> JSON-RPC QUANTITY hex ('0x0' for zero, no leading zeros). */
export function toHexWei(wei) { return '0x' + toWei(wei).toString(16); }

function toWei(v) {
  const w = typeof v === 'bigint' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? BigInt(v.trim()) : null;
  if (w === null || w < 0n) throw new RangeError(`Expected a non-negative wei amount (bigint or integer string), got ${String(v)}`);
  return w;
}

/** Case-insensitive address equality. false if either side is not a 0x + 40 hex address. */
export function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && ADDR_RE.test(a) && ADDR_RE.test(b) && a.toLowerCase() === b.toLowerCase();
}

/** Canonical seed string: integers become canonical decimal strings; short [A-Za-z0-9_.-] tokens pass as-is. */
export function normalizeSeed(seed) {
  if (typeof seed === 'bigint') return seed.toString();
  if (typeof seed === 'number' && Number.isSafeInteger(seed)) return String(seed);
  if (typeof seed === 'string') {
    const s = seed.trim();
    if (NUM_SEED_RE.test(s)) return BigInt(s).toString();
    if (TOKEN_SEED_RE.test(s)) return s;
  }
  throw err('BAD_SEED', `Invalid seed: ${String(seed).slice(0, 80)}`);
}

const toHex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function fromHex(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** -> { text: 'seedgate:v1:<app>:<seed>', hex: '0x…' } (hex = UTF-8 bytes, used as tx calldata). */
export function encodeMemo(app, seed) {
  if (!APP_RE.test(app ?? '')) throw err('BAD_CONFIG', `Invalid app id "${app}" (use lowercase a-z, 0-9, - or _)`);
  const text = `seedgate:${VERSION}:${app}:${normalizeSeed(seed)}`;
  return { text, hex: toHex(new TextEncoder().encode(text)) };
}

/** Strict inverse of encodeMemo. Returns { text, version, app, seed } or null (wrong tag, trailing bytes, '007'…). */
export function decodeMemo(hex) {
  const bytes = fromHex(hex);
  if (!bytes || bytes.length === 0 || bytes.length > 200) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  const parts = text.split(':');
  if (parts.length !== 4) return null;
  const [tag, version, app, seed] = parts;
  if (tag !== 'seedgate' || version !== VERSION || !APP_RE.test(app)) return null;
  let canon;
  try { canon = normalizeSeed(seed); } catch { return null; }
  return canon === seed ? { text, version, app, seed } : null;
}

const shortHex = (x) => (typeof x === 'string' && x.length > 12 ? `${x.slice(0, 6)}…${x.slice(-4)}` : String(x ?? '?'));
const num = (v) => (v == null ? null : Number(BigInt(v)));

/** Normalise a Blockscout v2 transaction object (GET /transactions/{hash} or an address-transactions item). */
export function explorerTx(j) {
  if (!j || !HASH_RE.test(j.hash ?? '')) return null;
  const block = j.block_number ?? j.block;
  return {
    hash: j.hash, from: j.from?.hash ?? null, to: j.to?.hash ?? null, value: BigInt(j.value ?? '0'),
    input: j.raw_input ?? j.input ?? '0x', chainId: null, position: Number(j.position ?? 0),
    status: j.status === 'ok' ? 'ok' : j.status === 'error' ? 'failed' : 'pending',
    blockNumber: block == null ? null : Number(block), ts: j.timestamp ? Date.parse(j.timestamp) : null,
  };
}

function normalizeRpcError(e) {
  if (e instanceof SeedGateError) return e;
  const code = e?.code ?? e?.error?.code;
  const inner = e?.data?.originalError?.code;
  const msg = String(e?.message ?? e ?? 'Unknown wallet error');
  if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)/i.test(msg)) return err('USER_REJECTED', 'Request cancelled in your wallet.', { cause: e });
  if (code === -32002) return err('WALLET_BUSY', 'Your wallet already has a pending request. Open it to continue.', { cause: e });
  if (code === 4902 || inner === 4902) return err('UNKNOWN_CHAIN', msg, { cause: e });
  return err('WALLET_ERROR', msg, { cause: e, rpcCode: code });
}

// ---------------------------------------------------------------- the gate

export function createSeedGate(config = {}) {
  const cfg = { chainId: 8453, pollMs: 2000, timeoutMs: 180_000, registryPages: 10, registryTtlMs: 60_000, ...config };
  const chain = CHAINS[cfg.chainId];
  if (!chain) throw err('BAD_CONFIG', 'chainId must be 8453 (Base) or 84532 (Base Sepolia)');
  if (!APP_RE.test(cfg.app ?? '')) throw err('BAD_CONFIG', 'app must be a lowercase id such as "glitchography"');
  if (!ADDR_RE.test(cfg.payee ?? '')) throw err('BAD_CONFIG', 'payee must be a 0x address. Resolve ENS names like mrio.eth at app.ens.domains first');
  if (typeof cfg.priceWei === 'string' && !/^\d+$/.test(cfg.priceWei.trim())) throw err('BAD_CONFIG', 'priceWei must be an integer wei amount. For ETH use priceEth: "0.002" or parseEther("0.002")');

  const { app, chainId } = cfg;
  const payee = cfg.payee.toLowerCase();
  const payeeSet = payee !== ZERO_ADDRESS;
  const payeeLabel = cfg.payeeLabel || shortHex(cfg.payee);
  const appLabel = cfg.appLabel || app;
  const priceWei = cfg.priceWei != null ? toWei(cfg.priceWei) : parseEther(cfg.priceEth ?? '0.002');
  const minWei = cfg.minWei != null ? toWei(cfg.minWei) : priceWei; // keep at your lowest historic price if you raise prices
  const api = cfg.explorerApi === undefined ? chain.api : cfg.explorerApi ? String(cfg.explorerApi).replace(/\/+$/, '') : null;
  const storageKey = cfg.storageKey || `seedgate:${VERSION}:${app}:${chainId}`;
  const hexChainId = '0x' + chainId.toString(16);
  const getProvider = () => ('provider' in cfg ? cfg.provider : globalThis.window?.ethereum) ?? null;
  const doFetch = cfg.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = cfg.now ?? Date.now;
  const storage = () => { if ('storage' in cfg) return cfg.storage; try { return globalThis.localStorage ?? null; } catch { return null; } };
  const mem = new Map(); // session fallback when localStorage is blocked
  let busy = false, regCache = null;

  async function rpc(method, params) {
    const p = getProvider();
    if (!p?.request) throw err('NO_WALLET', 'No Ethereum wallet found. Install one (Rabby, MetaMask, Coinbase Wallet) to seal.');
    try { return await p.request(params ? { method, params } : { method }); } catch (e) { throw normalizeRpcError(e); }
  }
  const walletChain = async () => num(await rpc('eth_chainId'));

  async function onChain() {
    for (let i = 0; i < 5; i++) { if ((await walletChain()) === chainId) return true; await sleep(150); } // some wallets update chainId lazily
    return false;
  }

  async function ensureChain() {
    if ((await walletChain()) === chainId) return;
    const switchChain = () => rpc('wallet_switchEthereumChain', [{ chainId: hexChainId }]);
    try { await switchChain(); } catch (e) {
      if (e.code !== 'UNKNOWN_CHAIN' && !/unrecognized|not been added|unknown chain|addEthereumChain/i.test(e.message)) throw e;
      await rpc('wallet_addEthereumChain', [{
        chainId: hexChainId, chainName: chain.name, nativeCurrency: { name: chain.currency, symbol: 'ETH', decimals: 18 },
        rpcUrls: [chain.rpc], blockExplorerUrls: [chain.explorer],
      }]);
      if ((await walletChain()) !== chainId) await switchChain().catch((e2) => { if (e2.code === 'USER_REJECTED') throw e2; });
    }
    if (!(await onChain())) throw err('WRONG_CHAIN', `Please switch your wallet to ${chain.name}.`);
  }

  async function connect() {
    const accounts = await rpc('eth_requestAccounts');
    if (!Array.isArray(accounts) || !ADDR_RE.test(accounts[0] ?? '')) throw err('NO_ACCOUNT', 'Your wallet returned no account.');
    await ensureChain();
    return accounts[0];
  }

  /** Already-authorised account without prompting (eth_accounts), or null. */
  async function currentAccount() {
    if (!getProvider()?.request) return null;
    try { const a = await rpc('eth_accounts'); return ADDR_RE.test(a?.[0] ?? '') ? a[0] : null; } catch { return null; }
  }

  // ---- receipts (localStorage, try/catch everywhere)
  function loadAll() {
    try { const o = JSON.parse(storage()?.getItem(storageKey) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
  }
  function store(r) {
    mem.set(r.seed, r);
    try { const all = loadAll(); all[r.seed] = r; storage()?.setItem(storageKey, JSON.stringify(all)); } catch { /* private mode: session only */ }
  }
  const validReceipt = (r, s) => !!r && r.seed === s && r.app === app && r.chainId === chainId && sameAddress(r.to, payee) && HASH_RE.test(r.txHash ?? '');
  function receipt(seed) {
    let s; try { s = normalizeSeed(seed); } catch { return null; }
    const r = mem.get(s) ?? loadAll()[s];
    return validReceipt(r, s) ? r : null;
  }
  const receipts = () => Object.values({ ...loadAll(), ...Object.fromEntries(mem) }).filter((r) => validReceipt(r, r?.seed));

  // ---- reading transactions
  async function getJSON(url) {
    if (!doFetch) throw new Error('fetch unavailable');
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12_000) : undefined;
    const res = await doFetch(url, { headers: { accept: 'application/json' }, signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }

  async function txFromProvider(h) {
    const [tx, rc] = await Promise.all([rpc('eth_getTransactionByHash', [h]), rpc('eth_getTransactionReceipt', [h])]);
    if (!tx) return null;
    let ts = null;
    if (rc?.blockNumber) try { const bt = num((await rpc('eth_getBlockByNumber', [rc.blockNumber, false]))?.timestamp); ts = bt == null ? null : bt * 1000; } catch { /* optional */ }
    return {
      hash: tx.hash ?? h, from: tx.from, to: tx.to ?? null, value: BigInt(tx.value ?? '0x0'), input: tx.input ?? tx.data ?? '0x',
      chainId: num(tx.chainId), position: num(rc?.transactionIndex) ?? 0, ts,
      status: !rc?.blockNumber ? 'pending' : BigInt(rc.status ?? 0) === 1n ? 'ok' : 'failed', blockNumber: num(rc?.blockNumber),
    };
  }

  /** Normalised tx from the wallet (if on the right chain), else from the explorer, else { reason }. */
  async function loadTx(h) {
    if (getProvider()?.request) {
      try {
        const cid = await walletChain();
        if (cid === chainId) { const t = await txFromProvider(h); if (t) return t; }
        else if (!api) return { reason: `wrong chain: your wallet is on chain ${cid}, not ${chain.name} (${chainId})` };
      } catch { /* fall back to the explorer */ }
    }
    if (api) { try { const t = explorerTx(await getJSON(`${api}/transactions/${h}`)); if (t) return t; } catch { /* offline / CORS */ } }
    return { reason: 'transaction not found (it may still be propagating, or it is on another chain)' };
  }

  const no = (reason) => ({ ok: false, reason, receipt: null });
  function check(t, s) {
    if (t.status === 'pending' || t.blockNumber == null) return no('transaction is still pending');
    if (t.status !== 'ok') return no('transaction failed on-chain');
    if (!ADDR_RE.test(t.from ?? '')) return no('malformed transaction (no sender)');
    if (t.chainId != null && t.chainId !== chainId) return no(`wrong chain: transaction is on chain ${t.chainId}, not ${chain.name} (${chainId})`);
    if (!sameAddress(t.to, payee)) return no(`wrong recipient: paid ${shortHex(t.to)}, not ${payeeLabel}` + (t.value === 0n ? ' (smart-contract wallets that bundle calls are not supported; use a regular wallet account)' : ''));
    if (t.value < minWei) return no(`underpaid: ${formatEther(t.value)} ETH < ${formatEther(minWei)} ETH`);
    const m = decodeMemo(t.input);
    if (!m || m.app !== app || m.seed !== s) return no(`memo mismatch: expected "${encodeMemo(app, s).text}", got ${m ? `"${m.text}"` : 'no seedgate memo'}`);
    return { ok: true, reason: 'ok', receipt: {
      txHash: t.hash.toLowerCase(), seed: s, from: t.from.toLowerCase(), blockNumber: t.blockNumber, app,
      ts: t.ts ?? now(), chainId, to: payee, value: t.value.toString(),
    } };
  }

  async function verify(txHash, seed) {
    let s; try { s = normalizeSeed(seed); } catch (e) { return no(e.message); }
    const h = String(txHash ?? '').trim().toLowerCase();
    if (!HASH_RE.test(h)) return no('not a transaction hash (0x + 64 hex characters)');
    const t = await loadTx(h);
    return t.reason ? no(t.reason) : check(t, s);
  }

  /** Verify a pasted tx hash (seed read from its memo) and store the receipt, e.g. for a buyer on a new device. */
  async function restore(txHash) {
    const h = String(txHash ?? '').trim().toLowerCase();
    if (!HASH_RE.test(h)) return no('not a transaction hash (0x + 64 hex characters)');
    const t = await loadTx(h);
    if (t.reason) return no(t.reason);
    const m = decodeMemo(t.input);
    if (!m || m.app !== app) return no(`not a ${app} seedgate claim`);
    const v = check(t, m.seed);
    if (v.ok) store(v.receipt);
    return v;
  }

  async function waitReceipt(h) {
    const t0 = now();
    while (now() - t0 < cfg.timeoutMs) {
      try { const rc = await rpc('eth_getTransactionReceipt', [h]); if (rc?.blockNumber) return rc; } catch { /* transient: keep polling */ }
      await sleep(cfg.pollMs);
    }
    throw err('TIMEOUT', `Not mined after ${Math.round(cfg.timeoutMs / 1000)}s. Paste the tx hash later to restore.`, { txHash: h });
  }

  async function claim(seed, { onStatus, force = false } = {}) {
    const s = normalizeSeed(seed);
    if (!payeeSet) throw err('PAYEE_UNSET', 'Payee is the zero-address placeholder. Set config.payee to your real address before selling.');
    const have = receipt(s);
    if (have && !force) return have;
    if (busy) throw err('BUSY', 'A claim is already in progress.');
    busy = true;
    const emit = (state, info) => { try { onStatus?.(state, info); } catch { /* UI errors must not break payment */ } };
    try {
      emit('connecting');
      const from = await connect();
      if (!force) { emit('checking'); if ((await claimStatus(s)) === 'claimed') throw err('ALREADY_CLAIMED', `Seed ${s} is already claimed by someone else.`); }
      emit('confirm');
      const txHash = await rpc('eth_sendTransaction', [{ from, to: cfg.payee, value: toHexWei(priceWei), data: encodeMemo(app, s).hex }]);
      if (!HASH_RE.test(txHash ?? '')) throw err('WALLET_ERROR', `Unexpected wallet response: ${String(txHash).slice(0, 80)}`);
      emit('pending', { txHash, url: `${chain.explorer}/tx/${txHash}` });
      const rc = await waitReceipt(txHash);
      if (BigInt(rc.status ?? 0) !== 1n) throw err('TX_FAILED', 'The transaction reverted on-chain.', { txHash });
      emit('verifying', { txHash });
      const v = await verify(txHash, s);
      if (!v.ok) throw err('VERIFY_FAILED', `Payment mined but did not verify: ${v.reason}`, { txHash });
      store(v.receipt);
      if (regCache && !regCache.map.has(s)) regCache.map.set(s, { from: v.receipt.from, txHash: v.receipt.txHash, block: v.receipt.blockNumber, position: 0, ts: v.receipt.ts });
      emit('sealed', v.receipt);
      return v.receipt;
    } finally { busy = false; }
  }

  /** Best-effort seed -> {from, txHash, block} from the payee's incoming txs. Earliest valid claim wins. null on failure. */
  async function registry({ force = false } = {}) {
    if (!api || !doFetch || !payeeSet) return null;
    if (!force && regCache && now() - regCache.at < cfg.registryTtlMs) return regCache.map;
    try {
      const items = [];
      let next = null, complete = false;
      for (let page = 0; page < cfg.registryPages; page++) {
        const q = new URLSearchParams({ filter: 'to' });
        for (const [k, v] of Object.entries(next ?? {})) if (v != null) q.set(k, String(v));
        const j = await getJSON(`${api}/addresses/${payee}/transactions?${q}`);
        if (!Array.isArray(j?.items)) throw new Error('unexpected explorer response');
        items.push(...j.items);
        if (!j.next_page_params) { complete = true; break; }
        next = j.next_page_params;
      }
      const map = new Map();
      for (const raw of items) {
        let t; try { t = explorerTx(raw); } catch { continue; }
        const m = t && decodeMemo(t.input);
        if (!m || m.app !== app || !check(t, m.seed).ok) continue;
        const prev = map.get(m.seed);
        if (!prev || t.blockNumber < prev.block || (t.blockNumber === prev.block && t.position < prev.position)) {
          map.set(m.seed, { from: t.from.toLowerCase(), txHash: t.hash.toLowerCase(), block: t.blockNumber, position: t.position, ts: t.ts });
        }
      }
      map.complete = complete; // false = only the newest pages were read; older claims may exist
      regCache = { at: now(), map };
      return map;
    } catch { return null; }
  }

  /** 'unclaimed' | 'claimed-by-you' | 'claimed' | 'unknown' */
  async function claimStatus(seed) {
    const s = normalizeSeed(seed);
    const mine = receipt(s);
    const [reg, me] = await Promise.all([registry(), currentAccount()]);
    const entry = reg?.get(s);
    if (entry) return sameAddress(entry.from, mine?.from) || sameAddress(entry.from, me) ? 'claimed-by-you' : 'claimed';
    if (mine) return 'claimed-by-you';
    return reg?.complete ? 'unclaimed' : 'unknown';
  }

  /** Text to stamp onto an export. receipt defaults to the stored one for this seed. */
  function certificate(seed, r = receipt(seed)) {
    const s = normalizeSeed(seed);
    if (!r) return null;
    if (r.seed !== s) throw err('BAD_INPUT', `Receipt is for seed ${r.seed}, not ${s}`);
    const date = new Date(r.ts ?? now()).toISOString().slice(0, 10);
    const c = {
      app, appLabel, seed: s, owner: r.from, ownerShort: shortHex(r.from), txHash: r.txHash, txShort: shortHex(r.txHash),
      chain: chain.name, chainId, block: r.blockNumber, date, sealedTo: payeeLabel, url: `${chain.explorer}/tx/${r.txHash}`,
    };
    c.lines = [
      `${appLabel.toUpperCase()} · SEED ${s}`,
      `owner ${c.ownerShort} · tx ${c.txShort}`,
      `${chain.name} · block ${r.blockNumber} · ${date}`,
      `sealed to ${payeeLabel} · seedgate ${VERSION}`,
    ];
    c.text = c.lines.join('\n');
    return c;
  }

  return Object.freeze({
    app, appLabel, payee, payeeLabel, payeeSet, chainId, chainName: chain.name, explorerUrl: chain.explorer, explorerApi: api,
    priceWei, minWei, priceLabel: `${formatEther(priceWei)} ETH`, storageKey,
    hasWallet: () => !!getProvider()?.request,
    memo: (seed) => encodeMemo(app, seed),
    connect, currentAccount, claim, verify, restore, registry, claimStatus, certificate, receipt, receipts,
    isUnlocked: (seed) => !!receipt(seed),
    txUrl: (h) => `${chain.explorer}/tx/${h}`,
  });
}
