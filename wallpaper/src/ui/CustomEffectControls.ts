import { effectStorageKey, matchesEffect, maxEffectFileBytes, mergeEffects, parseEffectFile, starterEffect, starterShaderTimeline, type CustomEffectSettings, type CustomEffect, type EffectFile } from '../background/CustomEffects';
import { bridgeHeaders } from '../music/SongSearch';
import type { Track } from '../lively/types';

export const customEffectsMarkup = `
  <div class="section-label">Custom song effects</div>
  <label class="toggle-row"><span>Enable custom effects</span><input id="custom-effects-enabled" type="checkbox" checked><span class="switch"></span></label>
  <label class="toggle-row"><span>Keep current atmosphere (overlay)</span><input id="custom-effects-overlay" type="checkbox" checked><span class="switch"></span></label>
  <p class="panel-note">Create a JSON file with layers, animation and audio reactivity, or schedule multiple shaders with timed cues and smooth transitions. Download a starter for the current song, edit it, then import it. Reimporting the same ID updates it.</p>
  <button class="outline-button" id="custom-effect-starter">Download starter for current song</button>
  <button class="outline-button" id="custom-effect-timeline-starter">Download timed shader starter</button>
  <label class="field">Import effect file (.json)<input id="custom-effect-file" type="file" accept=".json,application/json" aria-describedby="custom-effect-feedback"></label>
  <p class="panel-note" id="custom-effect-feedback" role="alert"></p>
  <p class="panel-note" id="custom-effect-status" role="status"></p>
  <div id="custom-effect-list" class="custom-effect-list" aria-label="Saved custom effects"></div>
  <button class="outline-button" id="custom-effect-stop" hidden>Stop effect preview</button>
  <button class="outline-button" id="custom-effect-export">Export all custom effects</button>
  <p class="panel-note">Effects are saved in the paired companion’s wallpaper-settings.json and restored after updates. Without a companion they stay in this browser / Lively profile. Export a backup to move them to another computer. Custom effects follow brightness, animation and reduced-motion settings. <a href="${import.meta.env.BASE_URL}effects/guide.html" target="_blank" rel="noopener noreferrer">Effect file guide and examples ↗</a></p>`;

