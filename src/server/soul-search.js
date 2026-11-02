'use strict';

// Soul Search: turns a mood ("late night drives", "studying", "league of legends") into the most
// popular community playlists on YouTube, SoundCloud and, when the user has connected it, Spotify.

// YouTube Music search filter for "Community playlists" (user-made, with view counts).
const YTM_COMMUNITY_PLAYLISTS_PARAMS = 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D';
const SOURCE_TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
const RESULT_LIMIT = 24;
const SC_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' };

// Filler words that say nothing about the vibe itself.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'with', 'my', 'me', 'i',
  'music', 'song', 'songs', 'playlist', 'playlists', 'mix', 'mixes', 'tracks', 'best', 'top'
]);

// Light stemming so "drives", "driving" and "drive" (or "studies"/"studying"/"study") match.
function stem(word) {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return String(text || '')
    .split(/[^\p{L}\p{N}]+/u)
    .map(stem)
    .filter(Boolean);
}

function moodTokens(query) {
  const all = tokenize(query);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return [...new Set(meaningful.length ? meaningful : all)];
}

// Share of the mood's words that appear in the playlist title (0..1).
function relevance(title, tokens) {
  if (!tokens.length) return 1;
  const words = new Set(tokenize(title));
  const hits = tokens.filter((t) => words.has(t) || (t.length >= 4 && [...words].some((w) => w.startsWith(t)))).length;
  return hits / tokens.length;
}

// "819K" -> 819000, "1.2M" -> 1200000, "27" -> 27.
function parseCount(text) {
  const m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

function formatCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(n);
}

function parseYtmCommunityPlaylists(json) {
  const tabs = json?.contents?.tabbedSearchResultsRenderer?.tabs || [];
  const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const out = [];
  for (const section of sections) {
    for (const item of section?.musicShelfRenderer?.contents || []) {
      const r = item?.musicResponsiveListItemRenderer;
      const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId || '';
      if (!browseId.startsWith('VL')) continue;
      const cols = (r.flexColumns || []).map((c) => (c?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []).map((x) => x.text).join(''));
      const title = (cols[0] || '').trim();
      if (!title) continue;
      const parts = (cols[1] || '').split(' • ').map((s) => s.trim()).filter(Boolean);
      const viewsPart = parts.find((p) => /views?$/i.test(p)) || '';
      const owner = parts.find((p) => p !== viewsPart && !/^playlist$/i.test(p)) || '';
      const thumbs = r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const views = parseCount(viewsPart);
      const playlistId = browseId.slice(2);
      out.push({
        source: 'youtube',
        id: playlistId,
        title,
        owner,
        url: `https://www.youtube.com/playlist?list=${playlistId}`,
        cover: thumbs.length ? thumbs[thumbs.length - 1].url : '',
        trackCount: null,
        popularity: views,
        popularityLabel: viewsPart ? `${formatCount(views)} views` : ''
      });
    }
  }
  return out;
}

function parseSoundCloudPlaylists(json) {
  return (json?.collection || [])
    .filter((p) => p && p.id && p.title && p.permalink_url && !p.is_album)
    .map((p) => {
      const art = p.artwork_url || p.tracks?.find((t) => t && t.artwork_url)?.artwork_url || p.user?.avatar_url || '';
      const likes = Number(p.likes_count) || 0;
      return {
        source: 'soundcloud',
        id: String(p.id),
        title: p.title,
        owner: p.user?.username || '',
        url: p.permalink_url,
        cover: art.replace('-large', '-t500x500'),
        trackCount: Number(p.track_count) || null,
        popularity: likes + (Number(p.reposts_count) || 0) * 2,
        popularityLabel: `${formatCount(likes)} likes`
      };
    });
}

