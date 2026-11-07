
const RPC = require('discord-rpc');

const CLIENT_ID = '1566637507494289529';
const RECONNECT_DELAY_MS = 15000;
// Art asset key for the Soulleak logo; upload an image under this name in the Discord app's Rich Presence art.
const LOGO_ASSET = 'soulleak';

let rpcClient = null;
let isConnected = false;
let isEnabled = true;
let lastTrackInfo = null;
let reconnectTimer = null;
let isDestroying = false;
// Shown on the Discord card in Settings so a user can see why their status is missing.
let lastError = '';
let lastUser = '';

function initRPC() {
  if (rpcClient || isDestroying) return;

  rpcClient = new RPC.Client({ transport: 'ipc' });

  rpcClient.on('ready', () => {
    isConnected = true;
    lastError = '';
    lastUser = rpcClient.user?.global_name || rpcClient.user?.username || '';
    console.log('[Discord RPC] Connected as', rpcClient.user?.username || 'unknown');
    if (lastTrackInfo && isEnabled) {
      _setActivity(lastTrackInfo);
    }
  });

  rpcClient.on('disconnected', () => {
    console.log('[Discord RPC] Disconnected');
    isConnected = false;
    rpcClient = null;
    scheduleReconnect();
  });

  rpcClient.login({ clientId: CLIENT_ID }).catch(err => {
    console.warn('[Discord RPC] Login failed:', err.message || err);
    lastError = String((err && err.message) || err);
    isConnected = false;
    rpcClient = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer || isDestroying || !isEnabled) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isEnabled && !isDestroying) {
      initRPC();
    }
  }, RECONNECT_DELAY_MS);
}

const SOULLEAK_URL = 'https://github.com/AliHayani/soulleak';

function _setActivity(trackInfo) {
  if (!rpcClient || !isConnected || !trackInfo) return;
  const now = Math.floor(Date.now() / 1000);
  const startEpoch = trackInfo.startTimestamp || now;
  const showArtistStatus = trackInfo.artistInStatus !== false;
  const cleanTitle = String(trackInfo.title || 'Unknown Track').substring(0, 128).padEnd(2, ' ');
  const effects = String(trackInfo.effects || '').trim().substring(0, 60);
  const artistText = showArtistStatus ? String(trackInfo.artist || 'Unknown Artist') : `by ${trackInfo.artist || 'Unknown Artist'}`;
  // Active presets ride along after the artist, e.g. "Tobiahs · Slowed + reverb". A paused song says so up front.
  const paused = !!trackInfo.paused;
  const stateBase = effects ? `${artistText} · ${effects}` : artistText;
  const stateText = (paused ? `Paused · ${stateBase}` : stateBase).substring(0, 128).padEnd(2, ' ');
  const baseActivity = {
    type: 2,
    details: cleanTitle,
    state: stateText,
    timestamps: { start: startEpoch },
    assets: {
      // Discord rejects the whole status when an image link is over 300 characters (some YouTube Music and
      // Spotify covers are), so a long link falls back to the logo.
      large_image: (trackInfo.thumbnail && trackInfo.thumbnail.length <= 300) ? trackInfo.thumbnail : LOGO_ASSET,
      large_text: (effects ? `${cleanTitle.trim()} · ${effects}` : cleanTitle.trim()).substring(0, 128).padEnd(2, ' '),
      small_image: LOGO_ASSET,
      small_text: paused ? 'Paused' : (effects ? `Soulleak · ${effects}`.substring(0, 128) : 'Soulleak')
    },
    instance: false,
  };
  // No clock while paused, so Discord doesn't keep counting up.
  if (paused) delete baseActivity.timestamps;
  else if (trackInfo.duration && trackInfo.duration > 0) {
    baseActivity.timestamps.end = startEpoch + Math.floor(trackInfo.duration);
  }
  // The button sends people to Soulleak's GitHub page (not the song's YouTube/SoundCloud link), to spread the app.
  baseActivity.buttons = [{ label: 'Get Soulleak', url: SOULLEAK_URL }];
  const primaryActivity = showArtistStatus
    ? Object.assign({}, baseActivity, { status_display_type: 1 })
    : baseActivity;
  // If Discord refuses a field, try the plain status, then a bare one (logo art, no button), so something shows.
  const minimalActivity = Object.assign({}, baseActivity, { assets: { large_image: LOGO_ASSET, large_text: 'Soulleak' } });
  delete minimalActivity.buttons;
  const send = (activity) => (rpcClient && isConnected
    ? rpcClient.request('SET_ACTIVITY', { pid: process.pid, activity })
    : Promise.reject(new Error('Not connected to Discord')));
  send(primaryActivity)
    .catch(() => send(baseActivity))
    .catch((err) => {
      console.warn('[Discord RPC] SET_ACTIVITY error:', err.message || err);
      return send(minimalActivity);
    })
    .then(() => { lastError = ''; })
    .catch((err) => {
      lastError = String((err && err.message) || err);
      console.warn('[Discord RPC] Minimal status failed too:', lastError);
    });
}


function updatePresence(trackInfo) {
  if (!trackInfo) return;

  lastTrackInfo = trackInfo;

  if (!isEnabled) return;

  if (isConnected && rpcClient) {
    _setActivity(trackInfo);
  } else if (!rpcClient && !reconnectTimer) {
    initRPC();
  }
}

function clearPresence() {
  lastTrackInfo = null;
  if (rpcClient && isConnected) {
    rpcClient.clearActivity().catch(() => {});
  }
}

function setEnabled(enabled) {
  isEnabled = !!enabled;

  if (isEnabled) {
    if (!rpcClient) {
      initRPC();
    } else if (lastTrackInfo) {
      _setActivity(lastTrackInfo);
    }
  } else {
    if (rpcClient && isConnected) {
      rpcClient.clearActivity().catch(() => {});
    }
    destroyRPC();
  }
}

function getEnabled() {
  return isEnabled;
}

function getStatus() {
  return { enabled: isEnabled, connected: isConnected, user: isConnected ? lastUser : '', error: lastError };
}

function getConnected() {
  return isConnected;
}

function destroyRPC() {
  isDestroying = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (rpcClient) {
    try {
      rpcClient.destroy().catch(() => {});
    } catch (e) {}
    rpcClient = null;
  }
  isConnected = false;
  setTimeout(() => { isDestroying = false; }, 500);
}

function reconnectRPC() {
  destroyRPC();
  setTimeout(() => initRPC(), 600);
}

module.exports = {
  initRPC,
  updatePresence,
  clearPresence,
  setEnabled,
  getEnabled,
  getConnected,
  getStatus,
  destroyRPC,
  reconnectRPC,
};
