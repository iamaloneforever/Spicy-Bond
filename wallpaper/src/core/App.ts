import { matchSongAccent } from '../background/SongAccents';
import { GenreResolver } from '../background/GenreResolver';
import { themes } from '../background/Themes';
import { performancePresets } from '../background/Performance';
import { AudioEngine } from '../audio/AudioEngine';
import { MusicStore } from '../music/MusicStore';
import { LivelyBridge } from '../lively/LivelyBridge';
import { ScreenPainter } from '../ui/ScreenPainter';
import { SceneManager } from '../graphics/SceneManager';
import { demoArtwork, demoSpectrum, demoTracks } from '../ui/Demo';
import { SettingsInteraction } from '../ui/SettingsInteraction';
import { settingsMarkup } from '../ui/Settings';
import { defaults, loadConfig, nextMode, saveConfig } from './Config';
import { LyricsController } from '../lyrics/LyricsController';
import { lyricsCache } from '../lyrics/PublicLyrics';
import { SongPicker } from '../ui/SongPicker';
import { SettingsSync } from './SettingsSync';
import { CustomEffectControls } from '../ui/CustomEffectControls';
import { brand } from './Brand';

export class App {
  private config = loadConfig();
  private genre = new GenreResolver();
  private backgroundStatus = '';
  private audio = new AudioEngine();
  private store = new MusicStore();
  private bridge = new LivelyBridge(this.store, this.audio);
  private painter = new ScreenPainter();
  private scene: SceneManager | null = null;
  private powered = true;
  private demo = false;
  private demoIndex = 0;
  private demoBass = 1;
  private demoTreble = 1;
  private nextTrackTime = 0;
  private demoStarted = 0;
  private frame = 0;
  private lastFrame = 0;
  private lastPaint = 0;
  private demoTimer = 0;
  private backgroundPalette = '';
  private lyrics: LyricsController;
  private songPicker: SongPicker;
  private settingsSync: SettingsSync | null = null;
  private customEffects: CustomEffectControls;
  private lyricsKey = '';
  private unsubscribe: () => void;
  private disposers: (() => void)[] = [];
  private query<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  constructor(private root: HTMLElement) {
    root.innerHTML = `<main><div id="lyrics" class="lyrics-layer" aria-label="Song lyrics"></div><div id="scene" class="scene"><div class="tv-viewport" aria-hidden="true"></div></div>
      <div class="controls"><button id="channel-button" class="control-button" aria-label="Switch display channel"><span class="button-symbol" aria-hidden="true">⇄</span><span>Channel</span><span id="channel-number">01</span></button><button id="find-song" class="control-button" disabled>Find song</button></div><a class="source-licenses" href="${import.meta.env.BASE_URL}licenses/" target="_blank" rel="noopener noreferrer">Source and licenses</a>
      <span class="accessible-track" id="signal" aria-live="polite">WAITING FOR LIVELY</span>
      <div class="accessible-track" aria-live="polite" id="accessible-track">Waiting for media</div></main>
      <aside class="settings" id="settings" role="dialog" aria-modal="true" aria-labelledby="settings-heading" hidden>${settingsMarkup(this.config)}</aside>`;
    root.dataset.powered = 'true'; root.dataset.source = 'waiting';
    this.lyrics = new LyricsController(root, this.query('#lyrics'));
    this.songPicker = new SongPicker(root, candidate => this.lyrics.selectSong(candidate));
    this.lyrics.onContext = (identity, playback, enabled, allowPublic, hasLyrics) => this.songPicker.setContext(identity, playback, enabled, allowPublic, hasLyrics);
    this.lyrics.onMissingLyrics = () => this.songPicker.missingLyrics();
    let lyricsKey: string = brand.lyricsKey; try { lyricsKey = localStorage.getItem('spicy-bond-spicy-key') ?? brand.lyricsKey; } catch { /* Restricted storage. */ }
    this.query<HTMLInputElement>('#spicy-key').value = lyricsKey;
    this.lyricsKey = lyricsKey; this.lyrics.configure(lyricsKey);
    this.query('h2').id = 'settings-heading';
    this.unsubscribe = this.store.subscribe((track, changed) => {
      this.genre.setTrack(track);
      if (this.scene) this.scene.songAccent = matchSongAccent(track);
      this.customEffects?.trackChanged();
      this.painter.setTrack(track, changed, this.demo && track ? demoArtwork(this.demoIndex) : undefined);
      this.query('#accessible-track').textContent = track ? `${this.demo ? 'Demo: ' : ''}${track.title} — ${track.artist || track.albumArtist}` : 'Standby — waiting for media';
    });
    this.bridge.onConnection = () => {
      clearTimeout(this.demoTimer);
      if (this.demo) { this.demo = false; this.painter.demo = false; this.store.update(null); }
      this.updateSignal();
    };
    try {
      this.scene = new SceneManager(this.query('#scene'), this.painter);
      this.scene.onAction = action => {
        if (action === 'power') this.togglePower();
        if (action === 'channel') this.changeChannel();
        if (action === 'intensity') { this.config.intensity = this.config.intensity >= 1.4 ? 0.3 : this.config.intensity + 0.15; this.applyConfig(); }
        if (action === 'brightness') { this.config.brightness = this.config.brightness >= 1.4 ? 0.5 : this.config.brightness + 0.15; this.applyConfig(); }
      };
    } catch {
      this.query('#scene').innerHTML = `<div class="fallback"><span class="eyebrow">THE SIGNAL NEEDS WEBGL 2</span><h2>A moment of quiet.</h2><p>Your browser or graphics driver could not create the 3D scene.<br>Enable hardware acceleration and reopen this page.</p><canvas id="fallback-screen" width="1024" height="768" aria-label="Fallback music display"></canvas></div>`;
    }
    this.customEffects = new CustomEffectControls(this.root, () => this.store.track, effects => {
      if (!this.scene) throw new Error('Custom effects require WebGL 2. Enable hardware acceleration and reopen the wallpaper.');
      this.scene.customEffects.validate(this.scene.renderer, effects);
    }, (effect, restart) => { if (this.scene) { this.scene.customEffect = effect; if (restart) this.scene.customEffects.restart(); } }, () => this.saveSettings());
    this.bindUI();
    const interaction = new SettingsInteraction(this.query('#settings')); this.disposers.push(() => interaction.dispose());
    this.applyConfig();
    this.settingsSync = new SettingsSync({ version: 1, config: this.config, lyricsKey: this.lyricsKey, customEffects: this.customEffects.snapshot() }, settings => {
      if (settings.customEffects) this.customEffects.restore(settings.customEffects);
      this.config = settings.config;
      if (this.lyricsKey !== settings.lyricsKey) {
        this.lyricsKey = settings.lyricsKey; this.query<HTMLInputElement>('#spicy-key').value = this.lyricsKey;
        this.query('#spicy-key').removeAttribute('aria-invalid'); this.query('#lyrics-key-feedback').textContent = '';
        try { localStorage.setItem('spicy-bond-spicy-key', this.lyricsKey); } catch { /* The JSON file remains authoritative. */ }
        this.lyrics.configure(this.lyricsKey);
      }
      this.applyConfig(false);
    }, message => { this.query('#settings-sync-status').textContent = message; });
    if (new URLSearchParams(location.search).get('settings') === '1') this.openSettings(true);
    // Receiving a real callback is the only host detection signal. Defining functions proves nothing.
    const liveOnly = new URLSearchParams(location.search).get('live') === '1';
    if (!liveOnly) this.demoTimer = window.setTimeout(() => {
      if (!this.bridge.mediaReceived && !this.bridge.audioReceived) { this.demo = true; this.painter.demo = true; this.nextDemo(); this.updateSignal(); }
    }, 2500);
    else this.updateSignal();
    this.frame = requestAnimationFrame(this.animate);
    const cleanup = () => this.dispose(); window.addEventListener('pagehide', cleanup, { once: true }); this.disposers.push(() => window.removeEventListener('pagehide', cleanup));
  }
  private listen(element: HTMLElement, type: string, fn: EventListener): void { element.addEventListener(type, fn); this.disposers.push(() => element.removeEventListener(type, fn)); }
  private bindUI(): void {
    const panel = this.query('#settings');
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel', 'touchstart', 'touchmove']) {
      this.listen(panel, type, event => event.stopPropagation());
    }
    for (const slider of panel.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      const output = document.createElement('output'); output.value = slider.value; slider.before(output);
      this.listen(slider, 'input', () => { output.value = slider.value; });
    }
    this.listen(this.query('#save-lyrics-key'), 'click', () => {
      const input = this.query<HTMLInputElement>('#spicy-key');
      const key = input.value.trim();
      if (key.length > 256 || key && !/^sl_pk_[A-Za-z0-9_-]+$/.test(key)) {
        input.setAttribute('aria-invalid', 'true');
        this.query('#lyrics-key-feedback').textContent = 'Use a publishable sl_pk_ key. Secret keys cannot be used in this wallpaper.';
        return;
      }
      input.removeAttribute('aria-invalid'); this.query('#lyrics-key-feedback').textContent = '';
      try { localStorage.setItem('spicy-bond-spicy-key', key); } catch { /* Session-only key. */ }
      this.lyricsKey = key; this.lyrics.configure(key);
      this.settingsSync?.changed({ version: 1, config: this.config, lyricsKey: this.lyricsKey, customEffects: this.customEffects.snapshot() });
    });
    this.listen(this.query('#clear-lyrics-cache'), 'click', () => {
      void lyricsCache.clear().then(() => { this.query('#lyrics-cache-status').textContent = 'Saved lyric cache cleared from this device.'; return this.refreshLyricsCacheUI(); });
    });
    this.listen(this.query('#lyrics-cache-list'), 'click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-cache-song]');
      if (!button) return;
      void lyricsCache.removeSong(button.dataset.removeCacheSong!).then(() => {
        this.query('#lyrics-cache-status').textContent = 'Song removed from the lyric cache.';
        return this.refreshLyricsCacheUI();
      });
    });
    this.listen(this.query('#channel-button'), 'click', () => this.changeChannel());
    this.listen(this.query('#find-song'), 'click', () => this.songPicker.open());
    this.listen(this.query('#power-button'), 'click', () => this.togglePower());
    this.listen(this.query('#close-settings'), 'click', () => this.openSettings(false));
    this.listen(this.query('#next-track'), 'click', () => { if (this.demo) { this.demoIndex = (this.demoIndex + 1) % demoTracks.length; this.nextDemo(); } });
    this.listen(this.query('#demo-bass'), 'input', event => { this.demoBass = Number((event.target as HTMLInputElement).value); });
    this.listen(this.query('#demo-treble'), 'input', event => { this.demoTreble = Number((event.target as HTMLInputElement).value); });
    this.listen(this.query('#reset-settings'), 'click', () => { this.config = { ...defaults }; this.applyConfig(); });
    for (const element of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')) {
      const update = () => {
        const key = element.dataset.setting!;
        const value = element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : (element instanceof HTMLInputElement && element.type === 'range' || key === 'fps') ? Number(element.value) : element.value;
        Object.assign(this.config, { [key]: value }); this.applyConfig();
      };
      this.listen(element, 'input', update);
      this.listen(element, 'change', update);
    }
    const keydown = (event: KeyboardEvent) => {
      if (this.root.querySelector<HTMLDialogElement>('#song-picker')?.open) return;
      if (event.key === 'Escape') this.openSettings(false);
      if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.altKey && !event.metaKey && !(event.target as HTMLElement).closest('input,select,textarea,[contenteditable=true]')) this.openSettings(this.query('#settings').hidden);
      const panel = this.query('#settings');
      if (event.key === 'Tab' && !panel.hidden) {
        const items = panel.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex="0"]'); const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown); this.disposers.push(() => document.removeEventListener('keydown', keydown));
  }
  private updateSignal(): void {
    const label = this.demo ? 'BROWSER DEMO' : this.bridge.mediaReceived || this.bridge.audioReceived ? 'LIVELY CONNECTED' : 'WAITING FOR LIVELY';
    this.query('#signal').textContent = label;
    this.root.dataset.source = this.demo ? 'demo' : this.bridge.mediaReceived || this.bridge.audioReceived ? 'live' : 'waiting';
    this.query('#diagnostics').textContent = `Metadata: ${this.bridge.mediaReceived ? 'callback received' : 'not received'}. Audio: ${this.bridge.audioReceived ? 'callback received' : 'not received'}. ${this.demo ? 'Simulated preview active.' : this.bridge.audioReceived ? 'Live audio callback connected. Particle response follows Music reactivity sensitivity.' : 'Waiting for live audio; track metadata alone does not include sound.'}`;
    this.query<HTMLButtonElement>('#next-track').disabled = !this.demo;
  }
  private openSettings(open: boolean): void {
    this.query('#settings').hidden = !open;
    if (open) void this.refreshLyricsCacheUI();
    if (this.scene) this.scene.interactionEnabled = !open;
    this.query('main').inert = open;
    (open ? this.query('#close-settings') : this.query('#channel-button')).focus({ preventScroll: true });
  }
  private async refreshLyricsCacheUI(): Promise<void> {
    const container = this.query('#lyrics-cache-list');
    const items = await lyricsCache.list();
    container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p'); empty.className = 'lyric-cache-empty'; empty.textContent = 'No saved lyric entries yet.'; container.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'lyric-cache-item';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = item.title;
      const metadata = document.createElement('span');
      const remaining = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 86400000));
      metadata.textContent = `${item.artist} · ${item.playCount} plays (${item.playsLast30Days} in 30 days) · ${item.retentionDays}-day retention · expires in ${remaining} days`;
      details.append(title, metadata);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
      remove.dataset.removeCacheSong = item.songKey; remove.setAttribute('aria-label', `Remove ${item.title} from lyric cache`);
      row.append(details, remove); container.append(row);
    }
    this.query('#lyrics-cache-status').textContent = `${items.length} cached song${items.length === 1 ? '' : 's'} · retention adapts to recent listening.`;
  }
  private saveSettings(): void { this.settingsSync?.changed({ version: 1, config: this.config, lyricsKey: this.lyricsKey, customEffects: this.customEffects.snapshot() }); }
  private togglePower(): void { this.powered = !this.powered; this.root.dataset.powered = String(this.powered); this.query('#power-button').setAttribute('aria-pressed', String(this.powered)); this.applyConfig(); }
  private changeChannel(): void { this.config.mode = nextMode(this.config.mode); this.painter.transition = performance.now() / 1000; this.applyConfig(); }
  private applyConfig(persist = true): void {
    this.lyrics.setAppearance(this.config);
    const saved = saveConfig(this.config);
    if (persist) this.settingsSync?.changed({ version: 1, config: this.config, lyricsKey: this.lyricsKey, customEffects: this.customEffects.snapshot() });
    this.query('#settings-save-status').textContent = saved ? 'Settings saved automatically.' : 'Settings apply for this session. This host has blocked persistent storage.';
    this.scene?.tv.configure(this.config, this.powered);
    this.root.dataset.mode = this.config.mode;
    this.query('#channel-number').textContent = this.config.mode === 'broadcast' ? '01' : '02';
    for (const element of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')) {
      const value = this.config[element.dataset.setting as keyof typeof this.config];
      if (element instanceof HTMLInputElement && element.type === 'checkbox') element.checked = Boolean(value); else element.value = String(value);
      if (element instanceof HTMLInputElement && element.type === 'range') { const output = element.previousElementSibling; if (output instanceof HTMLOutputElement) output.value = element.value; }
    }
  }
  private nextDemo(): void { this.demoStarted = performance.now(); this.store.update(demoTracks[this.demoIndex]); this.nextTrackTime = this.demoStarted + 35000; }
  private animate = (now: number): void => {
    this.frame = requestAnimationFrame(this.animate);
    if (document.hidden || this.bridge.paused || this.scene?.contextLost) { this.lyrics.suspend(); this.lastFrame = now; return; }
    const interval = 1000 / Math.min(this.config.lowPower ? 30 : this.config.fps, performancePresets[this.config.performancePreset].fps);
    if (now - this.lastFrame < interval - 0.8) return;
    const dt = Math.min(0.1, (now - (this.lastFrame || now - interval)) / 1000); this.lastFrame = now;
    const time = now / 1000;
    const automatic = this.config.autoGenre && this.config.manualTheme === 'auto';
    this.genre.tick(now, this.demo ? null : this.store.track, automatic);
    const themeId = this.config.manualTheme !== 'auto' ? this.config.manualTheme : automatic && this.genre.detected || this.config.defaultTheme;
    const theme = themes.find(entry => entry.id === themeId)!;
    const status = `${theme.name} — ${this.config.manualTheme !== 'auto' ? 'Manual override' : automatic ? this.genre.source : 'Automatic detection off'}. ${theme.atmosphere}.`;
    if (status !== this.backgroundStatus) {
      this.backgroundStatus = status; this.root.dataset.theme = theme.id; this.query('#background-status').textContent = status;
    }
    if (this.scene) this.scene.theme = theme.id;
    if (this.demo) this.lyrics.tickDemo(now, this.demoIndex, this.demoStarted, this.config.lyrics && this.powered);
    else this.lyrics.tick(now, this.store.track, this.config.lyrics && this.powered, this.config.publicLyrics);
    if (this.scene) {
      this.scene.lyricsVisible = this.lyrics.visible;
      this.scene.effectPlaybackTime = this.customEffects.previewing ? null : this.demo ? Math.max(0, (now - this.demoStarted) / 1000) : this.lyrics.playbackTime(now);
    }
    if (this.demo && this.powered) {
      this.audio.update(demoSpectrum(time, this.demoBass, this.demoTreble), now);
      if (now > this.nextTrackTime) { this.demoIndex = (this.demoIndex + 1) % demoTracks.length; this.nextDemo(); }
    }
    this.audio.tick(dt, now);
    const palette = this.painter.palette.join(',');
    if (palette !== this.backgroundPalette) {
      this.backgroundPalette = palette;
      this.lyrics.setPalette(palette);
      this.painter.palette.forEach((color, i) => this.root.style.setProperty(`--cover-${i + 1}`, color));
    }
    if (now - this.lastPaint > (this.config.lowPower ? 100 : 1000 / 30)) {
      this.painter.paint(time, this.config, this.audio, this.powered); this.lastPaint = now;
      if (!this.scene) {
        this.query<HTMLCanvasElement>('#fallback-screen').getContext('2d')?.drawImage(this.painter.canvas, 0, 0);
      }
    }
    this.scene?.render(time, dt, this.config, this.audio, this.painter, this.powered);
  };
  dispose(): void {
    cancelAnimationFrame(this.frame); clearTimeout(this.demoTimer); this.unsubscribe(); this.disposers.forEach(fn => fn()); this.settingsSync?.dispose(); this.customEffects.dispose(); this.songPicker.dispose(); this.lyrics.dispose(); this.scene?.dispose(); this.painter.dispose(); this.bridge.dispose(); this.genre.dispose();
  }
}
