import type { SongCandidate } from '../music/SongSearch';
import { parseLyrics, type Lyrics, type LyricLine, type Playback } from './Lyrics';
import { LyricsCacheManager, type LyricCacheItem } from './LyricsCacheManager';

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function parseLrclib(raw: unknown, playback: Playback): Lyrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.trackName !== 'string' || typeof data.artistName !== 'string' ||
      normalize(data.trackName) !== normalize(playback.title) || normalize(data.artistName) !== normalize(playback.artist) ||
      typeof data.duration !== 'number' || !Number.isFinite(data.duration) || Math.abs(data.duration - playback.duration) > 2 || data.instrumental === true) return null;
  const lines: LyricLine[] = [];
  if (typeof data.syncedLyrics === 'string' && data.syncedLyrics.length <= 100000) {
    const offset = Number(data.syncedLyrics.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
    for (const row of data.syncedLyrics.split(/\r?\n/).slice(0, 2000)) {
      const tags = Array.from(row.matchAll(/\[(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?\]/g));
      const text = row.replace(/\[[^\]]*\]/g, '').trim().slice(0, 4000);
      for (const tag of tags) {
        const start = Math.max(0, Number(tag[1]) * 60 + Number(tag[2]) + Number(`0.${tag[3] || '0'}`) - offset);
        if (start <= playback.duration) lines.push({ text, start, end: playback.duration, words: [] });
      }
    }
    lines.sort((a, b) => a.start - b.start);
    lines.forEach((line, i) => { line.end = lines[i + 1]?.start ?? Math.max(line.start + .1, playback.duration); });
    if (lines.some(line => line.text)) return { lines, timed: true, source: 'lrclib', credits: [] };
  }
  if (typeof data.plainLyrics === 'string' && data.plainLyrics.length <= 100000) {
    const plain = data.plainLyrics.split(/\r?\n/).map(text => text.trim()).filter(Boolean).slice(0, 2000);
    if (plain.length) return { lines: plain.map((text, i) => ({ text: text.slice(0, 4000), start: i, end: i + 1, words: [] })), timed: false, source: 'lrclib', credits: [] };
  }
  return null;
}

