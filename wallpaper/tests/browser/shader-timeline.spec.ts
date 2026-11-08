import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { effectStorageKey, starterShaderTimeline } from '../../src/background/CustomEffects';

const importFile = (page: Page, file: unknown) => page.locator('#custom-effect-file').setInputFiles({ name: 'timeline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
const track = (page: Page) => page.evaluate(() => window.livelyCurrentTrack?.(JSON.stringify({ Title: 'My Song', Artist: 'My Artist' })));
const timelineFile = () => {
  const file = starterShaderTimeline(null);
  file.effects[0].match = { titles: ['My Song'], artists: ['My Artist'], versions: 'ignore' };
  // Deliberately use the same helper name in different programs.
  file.effects[0].timeline!.shaders = [
    { id: 'orbit', shader: 'vec4 color(){return vec4(1.,uTime*.000001+uSongTime*.000001,0.,1.);} vec4 effect(vec2 uv){return color();}' },
    { id: 'ribbon', shader: 'vec4 color(){return vec4(0.,uTime*.000001+uSongTime*.000001,1.,1.);} vec4 effect(vec2 uv){return color();}' },
  ];
  return file;
};

type Metrics = { weights: number[]; time: number; pixel: number[]; textures: number; deleted: number; draws: number };
const metrics = (page: Page) => page.evaluate(() => (window as unknown as { timelineMetrics: Metrics }).timelineMetrics);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.route('http://127.0.0.1:43821/**', route => route.fulfill({ json: { status: 'no_session' } }));
  await page.addInitScript(() => {
    localStorage.setItem('spicy-bond-settings-v1', JSON.stringify({ lyrics: false, particles: false, clock: false, noise: false, analogIntensity: 0, transitionDuration: .3, backgroundIntensity: .2, backgroundBrightness: 1 }));
    const state = { weights: [] as number[], time: -1, pixel: [] as number[], textures: 0, deleted: 0, draws: 0 };
    (window as unknown as { timelineMetrics: typeof state }).timelineMetrics = state;
    const p = WebGL2RenderingContext.prototype, locations = new WeakMap<WebGLUniformLocation, string>(), programs = new WeakSet<WebGLProgram>();
    const get = p.getUniformLocation, set = p.uniform1f, set2 = p.uniform2f, use = p.useProgram, draw = p.drawElements, create = p.createTexture, remove = p.deleteTexture;
    let composite = false;
    p.getUniformLocation = function(program, name) { const location = get.call(this, program, name); if (location) { locations.set(location, name); if (name === 'uOpacity') programs.add(program); } return location; };
    p.uniform1f = function(location, value) { if (location && locations.get(location) === 'uSongTime') state.time = value; return set.call(this, location, value); };
    p.uniform2f = function(location, x, y) { if (location && locations.get(location) === 'uWeights') state.weights = [x, y]; return set2.call(this, location, x, y); };
    p.useProgram = function(program) { composite = !!program && programs.has(program); return use.call(this, program); };
    p.drawElements = function(mode, count, type, offset) {
      draw.call(this, mode, count, type, offset);
      if (composite && !this.getParameter(this.FRAMEBUFFER_BINDING)) { const pixel = new Uint8Array(4); this.readPixels(5, 5, 1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel); state.pixel = [...pixel]; state.draws++; }
    };
    p.createTexture = function() { state.textures++; return create.call(this); };
    p.deleteTexture = function(texture) { state.deleted++; return remove.call(this, texture); };
  });
});

