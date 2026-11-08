import { themes } from '../background/Themes';
import type { Config } from '../core/Config';
import { sourceLicensesMarkup } from './SourceLicenses';
import { customEffectsMarkup } from './CustomEffectControls';
import { brand } from '../core/Brand';
export function settingsMarkup(config: Config): string {
  const toggle = (key: keyof Config, label: string) => `<label class="toggle-row"><span>${label}</span><input type="checkbox" data-setting="${key}" ${config[key] ? 'checked' : ''}><span class="switch"></span></label>`;
  const options = themes.map(theme => `<option value="${theme.id}">${theme.name}</option>`).join('');
  const range = (key: keyof Config, label: string, min: number, max: number, step = 0.05) => `<label class="field">${label}<input data-setting="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${config[key]}"></label>`;
  return `<div class="panel-title"><div><span class="eyebrow">MAKE IT YOURS</span><h2>Fine tuning</h2></div><button class="icon-button" id="close-settings" aria-label="Close settings">×</button></div>
    <div class="settings-content" tabindex="0" aria-label="Settings controls">
    <p class="panel-note" id="settings-save-status" role="status"></p>
    <p class="panel-note" id="settings-sync-status" role="status"></p>
    <div class="section-label">Appearance</div>
    <label class="field">Cabinet finish<select data-setting="casing"><option value="wood">Dark walnut</option><option value="beige">Aged ivory</option></select></label>
    <div class="section-label">Television display</div>
    <label class="field">Display channel<select data-setting="mode"><option value="broadcast">01 — Vintage broadcast</option><option value="vinyl">02 — Minimal vinyl</option></select></label>
    <label class="field">Picture brightness<input data-setting="brightness" type="range" min="0.3" max="1.5" step="0.05" value="${config.brightness}"></label>
    ${toggle('antenna', 'Rabbit ear antenna')}${toggle('clock', 'Screen clock')}
    <div class="section-label">Visual effects</div>
    <label class="field">Visualizer intensity<input data-setting="intensity" type="range" min="0.2" max="1.5" step="0.05" value="${config.intensity}"></label>
    ${toggle('scanlines', 'Scanlines')}${toggle('curvature', 'CRT curvature')}${toggle('aberration', 'RGB separation')}${toggle('noise', 'Analog grain')}${toggle('glow', 'Phosphor glow')}${toggle('reflections', 'Glass reflections')}${toggle('interference', 'Tuning & interference')}${toggle('particles', 'Atmospheric particles')}
    <div class="section-label">Background &amp; Visual Effects</div>
    <p class="panel-note" id="background-status" role="status">Default theme</p>
    ${toggle('autoGenre', 'Automatic genre detection')}
    <label class="field">Manual genre / theme<select data-setting="manualTheme"><option value="auto">Follow automatic / default theme</option>${options}</select></label>
    <label class="field">Default background theme<select data-setting="defaultTheme">${options}</select></label>
    ${toggle('backgroundAnimation', 'Animate background')}${toggle('songAccents', 'Song easter eggs')}
    <label class="field">Atmospheric effect<select data-setting="particleStyle"><option value="auto">Follow genre</option><option value="sparkles">Soft sparkles</option><option value="dust">Drifting dust</option><option value="rain">Gentle rain</option><option value="embers">Rising embers</option><option value="bokeh">Floating bokeh</option><option value="fireflies">Fireflies</option></select></label>
    ${range('backgroundIntensity', 'Background animation intensity', 0, 1.5)}
    ${range('reactivity', 'Music reactivity sensitivity', 0, 2)}
    ${range('particleMotion', 'Particle movement', 0, 3)}
    ${range('particleScale', 'Particle scale', .5, 3)}
    ${range('particleDensity', 'Background particle density', 0, 1)}
    ${range('backgroundGlow', 'Background glow / bloom', 0, 1.5)}
    ${range('analogIntensity', 'CRT / VHS effect intensity', 0, 1)}
    ${range('backgroundBrightness', 'Background effect brightness', 0.1, 1.5)}
    ${range('transitionDuration', 'Theme transition duration (seconds)', 0.3, 10, 0.1)}
    ${toggle('reducedMotion', 'Reduced motion')}
    <p class="panel-note">The album-color background stays unchanged. Genres select layered effects. Manual selection takes priority; missing metadata uses the default. Reduced motion also follows your system preference and freezes the environment and reactive pulses.</p>
    ${customEffectsMarkup}
    <div class="section-label">Performance</div>
    <label class="field">Performance preset<select data-setting="performancePreset"><option value="low">Low</option><option value="balanced">Balanced</option><option value="high">High</option><option value="ultra">Ultra</option></select></label>
    <label class="field">Frame rate<select data-setting="fps"><option value="60">60 FPS</option><option value="30">30 FPS</option></select></label>
    ${toggle('lowPower', 'Low power mode')}
    <div class="section-label">Lyrics appearance</div>
    ${toggle('lyrics', 'Background lyrics')}
    ${toggle('censorLyrics', 'Lyric censorship')}
    <p class="panel-note">Masks common English explicit words with asterisks. Turn off to show the original wording.</p>
    <label class="field">Animation style<select data-setting="lyricStyle"><option value="smooth">Smooth</option><option value="classic">Classic</option><option value="minimal">Minimal</option></select></label>
    <label class="field">Lyric text size<input data-setting="lyricSize" type="range" min="0.65" max="1.35" step="0.05" value="${config.lyricSize}"></label>
    <label class="field">Highlight glow<input data-setting="lyricIntensity" type="range" min="0" max="1" step="0.05" value="${config.lyricIntensity}"></label>
    <label class="field">Lyric color<select data-setting="lyricColor"><option value="automatic">Automatic album palette</option><option value="neutral">Neutral high contrast</option></select></label>
    <label class="field">Lyric timing adjustment (seconds)<input data-setting="lyricOffset" type="range" min="-30" max="30" step="0.1" value="${config.lyricOffset}"></label>
    <p class="panel-note">Positive values advance lyrics; negative values delay them. Saved automatically with your preferences.</p>
    ${toggle('publicLyrics', 'Use LRCLIB fallback')}
    <p class="panel-note">Enabling LRCLIB sends the song title, artist, album and duration to lrclib.net for a lyric lookup. No account or key is needed.</p>
    <label class="field">Spicy Lyrics publishable key<input id="spicy-key" type="password" maxlength="256" placeholder="sl_pk_…" autocomplete="off" spellcheck="false" aria-describedby="lyrics-key-feedback"></label>
    <button class="outline-button" id="save-lyrics-key">Save lyrics key</button>
    <p class="panel-note" id="lyrics-key-feedback" role="alert"></p>
    <p class="panel-note" id="lyrics-status">Add a Spicy key or enable LRCLIB fallback.</p>
    <button class="outline-button" id="clear-lyrics-cache">Clear saved lyric cache</button>
    <p class="panel-note">Frequent plays extend lyric retention up to 90 days; long-idle songs expire sooner. Missing results expire after 15 minutes.</p>
    <p class="panel-note" id="lyrics-cache-status" role="status">Cache retention adapts to your listening frequency.</p>
    <div class="lyric-cache-list" id="lyrics-cache-list" aria-live="polite"></div>
    ${sourceLicensesMarkup()}
    <p class="panel-note">Allow ${brand.pagesOrigin} in your Spicy application. LRCLIB is the fallback when a Spicy match or lyrics are missing. Install the Windows companion for accurate timing. <a href="${brand.repository}/blob/main/docs/lyrics.md" target="_blank" rel="noopener noreferrer">Setup guide ↗</a></p>
    <div class="section-label">Demo and diagnostics</div>
    <p class="panel-note">Silent public-domain song previews with locally authored artwork, lyric timing and simulated frequencies. Live callbacks always take priority.</p>
    <label class="field">Demo bass<input id="demo-bass" type="range" min="0" max="1.5" step="0.05" value="1"></label>
    <label class="field">Demo treble<input id="demo-treble" type="range" min="0" max="1.5" step="0.05" value="1"></label>
    <button class="outline-button" id="next-track">Next preview song ↗</button>
    <div class="section-label">Signal diagnostics</div><p class="panel-note" id="diagnostics">Waiting for Lively callbacks.</p>
    <p class="panel-note">Lively requires --audio and --system-nowplaying launch flags. Adding a URL alone may not enable them. See the compatibility report.</p>
    <button id="power-button" class="outline-button" aria-label="Toggle television power" aria-pressed="true">Television power</button>
    <button class="text-button" id="reset-settings">Restore original settings</button></div>`;
}