export interface LookupResult { lyrics: Lyrics | null; detail: string; retryMs?: number }
export const lyricsCache = new LyricsCacheManager<LookupResult>();
const cachePart = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const songMeta = (playback: Playback) => ({ songKey: JSON.stringify([normalize(playback.title), normalize(playback.artist)]), title: playback.title, artist: playback.artist });
const cacheableLookup = (result: LookupResult) => !!result.lyrics || result.retryMs === undefined && (result.detail.includes('No lyrics') || result.detail.includes('No matching lyrics') || result.detail.includes('ambiguous'));
const lookupKey = (playback: Playback, album: string, key: string, allowPublic: boolean) => JSON.stringify([
  'lookup', cachePart(playback.title), cachePart(playback.artist), Math.round(playback.duration), playback.trackId,
  cachePart(album), !!key, allowPublic,
]);
async function lookupPublicLyrics(playback: Playback, album: string, signal: AbortSignal): Promise<LookupResult> {
  const query = new URLSearchParams({ track_name: playback.title, artist_name: playback.artist, duration: String(playback.duration) });
  if (album) query.set('album_name', album);
  const response = await fetch(`https://lrclib.net/api/get?${query}`, { signal });
  if (response.status === 404) {
    const search = new URLSearchParams({ track_name: playback.title, artist_name: playback.artist });
    const fallback = await fetch(`https://lrclib.net/api/search?${search}`, { signal });
    if (!fallback.ok) return { lyrics: null, detail: fallback.status === 404 ? 'No lyrics for this song.' : `LRCLIB search returned ${fallback.status}.`, retryMs: fallback.status === 429 ? 60000 : undefined };
    const rows: unknown = await fallback.json();
    const matches = Array.isArray(rows) ? rows.slice(0, 100).map(row => parseLrclib(row, playback)).filter((lyrics): lyrics is Lyrics => lyrics !== null) : [];
    return matches.length === 1 ? { lyrics: matches[0], detail: 'LRCLIB' } : { lyrics: null, detail: (matches.length > 1 ? 'LRCLIB match is ambiguous.' : 'No lyrics for this song.') };
  }
  if (!response.ok) return { lyrics: null, detail: `LRCLIB returned ${response.status}.`, retryMs: response.status === 429 ? 60000 : undefined };
  const lyrics = parseLrclib(await response.json(), playback);
  return { lyrics, detail: lyrics ? 'LRCLIB' : 'No matching lyrics for this recording.' };
}
async function lookupSpicyLyrics(playback: Playback, key: string, signal: AbortSignal): Promise<LookupResult> {
  const response = await fetch(`https://api.spicylyrics.org/v1/lyrics/${playback.trackId}`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
  });
  if (response.ok) { const lyrics = parseLyrics(await response.json()); return { lyrics, detail: lyrics ? 'Spicy Lyrics' : 'No lyrics for this song.' }; }
  return { lyrics: null, detail: response.status === 404 ? 'No lyrics for this song.' : `Spicy Lyrics returned ${response.status}. Check the key and allowed origin.`,
    retryMs: response.status === 429 ? Math.max(30, Number(response.headers.get('Retry-After')) || 60) * 1000 : undefined };
}
async function lookupLyricsUncached(playback: Playback, album: string, key: string, signal: AbortSignal, allowPublic: boolean): Promise<LookupResult> {
  const operations: { name: string; run: () => Promise<LookupResult> }[] = [];
  if (key && playback.trackId) operations.push({ name: 'Spicy Lyrics', run: () => lookupSpicyLyrics(playback, key, signal) });
  if (allowPublic) operations.push({ name: 'LRCLIB', run: () => lookupPublicLyrics(playback, album, AbortSignal.any([signal, AbortSignal.timeout(12000)])) });
  if (!operations.length) return { lyrics: null, detail: playback.trackId ? 'No lyrics for this song.' : 'No Spicy track ID. Enable LRCLIB fallback in settings for a public title-based lookup.' };
  const results = await Promise.all(operations.map(async operation => {
    try { return await operation.run(); }
    catch (error) { if (signal.aborted) throw error; return { lyrics: null, detail: `${operation.name} unavailable.`, retryMs: 10000 } satisfies LookupResult; }
  }));
  signal.throwIfAborted();
  // Search every enabled lyrics source. Prefer a timed recording over static text.
  const found = results.filter(result => result.lyrics).sort((a, b) => Number(b.lyrics!.timed) - Number(a.lyrics!.timed));
  if (found.length) return found[0];
  const retries = results.map(result => result.retryMs || 0);
  return { lyrics: null, detail: [...new Set(results.map(result => result.detail))].join(' '), retryMs: Math.max(...retries) || undefined };
}

export function lookupLyrics(playback: Playback, album: string, key: string, signal: AbortSignal, allowPublic: boolean): Promise<LookupResult> {
  if (!key && !allowPublic) return lookupLyricsUncached(playback, album, key, signal, allowPublic);
  return lyricsCache.getOrLoad(lookupKey(playback, album, key, allowPublic), sharedSignal =>
    lookupLyricsUncached(playback, album, key, sharedSignal, allowPublic), cacheableLookup, signal, songMeta(playback));
}

/** User selection explicitly corrects the lookup identity; playback still uses the native clock. */
export async function lookupSelectedLyrics(playback: Playback, candidate: SongCandidate, key: string, signal: AbortSignal, allowPublic: boolean): Promise<LookupResult> {
  const recording = { ...playback, title: candidate.title, artist: candidate.artist, trackId: candidate.spotifyId, duration: candidate.duration || playback.duration };
  if (candidate.lrcId) {
    if (!allowPublic) return { lyrics: null, detail: 'Enable LRCLIB fallback in settings to load these lyrics.' };
    const cacheKey = JSON.stringify(['selected-lrclib', candidate.lrcId, cachePart(recording.title), cachePart(recording.artist), Math.round(recording.duration)]);
    return lyricsCache.getOrLoad(cacheKey, async sharedSignal => {
      const response = await fetch(`https://lrclib.net/api/get/${candidate.lrcId}`, { signal: sharedSignal });
      if (!response.ok) return { lyrics: null, detail: response.status === 404 ? 'No lyrics for this recording.' : `LRCLIB returned ${response.status}.`, retryMs: response.status === 429 ? 60000 : undefined };
      const data: unknown = await response.json();
      const lyrics = data && typeof data === 'object' && (data as Record<string, unknown>).id === candidate.lrcId ? parseLrclib(data, recording) : null;
      return { lyrics, detail: lyrics ? 'LRCLIB' : 'No matching lyrics for this recording.' };
    }, cacheableLookup, signal, songMeta(recording));
  }
  return lookupLyrics(recording, candidate.album, key, signal, allowPublic);
}

export type { LyricCacheItem };
