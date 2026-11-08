import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupLyrics, parseLrclib, lyricsCache } from '../../src/lyrics/PublicLyrics';
import { parsePlayback } from '../../src/lyrics/Lyrics';
const playback = parsePlayback({ title: 'Test song', artist: 'Test artist', trackId: '', duration: 90, position: 1 })!;
const base = { trackName: 'Test song', artistName: 'Test artist', duration: 90 };
afterEach(async () => { vi.unstubAllGlobals(); await lyricsCache.clear(); });
describe('documented public lyrics', () => {
  it('accepts a reliable playback clock without a Spotify ID', () => {
    expect(playback.trackId).toBe('');
    expect(playback.duration).toBe(90);
  });
  it('parses repeated LRC timestamps and fractional seconds without inventing words', () => {
    const result = parseLrclib({ ...base, syncedLyrics: '[00:01.25][00:09.500]Repeated\n[00:05]Middle' }, playback)!;
    expect(result.lines.map(line => line.start)).toEqual([1.25, 5, 9.5]);
    expect(result.lines[0].end).toBe(5);
    expect(result.lines.every(line => line.words.length === 0)).toBe(true);
  });
  it('rejects a different recording, duration and instrumental', () => {
    for (const patch of [{ trackName: 'Test song live' }, { artistName: 'Other' }, { duration: 100 }, { instrumental: true }]) {
      expect(parseLrclib({ ...base, ...patch, syncedLyrics: '[00:01]Wrong' }, playback)).toBeNull();
    }
  });
  it('keeps plain lyrics untimed and rejects malformed timestamps', () => {
    expect(parseLrclib({ ...base, plainLyrics: 'Plain phrase' }, playback)?.timed).toBe(false);
    expect(parseLrclib({ ...base, syncedLyrics: '[00:99]Bad' }, playback)).toBeNull();
  });
  it('uses LRCLIB even when Spotify authentication fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...base, syncedLyrics: '[00:01]Fallback' })));
    vi.stubGlobal('fetch', fetcher);
    const result = await lookupLyrics({ ...playback, trackId: 'a'.repeat(22) }, '', 'sl_pk_test', new AbortController().signal, true);
    expect(result.lyrics?.source).toBe('lrclib'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects ambiguous search fallback', async () => {
    const row = { ...base, plainLyrics: 'Possible recording' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 })).mockResolvedValueOnce(new Response(JSON.stringify([row, row]))));
    const result = await lookupLyrics(playback, '', '', new AbortController().signal, true);
    expect(result.lyrics).toBeNull(); expect(result.detail).toContain('ambiguous');
  });
  it('sends no public request without consent', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await lookupLyrics(playback, '', '', new AbortController().signal, false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('checks every enabled lyrics source and prefers synced lyrics to static text', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return url.includes('spicylyrics') ? new Response(JSON.stringify({ Body: { Type: 'Static', Lines: [{ Text: 'Plain Spicy' }] } })) : new Response(JSON.stringify({ ...base, syncedLyrics: '[00:01]Synced public phrase' }));
  }));
  const result = await lookupLyrics({ ...playback, trackId: 'a'.repeat(22) }, '', 'sl_pk_test', new AbortController().signal, true);
  expect(calls.some(url => url.includes('spicylyrics'))).toBe(true); expect(calls.some(url => url.includes('lrclib.net'))).toBe(true);
  expect(result.detail).toBe('LRCLIB'); expect(result.lyrics?.timed).toBe(true);
});