function parseSpotifyPlaylists(json) {
  return (json?.playlists?.items || [])
    // Spotify's own editorial playlists are not community playlists, and new apps often cannot read them.
    .filter((p) => p && p.id && p.name && p.owner?.id !== 'spotify')
    .map((p, i) => ({
      source: 'spotify',
      id: p.id,
      title: p.name,
      owner: p.owner?.display_name || '',
      url: p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}`,
      cover: p.images?.[0]?.url || '',
      trackCount: Number(p.tracks?.total) || null,
      // Spotify's search order already reflects popularity; keep it.
      popularity: 1000 - i,
      popularityLabel: p.tracks?.total ? `${p.tracks.total} tracks` : ''
    }));
}

// Keep playlists that actually match the mood, best first: relevance counts more than raw popularity.
// Partial matches only fill in behind the real matches when a source has fewer than three of them.
function rankSource(items, tokens) {
  const byScore = (a, b) => b.score - a.score;
  const scored = items.map((p) => {
    const rel = relevance(p.title, tokens);
    return { ...p, relevance: rel, score: rel * 2 + Math.log10((p.popularity || 0) + 1) / 3 };
  });
  const strong = scored.filter((p) => p.relevance >= 0.5).sort(byScore);
  if (strong.length >= 3) return strong;
  const partial = scored.filter((p) => p.relevance > 0 && p.relevance < 0.5).sort(byScore);
  return [...strong, ...partial];
}

// Round-robin across sources so one platform cannot crowd out the others.
function interleave(lists, limit) {
  const out = [];
  const seen = new Set();
  const queues = lists.map((l) => [...l]);
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      const next = q.shift();
      if (!next) continue;
      const key = `${next.source}:${next.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

/**
 * deps.ytmSearch(query, params)          -> YouTube Music search JSON
 * deps.soundCloudClientId(force)         -> SoundCloud client_id
 * deps.isSpotifyConnected()              -> boolean
 * deps.spotifyGet(url)                   -> { status, body }
 * deps.fetch                             -> fetch implementation (defaults to global fetch)
 */
function createSoulSearch(deps) {
  const doFetch = deps.fetch || fetch;
  const cache = new Map();

  async function searchYouTube(query) {
    const json = await deps.ytmSearch(query, YTM_COMMUNITY_PLAYLISTS_PARAMS);
    return parseYtmCommunityPlaylists(json);
  }

  async function searchSoundCloud(query) {
    let cid = await deps.soundCloudClientId(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await doFetch(`https://api-v2.soundcloud.com/search/playlists?q=${encodeURIComponent(query)}&limit=30&client_id=${cid}`, { headers: SC_UA });
      if (res.status === 401 || res.status === 403) {
        cid = await deps.soundCloudClientId(true);
        continue;
      }
      if (!res.ok) throw new Error(`SoundCloud returned ${res.status}`);
      return parseSoundCloudPlaylists(await res.json());
    }
    throw new Error('SoundCloud refused the request');
  }

  async function searchSpotify(query) {
    const resp = await deps.spotifyGet(`https://api.spotify.com/v1/search?type=playlist&limit=20&q=${encodeURIComponent(query)}`);
    if (resp.status !== 200) throw new Error(`Spotify returned ${resp.status}`);
    return parseSpotifyPlaylists(JSON.parse(resp.body));
  }

  return async function soulSearch(rawQuery) {
    const query = String(rawQuery || '').trim().slice(0, 120);
    if (!query) return { query, playlists: [], sources: {} };

    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

    const spotifyOn = !!deps.isSpotifyConnected();
    const jobs = {
      youtube: searchYouTube(query),
      soundcloud: searchSoundCloud(query),
      spotify: spotifyOn ? searchSpotify(query) : null
    };
    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(names.map((n) => (jobs[n] ? withTimeout(jobs[n], SOURCE_TIMEOUT_MS, n) : Promise.resolve(null))));

    const tokens = moodTokens(query);
    const sources = {};
    const ranked = [];
    settled.forEach((s, i) => {
      const name = names[i];
      if (name === 'spotify' && !spotifyOn) {
        sources[name] = 'not-connected';
        return;
      }
      if (s.status === 'rejected') {
        sources[name] = 'error';
        return;
      }
      const list = rankSource(s.value || [], tokens);
      sources[name] = list.length ? 'ok' : 'empty';
      ranked.push(list);
    });

    const playlists = interleave(ranked, RESULT_LIMIT)
      .map(({ score, relevance: _r, ...p }) => p);
    const result = { query, playlists, sources };

    // Only cache answers where every reachable source responded.
    if (!Object.values(sources).includes('error')) {
      cache.set(key, { at: Date.now(), result });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return result;
  };
}

module.exports = {
  createSoulSearch,
  moodTokens,
  relevance,
  parseCount,
  formatCount,
  parseYtmCommunityPlaylists,
  parseSoundCloudPlaylists,
  parseSpotifyPlaylists,
  rankSource,
  interleave
};
