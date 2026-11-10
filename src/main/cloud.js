// Soulleak Cloud: accounts and library sync through Supabase (Auth + the public.soulleak_vaults table).
//
// Everything that touches the login lives here in the main process: the page asks for sign in / sign up / pull / push
// over IPC and never sees a token. The session (access + refresh token) is saved encrypted with the OS key store
// (safeStorage), so you stay logged in across restarts and updates; the access token is refreshed automatically.
//
// The page does the merging (cloud-sync.js) and keeps the app offline-first: nothing here blocks startup.
const { app, ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://mwvctyrgfwghswsvcfuj.supabase.co';
// Public "anon"/publishable key: it only allows what the table's row-level security policies allow.
const SUPABASE_KEY = 'sb_publishable_PYJFWW3_OYp7lyafSAL3uw_zjLiXMzK';
const TABLE = 'soulleak_vaults';
const MAX_VAULT_BYTES = 8 * 1024 * 1024;
// Accounts are username + password. Supabase Auth needs an email, so each username gets a private internal address
// (never shown, never mailed: email confirmation is off for this project). 3-20 characters: a-z, 0-9 and _.
const INTERNAL_EMAIL_DOMAIN = 'soulleak.local';
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const normUsername = (u) => String(u || '').trim().toLowerCase();
const internalEmail = (u) => `${normUsername(u)}@${INTERNAL_EMAIL_DOMAIN}`;
const isInternal = (email) => String(email || '').toLowerCase().endsWith('@' + INTERNAL_EMAIL_DOMAIN);

let baseUrl = SUPABASE_URL;
let session = null; // { access_token, refresh_token, expires_at (s), user: { id, email }, username, localAccountId }
let refreshing = null;
let pendingPush = null;

const dataDir = () => app.getPath('userData');
const sessionFile = () => path.join(dataDir(), 'cloud-session.bin');
const baseFile = (uid) => path.join(dataDir(), `cloud-base-${String(uid).replace(/[^a-z0-9-]/gi, '')}.json`);

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  } catch (_) { return false; }
}

function saveSession() {
  try {
    const file = sessionFile();
    if (!session) { try { fs.unlinkSync(file); } catch (_) {} return; }
    const json = JSON.stringify(session);
    const data = canEncrypt() ? Buffer.concat([Buffer.from('ENC1'), safeStorage.encryptString(json)]) : Buffer.from('RAW1' + json);
    fs.writeFileSync(file + '.tmp', data, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.warn('[cloud] could not save the session:', e.message); }
}

// The OS key store can only decrypt once Electron is ready, so the session is read on first use (not at startup).
let sessionLoaded = false;
function ensureSession() {
  if (sessionLoaded || !app.isReady()) return;
  sessionLoaded = true;
  loadSession();
}

function loadSession() {
  try {
    const buf = fs.readFileSync(sessionFile());
    const tag = buf.slice(0, 4).toString();
    const json = tag === 'ENC1' ? safeStorage.decryptString(buf.slice(4)) : (tag === 'RAW1' ? buf.slice(4).toString() : '');
    const s = JSON.parse(json);
    if (s && s.refresh_token && s.user && s.user.id) session = s;
  } catch (_) { session = null; }
}

// Supabase error bodies -> one plain sentence for the Account card.
function friendlyError(status, body) {
  const code = String((body && (body.error_code || body.code || body.error)) || '');
  const msg = String((body && (body.msg || body.message || body.error_description)) || '');
  const both = `${code} ${msg}`.toLowerCase();
  if (/invalid_credentials|invalid login/.test(both)) return 'Wrong username or password.';
  if (/user_already_exists|already registered|already been registered/.test(both)) return 'That username is taken. Pick another one, or sign in if it\'s yours.';
  if (/weak_password|password should be|at least 6/.test(both)) return 'Choose a longer password (at least 6 characters).';
  if (/email_address_invalid|invalid email|unable to validate email/.test(both)) return 'Usernames can only use a-z, 0-9 and _ (3 to 20 characters).';
  if (/email_not_confirmed/.test(both)) return 'Confirm your email first (check your inbox), then sign in.';
  if (/rate limit|over_.*limit|too many/.test(both)) return 'Too many tries. Wait a minute and try again.';
  if (/signup.*disabled|signups not allowed/.test(both)) return 'New accounts are switched off right now.';
  if (status === 401 || status === 403) return 'Your session expired. Sign in again.';
  return msg || `Cloud error (${status})`;
}

async function request(method, urlPath, { body, token, headers = {}, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token || SUPABASE_KEY}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error('You\'re offline or Soulleak Cloud can\'t be reached. It will sync when you\'re back online.');
    err.offline = true;
    throw err;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function takeSession(data, extra = {}) {
  if (!data || !data.access_token || !data.refresh_token || !data.user) return false;
  const meta = data.user.user_metadata || {};
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: { id: data.user.id, email: data.user.email || '' },
    username: extra.username || meta.username || (session && session.username) || '',
    localAccountId: extra.localAccountId || (session && session.localAccountId) || '',
  };
  saveSession();
  return true;
}

// A valid access token, refreshed first when it expires within a minute. Several callers share one refresh.
async function accessToken() {
  if (!session) throw Object.assign(new Error('Not signed in'), { signedOut: true });
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const data = await request('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
        takeSession(data);
      } catch (e) {
        // A refused refresh token means the login is gone (signed out elsewhere, password changed): sign out here.
        if (e.status === 400 || e.status === 401 || e.status === 403) { session = null; saveSession(); e.signedOut = true; }
        throw e;
      } finally { refreshing = null; }
    })();
  }
  await refreshing;
  return session.access_token;
}