test('follows playback with lyrics off, blends without a brightness dip, seeks both ways and restores', async ({ page }) => {
  test.setTimeout(180_000);
  let position = 10.5;
  await page.route('http://127.0.0.1:43821/now-playing', route => route.fulfill({ json: { title: 'My Song', artist: 'My Artist', position, duration: 60, isPlaying: false } }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('./?live=1&settings=1'); await track(page); await importFile(page, timelineFile());
  await expect(page.locator('#custom-effect-feedback')).toContainText('Imported 1 effect');
  await expect.poll(async () => (await metrics(page)).time).toBe(10.5);
  await expect.poll(async () => (await metrics(page)).weights).toEqual([.84375, .15625]);
  position = 11;
  await expect.poll(async () => (await metrics(page)).weights).toEqual([.5, .5]);
  const pixel = (await metrics(page)).pixel;
  expect(pixel[0]).toBeGreaterThan(80); expect(pixel[2]).toBeGreaterThan(80);
  await page.waitForTimeout(200);
  expect((await metrics(page)).time).toBe(11); // A paused snapshot holds exactly.
  const textures = (await metrics(page)).textures;
  for (const seek of [25, 5, 15, 11]) {
    position = seek;
    await expect.poll(async () => (await metrics(page)).time).toBe(seek);
  }
  expect((await metrics(page)).textures).toBe(textures); // Reuse the two blend targets on seeks.
  await page.locator('[data-setting=reducedMotion]').check(); position = 25;
  await page.waitForTimeout(700); expect((await metrics(page)).time).toBe(11);
  await page.locator('[data-setting=reducedMotion]').uncheck();
  await expect.poll(async () => (await metrics(page)).time).toBe(25);
  const saved = await page.evaluate(key => localStorage.getItem(key), effectStorageKey);
  await page.reload(); await track(page);
  await expect(page.locator('#app')).toHaveAttribute('data-custom-effect', 'my-shader-timeline');
  await expect.poll(async () => (await metrics(page)).time).toBe(25);
  expect(await page.evaluate(key => localStorage.getItem(key), effectStorageKey)).toBe(saved);
  position = 11;
  await expect.poll(async () => (await metrics(page)).time).toBe(11);
  const deleted = (await metrics(page)).deleted;
  await page.getByRole('button', { name: 'Remove Timed shader morph', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).deleted).toBeGreaterThanOrEqual(deleted + 2);
  const reference = timelineFile().effects[0];
  const draws = (await metrics(page)).draws;
  await importFile(page, { version: 1, effects: [{ ...reference, timeline: undefined, shader: 'vec4 effect(vec2 uv){return vec4(.5,0.,.5,1.);}' }] });
  await expect.poll(async () => (await metrics(page)).draws).toBeGreaterThan(draws);
  // Compare against a single shader with the exact linear midpoint. ACES maps red and blue differently.
  await expect.poll(async () => Math.max(...(await metrics(page)).pixel.map((channel, index) => Math.abs(channel - pixel[index])))).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('compiles every timeline shader before saving, including unused definitions', async ({ page }) => {
  await page.goto('./?live=1&settings=1'); await track(page); await importFile(page, timelineFile());
  await expect(page.locator('#custom-effect-feedback')).toContainText('Imported 1 effect');
  const saved = await page.evaluate(key => localStorage.getItem(key), effectStorageKey);
  const invalid = timelineFile();
  invalid.effects[0].timeline!.shaders.push({ id: 'unused', shader: 'vec4 effect(vec2 uv){return missingFunction(uv);}' });
  await importFile(page, invalid);
  await expect(page.locator('#custom-effect-feedback')).toContainText('unused: shader could not compile');
  expect(await page.evaluate(key => localStorage.getItem(key), effectStorageKey)).toBe(saved);
});

test('downloads a song-bound timeline starter, exports losslessly and previews from zero', async ({ page, request }) => {
  await page.goto('./?live=1&settings=1'); await track(page);
  const download = page.waitForEvent('download'); await page.locator('#custom-effect-timeline-starter').click();
  const starter = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  expect(starter.effects[0].match).toMatchObject({ titles: ['My Song'], artists: ['My Artist'] });
  expect((await request.get('effects/shader-timeline.json')).status()).toBe(200);
  await importFile(page, starter);
  await expect(page.locator('#custom-effect-feedback')).toContainText('Imported 1 effect');
  await importFile(page, timelineFile());
  await expect(page.locator('#custom-effect-feedback')).toContainText('Imported 1 effect');
  await expect.poll(async () => (await metrics(page)).time).toBeGreaterThan(.05);
  await page.getByRole('button', { name: 'Preview Timed shader morph', exact: true }).click();
  await expect(page.locator('#custom-effect-status')).toContainText('Previewing');
  await expect.poll(async () => (await metrics(page)).time).toBeLessThan(1);
  const exported = page.waitForEvent('download'); await page.locator('#custom-effect-export').click();
  const file = JSON.parse(readFileSync((await (await exported).path())!, 'utf8'));
  expect(file).toEqual(timelineFile());
});
