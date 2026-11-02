'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
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
} = require('../src/server/soul-search');

test('mood words are stemmed and filler words dropped', () => {
  assert.deepStrictEqual(moodTokens('late night drives'), ['lat', 'night', 'driv']);
  assert.deepStrictEqual(moodTokens('studying music'), ['study']);
  assert.deepStrictEqual(moodTokens('league of legends l9'), ['leagu', 'legend', 'l9']);
});

test('relevance matches word forms and ignores unrelated titles', () => {
  const tokens = moodTokens('late night drives');
  assert.strictEqual(relevance('Late Night Drive Playlist', tokens), 1);
  assert.strictEqual(relevance('late night driving songs', tokens), 1);
  assert.strictEqual(relevance('Summer Chill Mix 2026', tokens), 0);
});

test('view and like counts parse and format', () => {
  assert.strictEqual(parseCount('819K views'), 819000);
  assert.strictEqual(parseCount('1.2M views'), 1200000);
  assert.strictEqual(parseCount('27 views'), 27);
  assert.strictEqual(formatCount(819000), '819K');
  assert.strictEqual(formatCount(1582), '1.6K');
  assert.strictEqual(formatCount(12000000), '12M');
});

test('parses YouTube Music community playlist results', () => {
  const json = {
    contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{
      musicShelfRenderer: { contents: [{
        musicResponsiveListItemRenderer: {
          navigationEndpoint: { browseEndpoint: { browseId: 'VLPLabc' } },
          flexColumns: [
            { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Late night drive playlist' }] } } },
            { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Kostya' }, { text: ' • ' }, { text: '819K views' }] } } }
          ],
          thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'small', width: 60 }, { url: 'big', width: 1200 }] } } }
        }
      }] }
    }] } } } }] } }
  };
  assert.deepStrictEqual(parseYtmCommunityPlaylists(json), [{
    source: 'youtube',
    id: 'PLabc',
    title: 'Late night drive playlist',
    owner: 'Kostya',
    url: 'https://www.youtube.com/playlist?list=PLabc',
    cover: 'big',
    trackCount: null,
    popularity: 819000,
    popularityLabel: '819K views'
  }]);
});

test('SoundCloud albums are skipped and missing artwork falls back', () => {
  const list = parseSoundCloudPlaylists({ collection: [
    { id: 1, title: 'Late Night Drives', permalink_url: 'https://soundcloud.com/a/sets/b', likes_count: 1582, reposts_count: 24, track_count: 84, user: { username: 'Dwayne', avatar_url: 'https://i1.sndcdn.com/avatars-x-large.jpg' } },
    { id: 2, title: 'An Album', permalink_url: 'https://soundcloud.com/a/sets/c', is_album: true }
  ] });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].cover, 'https://i1.sndcdn.com/avatars-x-t500x500.jpg');
  assert.strictEqual(list[0].popularityLabel, '1.6K likes');
});

test('Spotify editorial playlists and empty slots are dropped', () => {
  const list = parseSpotifyPlaylists({ playlists: { items: [
    null,
    { id: 'ed', name: 'Night Drive', owner: { id: 'spotify' } },
    { id: 'cm', name: 'night drive', owner: { id: 'someone', display_name: 'Someone' }, tracks: { total: 50 }, images: [{ url: 'img' }], external_urls: { spotify: 'https://open.spotify.com/playlist/cm' } }
  ] } });
  assert.deepStrictEqual(list.map((p) => p.id), ['cm']);
});

test('ranking puts real matches first, by popularity, and drops unrelated playlists', () => {
  const tokens = moodTokens('late night drives');
  const ranked = rankSource([
    { id: 'popular-unrelated', title: 'Summer Chill Mix', popularity: 5e6 },
    { id: 'small-match', title: 'late night drives', popularity: 24 },
    { id: 'big-match', title: 'Late night drive playlist', popularity: 819000 },
    { id: 'partial-match', title: 'Night songs', popularity: 1e6 }
  ], tokens);
  // Only two real matches, so the partial one fills in behind them even though it is more popular.
  assert.deepStrictEqual(ranked.map((p) => p.id), ['big-match', 'small-match', 'partial-match']);
});

test('partial matches are dropped once there are enough real matches', () => {
  const tokens = moodTokens('studying');
  const ranked = rankSource([
    { id: 'a', title: 'Studying lofi', popularity: 10 },
    { id: 'b', title: 'study beats', popularity: 20 },
    { id: 'c', title: 'Music for studying', popularity: 30 },
    { id: 'd', title: 'Gym hype', popularity: 9e9 }
  ], tokens);
  assert.deepStrictEqual(ranked.map((p) => p.id), ['c', 'b', 'a']);
});

test('results alternate between sources without duplicates', () => {
  const yt = [{ source: 'youtube', id: '1' }, { source: 'youtube', id: '2' }];
  const sc = [{ source: 'soundcloud', id: '9' }];
  assert.deepStrictEqual(interleave([yt, sc], 10).map((p) => `${p.source}:${p.id}`), ['youtube:1', 'soundcloud:9', 'youtube:2']);
});

test('a failing source does not sink the others, and Spotify is skipped when not connected', async () => {
  const search = createSoulSearch({
    ytmSearch: async () => { throw new Error('offline'); },
    soundCloudClientId: async () => 'cid',
    isSpotifyConnected: () => false,
    spotifyGet: async () => { throw new Error('should not be called'); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ collection: [
      { id: 7, title: 'studying lofi', permalink_url: 'https://soundcloud.com/x/sets/y', likes_count: 10 }
    ] }) })
  });
  const result = await search('studying');
  assert.deepStrictEqual(result.sources, { youtube: 'error', soundcloud: 'ok', spotify: 'not-connected' });
  assert.deepStrictEqual(result.playlists.map((p) => p.id), ['7']);
});
