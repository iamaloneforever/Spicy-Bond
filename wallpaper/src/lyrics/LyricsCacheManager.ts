interface SongMeta { songKey: string; title: string; artist: string }
interface UsageRow extends SongMeta { playCount: number; playTimes: number[]; lastPlayedAt: number }
interface CacheRow<T> extends SongMeta { key: string; value: T; expiresAt: number; savedAt: number; hasLyrics: boolean }
export interface LyricCacheItem extends SongMeta {
  playCount: number;
  playsLast30Days: number;
  retentionDays: number;
  expiresAt: number;
  cachedVariants: number;
}

/** Persistent lyric cache plus per-song play history for adaptive retention. */
export class LyricsCacheManager<T> {
  private readonly memory = new Map<string, CacheRow<T>>();
  private readonly memoryUsage = new Map<string, UsageRow>();
  private readonly pending = new Map<string, { promise: Promise<T>; controller: AbortController; waiters: number; songKey: string }>();
  private epoch = 0;
  private database: Promise<IDBDatabase | null> | null = null;
  private readonly maxEntries = 250;
  private readonly missTtlMs = 15 * 60 * 1000;

  async getOrLoad(key: string, load: (signal: AbortSignal) => Promise<T>, cacheable: (value: T) => boolean, signal: AbortSignal | undefined, song: SongMeta): Promise<T> {
    signal?.throwIfAborted();
    const requestedEpoch = this.epoch;
    const cached = await this.get(key);
    signal?.throwIfAborted();
    if (requestedEpoch !== this.epoch) throw new DOMException('Cache cleared', 'AbortError');
    if (cached !== undefined) return cached;

    let task = this.pending.get(key);
    if (!task) {
      const controller = new AbortController();
      const epoch = this.epoch;
      const promise = load(controller.signal).then(async value => {
        if (epoch === this.epoch && !controller.signal.aborted && cacheable(value)) await this.put(key, value, song);
        return value;
      }).finally(() => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key); });
      task = { promise, controller, waiters: 0, songKey: song.songKey };
      this.pending.set(key, task);
    }
    task.waiters++;
    return this.waitFor(task, signal);
  }

  async recordPlay(song: SongMeta, at = Date.now()): Promise<void> {
    const previous = this.memoryUsage.get(song.songKey);
    const usage: UsageRow = {
      ...song,
      playCount: (previous?.playCount ?? 0) + 1,
      playTimes: [...(previous?.playTimes ?? []), at].filter(time => time >= at - 30 * 24 * 60 * 60 * 1000).slice(-1000),
      lastPlayedAt: at,
    };
    this.memoryUsage.set(song.songKey, usage);
    const db = await this.open();
    if (!db) { this.refreshMemoryRetention(usage); return; }
    await new Promise<void>(resolve => {
      try {
        const transaction = db.transaction(['entries', 'usage'], 'readwrite');
        const usageStore = transaction.objectStore('usage');
        const read = usageStore.get(song.songKey);
        read.onsuccess = () => {
          const stored = read.result as UsageRow | undefined;
          const allTimes = [...(stored?.playTimes ?? []), at].filter(time => time >= at - 30 * 24 * 60 * 60 * 1000).slice(-1000);
          const current: UsageRow = { ...song, playCount: (stored?.playCount ?? 0) + 1, playTimes: allTimes, lastPlayedAt: at };
          this.memoryUsage.set(song.songKey, current);
          usageStore.put(current);
          const entries = transaction.objectStore('entries'), rows = entries.getAll();
          rows.onsuccess = () => {
            for (const row of rows.result as CacheRow<T>[]) {
              if (row.songKey !== song.songKey || !row.hasLyrics) continue;
              row.title = song.title; row.artist = song.artist; row.expiresAt = at + this.retentionDays(current) * 24 * 60 * 60 * 1000;
              entries.put(row); this.memory.set(row.key, row);
            }
          };
        };
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      } catch { resolve(); }
    });
  }

  async list(): Promise<LyricCacheItem[]> {
    const db = await this.open();
    let rows: CacheRow<T>[] = [...this.memory.values()];
    let usages = new Map(this.memoryUsage);
    if (db) {
      const snapshot = await new Promise<{ entries: CacheRow<T>[]; usage: UsageRow[] }>(resolve => {
        try {
          const transaction = db.transaction(['entries', 'usage'], 'readonly');
          const entries = transaction.objectStore('entries').getAll();
          const usage = transaction.objectStore('usage').getAll();
          transaction.oncomplete = () => resolve({ entries: entries.result as CacheRow<T>[], usage: usage.result as UsageRow[] });
          transaction.onerror = transaction.onabort = () => resolve({ entries: [], usage: [] });
        } catch { resolve({ entries: [], usage: [] }); }
      });
      rows = snapshot.entries; usages = new Map(snapshot.usage.map(row => [row.songKey, row]));
    }
    const grouped = new Map<string, { row: CacheRow<T>; variants: number }>();
    for (const row of rows) {
      if (!row.hasLyrics || row.expiresAt <= Date.now()) continue;
      const current = grouped.get(row.songKey);
      if (current) { current.variants++; current.row.expiresAt = Math.max(current.row.expiresAt, row.expiresAt); }
      else grouped.set(row.songKey, { row, variants: 1 });
    }
    return [...grouped.values()].map(({ row, variants }) => {
      const usage = usages.get(row.songKey);
      const recent = usage?.playTimes.filter(time => time >= Date.now() - 30 * 24 * 60 * 60 * 1000).length ?? 0;
      return { songKey: row.songKey, title: row.title, artist: row.artist, playCount: usage?.playCount ?? 0, playsLast30Days: recent,
        retentionDays: this.retentionDays(usage), expiresAt: row.expiresAt, cachedVariants: variants };
    }).sort((a, b) => b.playCount - a.playCount || b.expiresAt - a.expiresAt);
  }

  async removeSong(songKey: string): Promise<void> {
    for (const [key, task] of this.pending) if (task.songKey === songKey) { task.controller.abort(); this.pending.delete(key); }
    this.memoryUsage.delete(songKey);
    for (const [key, row] of this.memory) if (row.songKey === songKey) this.memory.delete(key);
    const db = await this.open();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const transaction = db.transaction(['entries', 'usage'], 'readwrite');
        const entries = transaction.objectStore('entries'), request = entries.getAll();
        request.onsuccess = () => { for (const row of request.result as CacheRow<T>[]) if (row.songKey === songKey) entries.delete(row.key); };
        transaction.objectStore('usage').delete(songKey);
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      } catch { resolve(); }
    });
  }

  async clear(): Promise<void> {
    this.epoch++;
    this.memory.clear(); this.memoryUsage.clear();
    for (const task of this.pending.values()) task.controller.abort();
    this.pending.clear();
    const db = await this.open();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const transaction = db.transaction(['entries', 'usage'], 'readwrite');
        transaction.objectStore('entries').clear(); transaction.objectStore('usage').clear();
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      } catch { resolve(); }
    });
  }

  private retentionDays(usage?: UsageRow): number {
    if (!usage?.playCount) return 3;
    const now = Date.now();
    const recent = usage.playTimes.filter(time => time >= now - 30 * 24 * 60 * 60 * 1000).length;
    const daysSincePlay = Math.max(0, (now - usage.lastPlayedAt) / 86400000);
    const popularityDays = 3 + Math.log2(usage.playCount + 1) * 4 + Math.min(30, recent * 1.5);
    const recencyFactor = 30 / (30 + daysSincePlay);
    return Math.max(1, Math.min(90, Math.round(popularityDays * recencyFactor)));
  }

  private refreshMemoryRetention(usage: UsageRow): void {
    for (const row of this.memory.values()) if (row.songKey === usage.songKey && row.hasLyrics) row.expiresAt = Date.now() + this.retentionDays(usage) * 86400000;
  }

  private waitFor(task: { promise: Promise<T>; controller: AbortController; waiters: number; songKey: string }, signal?: AbortSignal): Promise<T> {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; task.waiters--; } };
    if (!signal) return task.promise.finally(finish);
    if (signal.aborted) { finish(); if (!task.waiters) task.controller.abort(); return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }
    return new Promise<T>((resolve, reject) => {
      const abort = () => { finish(); if (!task.waiters) task.controller.abort(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      task.promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); }).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private async get(key: string): Promise<T | undefined> {
    const now = Date.now(), cached = this.memory.get(key);
    if (cached) { if (cached.expiresAt > now) return cached.value; this.memory.delete(key); }
    const db = await this.open();
    if (!db) return undefined;
    const row = await new Promise<CacheRow<T> | undefined>(resolve => {
      try { const request = db.transaction('entries', 'readonly').objectStore('entries').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(undefined); }
      catch { resolve(undefined); }
    });
    if (!row) return undefined;
    if (row.expiresAt <= now) { this.remove(key); return undefined; }
    this.memory.set(key, row);
    return row.value;
  }

  private async put(key: string, value: T, song: SongMeta): Promise<void> {
    const hasLyrics = !!(value && typeof value === 'object' && 'lyrics' in value && (value as { lyrics?: unknown }).lyrics);
    const usage = this.memoryUsage.get(song.songKey);
    const db = await this.open();
    let savedUsage = usage;
    if (db) savedUsage = await new Promise<UsageRow | undefined>(resolve => {
      try { const request = db.transaction('usage', 'readonly').objectStore('usage').get(song.songKey); request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(undefined); }
      catch { resolve(undefined); }
    });
    const row: CacheRow<T> = { key, value, ...song, hasLyrics, savedAt: Date.now(), expiresAt: Date.now() + (hasLyrics ? this.retentionDays(savedUsage) * 86400000 : this.missTtlMs) };
    this.memory.set(key, row);
    while (this.memory.size > this.maxEntries) this.memory.delete(this.memory.keys().next().value!);
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const store = db.transaction('entries', 'readwrite').objectStore('entries'), request = store.put(row);
        request.onsuccess = request.onerror = () => resolve();
      } catch { resolve(); }
    });
    this.prune(db);
  }

  private remove(key: string): void {
    this.memory.delete(key);
    void this.open().then(db => { if (db) try { db.transaction('entries', 'readwrite').objectStore('entries').delete(key); } catch { /* Storage may be unavailable. */ } });
  }

  private prune(db: IDBDatabase): void {
    try {
      const store = db.transaction('entries', 'readwrite').objectStore('entries'), request = store.getAll();
      request.onsuccess = () => {
        const rows = (request.result as CacheRow<T>[]).sort((a, b) => b.savedAt - a.savedAt);
        rows.forEach((row, index) => { if (row.expiresAt <= Date.now() || index >= this.maxEntries) store.delete(row.key); });
      };
    } catch { /* In-memory cache remains available. */ }
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.database) return this.database;
    this.database = new Promise(resolve => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      try {
        const request = indexedDB.open('spicy-bond-lyrics', 2);
        request.onupgradeneeded = event => {
          const db = request.result;
          if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('usage')) db.createObjectStore('usage', { keyPath: 'songKey' });
          if (event.oldVersion < 2) {
            const cursor = request.transaction!.objectStore('entries').openCursor();
            cursor.onsuccess = () => {
              const current = cursor.result;
              if (!current) return;
              const row = current.value as Partial<CacheRow<T>>;
              try {
                const key = JSON.parse(row.key || '[]') as unknown[];
                const title = (key[0] === 'lookup' ? String(key[1] ?? '') : key[0] === 'selected-lrclib' ? String(key[2] ?? '') : '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
                const artist = (key[0] === 'lookup' ? String(key[2] ?? '') : key[0] === 'selected-lrclib' ? String(key[3] ?? '') : '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
                if (title && artist && row.key && row.value !== undefined) {
                  const value = row.value as T & { lyrics?: unknown };
                  current.update({ ...row, title, artist, songKey: JSON.stringify([title, artist]), hasLyrics: !!value.lyrics } as CacheRow<T>);
                } else current.delete();
              } catch { current.delete(); }
              current.continue();
            };
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.database;
  }
}