function publicStatus() {
  if (!session) return { signedIn: false };
  const email = session.user.email || '';
  return {
    signedIn: true,
    userId: session.user.id,
    username: session.username || email.split('@')[0],
    // The internal address is an implementation detail: the page only gets a real email, if the account has one.
    email: isInternal(email) ? '' : email,
    localAccountId: session.localAccountId || '',
  };
}

async function getVault() {
  const token = await accessToken();
  const rows = await request('GET', `/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(session.user.id)}&select=vault_data,updated_at,username`, { token });
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? { vault: row.vault_data || null, updatedAt: row.updated_at || null } : { vault: null, updatedAt: null };
}

async function putVault(vault) {
  const token = await accessToken();
  const row = { user_id: session.user.id, username: session.username || '', vault_data: vault, updated_at: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(row)) > MAX_VAULT_BYTES) throw new Error('Your library is too big to sync (over 8 MB).');
  try {
    const out = await request('POST', `/rest/v1/${TABLE}?on_conflict=user_id`, { token, body: row, headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });
    return { updatedAt: (Array.isArray(out) && out[0] && out[0].updated_at) || row.updated_at };
  } catch (e) {
    // Without a unique constraint on user_id the upsert is refused (42P10): update the row, or insert it if there's none.
    if (!(e.body && (e.body.code === '42P10' || e.body.code === '21000'))) throw e;
    const upd = await request('PATCH', `/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(session.user.id)}`, { token, body: row, headers: { Prefer: 'return=representation' } });
    if (Array.isArray(upd) && upd.length) return { updatedAt: upd[0].updated_at || row.updated_at };
    await request('POST', `/rest/v1/${TABLE}`, { token, body: row, headers: { Prefer: 'return=minimal' } });
    return { updatedAt: row.updated_at };
  }
}

const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, ...(await fn(...args)) }; } catch (e) {
    return { ok: false, error: e.message || String(e), offline: !!e.offline, signedOut: !!e.signedOut || !session };
  }
};

function initCloud() {
  // Development only: point the app at a local stand-in of the Supabase API for testing.
  if (!app.isPackaged && process.env.SOULLEAK_CLOUD_URL) baseUrl = process.env.SOULLEAK_CLOUD_URL.replace(/\/+$/, '');
  app.whenReady().then(ensureSession);

  const handle = (name, fn) => { try { ipcMain.removeHandler(name); } catch (_) {} ipcMain.handle(name, (e, ...args) => { ensureSession(); return wrap(fn)(e, ...args); }); };

  handle('cloud-status', async () => publicStatus());

  handle('cloud-sign-up', async ({ username, password, localAccountId } = {}) => {
    username = normUsername(username);
    if (!USERNAME_RE.test(username)) throw new Error('Usernames are 3 to 20 characters: a-z, 0-9 and _.');
    if (String(password || '').length < 6) throw new Error('Choose a longer password (at least 6 characters).');
    const email = internalEmail(username);
    const data = await request('POST', '/auth/v1/signup', { body: { email, password: String(password), data: { username } } });
    // With email confirmation switched on, Supabase returns the user but no session yet.
    if (!takeSession(data.access_token ? data : (data && data.session) ? { ...data.session, user: data.user || data.session.user } : null, { username, localAccountId })) {
      return { needsConfirm: true, ...publicStatus() };
    }
    return publicStatus();
  });

  handle('cloud-sign-in', async ({ username, password, localAccountId } = {}) => {
    const name = normUsername(username);
    if (!name || !password) throw new Error('Enter your username and password.');
    // Usernames map to their internal address; an account made with a real email can still sign in with it.
    const email = name.includes('@') ? name : internalEmail(name);
    const data = await request('POST', '/auth/v1/token?grant_type=password', { body: { email, password: String(password) } });
    if (!takeSession(data, { localAccountId, username: name.includes('@') ? '' : name })) throw new Error('Sign in failed. Try again.');
    return publicStatus();
  });

  handle('cloud-sign-out', async () => {
    const token = session && session.access_token;
    session = null;
    saveSession();
    if (token) { try { await request('POST', '/auth/v1/logout', { token, timeoutMs: 5000 }); } catch (_) {} }
    return publicStatus();
  });

  handle('cloud-pull', async () => getVault());

  // Just "when did the cloud vault last change": a few bytes, for the frequent checks (focus, every 2 minutes).
  handle('cloud-head', async () => {
    const token = await accessToken();
    const rows = await request('GET', `/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(session.user.id)}&select=updated_at`, { token, timeoutMs: 8000 });
    return { updatedAt: (Array.isArray(rows) && rows[0] && rows[0].updated_at) || null };
  });

  handle('cloud-push', async (vault) => {
    if (!vault || typeof vault !== 'object') throw new Error('Nothing to sync.');
    const p = putVault(vault);
    pendingPush = p.finally(() => { if (pendingPush === p) pendingPush = null; });
    return await p;
  });

  // The last synced copy (the "base" of the three-way merge), per cloud user, on disk.
  handle('cloud-base-get', async () => {
    if (!session) return { base: null };
    try { return { base: JSON.parse(fs.readFileSync(baseFile(session.user.id), 'utf8')) }; } catch (_) { return { base: null }; }
  });
  handle('cloud-base-set', async (base) => {
    if (!session) return {};
    const f = baseFile(session.user.id);
    fs.writeFileSync(f + '.tmp', JSON.stringify(base || null));
    fs.renameSync(f + '.tmp', f);
    return {};
  });

  // Let a sync that is on its way finish before quitting (at most 3 s).
  let quitWaited = false;
  app.on('before-quit', (e) => {
    if (!pendingPush || quitWaited) return;
    e.preventDefault();
    quitWaited = true;
    Promise.race([pendingPush.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]).then(() => app.quit());
  });
}

module.exports = { initCloud };