export class CustomEffectControls {
  private file: EffectFile = { version: 1, effects: [] };
  private enabled = true;
  private overlay = true;
  private preview: string | null = null;
  private removers: (() => void)[] = [];
  private generation = 0;
  private disposed = false;
  private exportRequest: AbortController | null = null;
  private trackIdentity = '';
  get previewing(): boolean { return this.preview !== null; }
  private query<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  constructor(private root: HTMLElement, private getTrack: () => Track | null, private validate: (effects: readonly CustomEffect[]) => void, private select: (effect: CustomEffect | null, restart: boolean) => void, private changed: () => void = () => {}) {
    try {
      this.overlay = localStorage.getItem(`${effectStorageKey}-overlay`) !== 'false';
      this.enabled = localStorage.getItem(`${effectStorageKey}-enabled`) !== 'false';
      const saved = localStorage.getItem(effectStorageKey);
      if (saved) { const file = parseEffectFile(saved); this.validate(file.effects); this.file = file; }
    } catch (error) { this.feedback(`Saved effects could not load: ${(error as Error).message}`); }
    this.query<HTMLInputElement>('#custom-effects-overlay').checked = this.overlay;
    this.listen(this.query('#custom-effects-overlay'), 'change', () => {
      this.overlay = this.query<HTMLInputElement>('#custom-effects-overlay').checked;
      try { localStorage.setItem(`${effectStorageKey}-overlay`, String(this.overlay)); } catch { /* Companion keeps the preference. */ }
      this.refresh(); this.changed();
    });
    this.query<HTMLInputElement>('#custom-effects-enabled').checked = this.enabled;
    this.listen(this.query('#custom-effects-enabled'), 'change', () => {
      const enabled = this.query<HTMLInputElement>('#custom-effects-enabled').checked;
      try { localStorage.setItem(`${effectStorageKey}-enabled`, String(enabled)); this.enabled = enabled; this.preview = null; this.feedback(''); this.refresh(); this.changed(); }
      catch { this.query<HTMLInputElement>('#custom-effects-enabled').checked = this.enabled; this.feedback('Could not save this preference.'); }
    });
    this.listen(this.query('#custom-effect-file'), 'change', () => { void this.importFile(); });
    this.listen(this.query('#custom-effect-starter'), 'click', () => this.download(starterEffect(this.getTrack()), 'my-song-effect.json'));
    this.listen(this.query('#custom-effect-timeline-starter'), 'click', () => this.download(starterShaderTimeline(this.getTrack()), 'my-shader-timeline.json'));
    this.listen(this.query('#custom-effect-export'), 'click', () => this.download(this.file, 'spicy-bond-effects.json'));
    this.listen(this.query('#custom-effect-stop'), 'click', () => { this.preview = null; this.refresh(); });
    this.listen(this.query('#custom-effect-list'), 'click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
      const effect = this.file.effects.find(effect => effect.id === button?.dataset.id);
      if (!button || !effect) return;
      if (button.dataset.action === 'export') this.download({ version: 1, effects: [effect] }, `${effect.id}.json`);
      if (button.dataset.action === 'preview') {
        this.preview = this.preview === effect.id ? null : effect.id; this.refresh(true);
      }
      if (button.dataset.action === 'toggle') this.save({ version: 1, effects: this.file.effects.map(row => row.id === effect.id ? { ...row, enabled: !row.enabled } : row) });
      if (button.dataset.action === 'remove') this.save({ version: 1, effects: this.file.effects.filter(row => row.id !== effect.id) });
    });
    this.refresh();
  }
  private listen(element: HTMLElement, type: string, listener: EventListener): void { element.addEventListener(type, listener); this.removers.push(() => element.removeEventListener(type, listener)); }
  private feedback(message: string): void { this.query('#custom-effect-feedback').textContent = message; }
  private async importFile(): Promise<void> {
    const input = this.query<HTMLInputElement>('#custom-effect-file'), file = input.files?.[0], generation = ++this.generation;
    if (!file) return;
    try {
      if (file.size > maxEffectFileBytes) throw new Error('Maximum file size is 512 KiB.');
      const incoming = parseEffectFile(await file.text());
      if (this.disposed || generation !== this.generation) return;
      const merged = mergeEffects(this.file, incoming);
      this.validate(incoming.effects);
      if (this.save(merged)) this.feedback(`Imported ${incoming.effects.length} effect${incoming.effects.length === 1 ? '' : 's'}. Matching songs use them automatically; Preview tries an effect on any song.`);
    } catch (error) { if (!this.disposed && generation === this.generation) this.feedback(`Import failed: ${(error as Error).message}. Your saved effects were kept.`); }
    finally { if (!this.disposed && generation === this.generation) input.value = ''; }
  }
  private save(file: EffectFile): boolean {
    try {
      const text = JSON.stringify(file);
      if (new TextEncoder().encode(text).length > maxEffectFileBytes) throw new Error('Combined library exceeds 512 KiB; remove some effects.');
      localStorage.setItem(effectStorageKey, text);
      this.file = file; this.preview = null; this.feedback(''); this.refresh(); this.changed(); return true;
    } catch (error) { this.feedback(`Could not save effects: ${(error as Error).message}. Your saved effects were kept.`); return false; }
  }
  snapshot(): CustomEffectSettings { return structuredClone({ enabled: this.enabled, overlay: this.overlay, file: this.file }); }
  restore(settings: CustomEffectSettings): void {
    if (JSON.stringify(this.snapshot()) === JSON.stringify(settings)) return;
    this.validate(settings.file.effects);
    this.file = structuredClone(settings.file); this.enabled = settings.enabled; this.overlay = settings.overlay ?? true; this.preview = null;
    try {
      localStorage.setItem(effectStorageKey, JSON.stringify(this.file));
      localStorage.setItem(`${effectStorageKey}-enabled`, String(this.enabled));
      localStorage.setItem(`${effectStorageKey}-overlay`, String(this.overlay));
    } catch { /* The companion JSON remains authoritative if the offline cache is unavailable. */ }
    this.query<HTMLInputElement>('#custom-effects-enabled').checked = this.enabled;
    this.query<HTMLInputElement>('#custom-effects-overlay').checked = this.overlay;
    this.feedback(''); this.refresh();
  }
  trackChanged(): void {
    const track = this.getTrack(), identity = JSON.stringify(track && [track.title, track.artist, track.albumArtist, track.album]);
    if (identity === this.trackIdentity) return;
    this.trackIdentity = identity; this.preview = null; this.refresh(true);
  }
  private refresh(restart = false): void {
    const active = this.enabled ? this.file.effects.find(effect => effect.id === this.preview) ?? [...this.file.effects].reverse().find(effect => matchesEffect(effect, this.getTrack())) ?? null : null;
    this.select(active && this.overlay ? { ...active, replace: false } : active, restart); this.root.dataset.customEffect = active?.id || '';
    this.query('#custom-effect-status').textContent = !this.enabled ? 'Custom effects are disabled.' : active ? `${this.preview ? 'Previewing' : 'Active'}: ${active.name}` : this.file.effects.length ? 'No custom effect matches the current song.' : 'No custom effects imported yet.';
    this.query('#custom-effect-stop').hidden = !this.preview;
    this.query<HTMLButtonElement>('#custom-effect-export').disabled = !this.file.effects.length;
    const list = this.query('#custom-effect-list'); list.replaceChildren();
    for (const effect of this.file.effects) {
      const item = document.createElement('div'); item.className = 'custom-effect-item';
      const title = document.createElement('strong'); title.textContent = effect.name; item.append(title);
      const description = document.createElement('p'); description.className = 'panel-note'; description.textContent = `${effect.match.titles.join(' / ')} — ${effect.match.artists.join(' / ')}${effect.enabled ? '' : ' (disabled)'}`; item.append(description);
      const actions = document.createElement('div'); actions.className = 'custom-effect-actions';
      for (const [action, label] of [['preview', this.preview === effect.id ? 'Stop preview' : 'Preview'], ['toggle', effect.enabled ? 'Disable' : 'Enable'], ['export', 'Export'], ['remove', 'Remove']]) {
        const button = document.createElement('button'); button.className = 'outline-button'; button.textContent = label;
        if (action === 'preview') button.setAttribute('aria-pressed', String(this.preview === effect.id));
        button.dataset.action = action; button.dataset.id = effect.id; button.setAttribute('aria-label', `${label} ${effect.name}`);
        if (action === 'preview') button.disabled = !this.enabled;
        actions.append(button);
      }
      item.append(actions); list.append(item);
    }
  }
  private async download(file: EffectFile, name: string): Promise<void> {
    const text = JSON.stringify(file, null, 2) + '\n';
    if (this.exportRequest) { this.feedback('A Save As dialog is already open. Finish or cancel it first.'); return; }
    const headers = bridgeHeaders();
    if (headers['X-RetroWave-Key']) {
      this.exportRequest = new AbortController();
      this.feedback('Choose a folder and filename in the Windows Save As dialog…');
      try {
        const response = await fetch('http://127.0.0.1:43821/effect-export', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, file, chooseLocation: true }), signal: this.exportRequest.signal });
        const saved = await response.json() as { path?: unknown; cancelled?: unknown; dialog?: unknown; error?: unknown };
        if (!response.ok) throw new Error(typeof saved.error === 'string' ? saved.error : response.status === 404 ? 'Update the companion to open a Save As dialog.' : 'The companion could not save the export.');
        if (saved.cancelled === true) { if (!this.disposed) this.feedback('Save canceled.'); return; }
        if (typeof saved.path !== 'string' || !saved.path) throw new Error('The companion did not confirm the export.');
        if (!this.disposed) this.feedback(`Saved JSON: ${saved.path}${saved.dialog === true ? '' : '. Update the companion to choose a folder in Save As.'}`);
      } catch (error) { if (!this.disposed) this.feedback(`Save failed: ${(error as Error).message}`); }
      finally { this.exportRequest = null; }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    this.feedback('Download requested. In Lively, start and pair the updated companion to open Save As.');
  }
  dispose(): void { this.disposed = true; this.exportRequest?.abort(); this.generation++; this.removers.forEach(remove => remove()); }
}
