import { expect, test } from '@playwright/test';
import { active, cover, fixture, start } from './lyric-fixtures';

test.describe('lyrics layout', () => {
  // Preserve CSS viewport dimensions while bounding the software-WebGL buffer.
  // Full-density rendering has separate visual and graphics coverage.
  test.use({ deviceScaleFactor: .5 });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 800, height: 600 }]) {
    test(`45% lyrics box stays above the TV at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport); await start(page);
      await expect(page.locator(active)).toBeVisible();
      const box = (await page.locator('#lyrics').boundingBox())!;
      const scene = (await page.locator('.tv-viewport').boundingBox())!;
      expect(box.height).toBeCloseTo(viewport.height * 0.45, 0);
      expect(box.y + box.height).toBeLessThan(scene.y);
      await expect.poll(() => page.locator('.scene canvas').evaluate(el => el.clientHeight)).toBe(viewport.height);
      await page.keyboard.press('s'); await page.locator('[data-setting=lyrics]').uncheck();
      await expect.poll(() => page.locator('.tv-viewport').evaluate(el => el.getBoundingClientRect().top)).toBe(0);
      await expect.poll(() => page.locator('.tv-viewport').evaluate(el => el.clientHeight)).toBeGreaterThan(scene.height);
    });
  }
});

test('the complete upstream renderer supplies its spring, letter and virtualized scrolling behavior', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page); await expect(page.locator(active)).toHaveText('Silverechoes');
  await expect(page.locator('.VirtualLyricsContainer')).toBeVisible(); expect(await page.locator('.letterGroup .letter').count()).toBeGreaterThan(5);
  const letter = page.locator('.line.Active .letter').first();
  await expect.poll(() => letter.evaluate(el => el.style.getPropertyValue('--gradient-position'))).not.toBe('-20%');
  expect(await letter.evaluate(el => el.getAnimations().length)).toBe(0); // Original renderer uses its spring engine.
  await expect.poll(() => page.locator('#lyrics').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  await page.screenshot({ path: 'test-results/spicy-upstream-full.png' }); expect(errors).toEqual([]);
});
test('duet alignment and backing vocals survive the provider adapter', async ({ page }) => {
  await start(page, { Type: 'Syllable', StartTime: 0, Content: [{ Type: 'Vocal', OppositeAligned: true,
    Lead: { StartTime: 0, EndTime: 20, Syllables: [{ Text: 'Lead vocal', StartTime: 0, EndTime: 20 }] },
    Background: [{ StartTime: 0, EndTime: 20, Syllables: [{ Text: 'Backing vocal', StartTime: 0, EndTime: 20 }] }],
  }] });
  await expect(page.locator('.HasDuetLines')).toBeVisible(); await expect(page.locator('.bg-line')).toHaveText('Backing vocal'); await expect(page.locator('.line.OppositeAligned').first()).toBeVisible();
});
test('original interlude dots render musical gaps', async ({ page }) => {
  const clock = { position: 7, isPlaying: false };
  await start(page, { Type: 'Line', StartTime: 0, Content: [{ Type: 'Vocal', Text: 'Before the gap', StartTime: 0, EndTime: 5 }, { Type: 'Vocal', Text: 'After the gap', StartTime: 15, EndTime: 30 }] }, clock);
  await expect(page.locator('.musical-line.Active .dot')).toHaveCount(3);
  await expect(page.locator('.musical-line.Active')).toBeVisible();
  clock.position = 16; await expect(page.locator(active)).toHaveText('After the gap');
});
for (const [name, text] of [
  ['rtl', 'سلام دنیا! مرحباً بالعالم، موسیقی 🎵'],
  ['mixed', 'سلام Spotify 2026 — e\u0301cho 👩‍🎤'],
  ['long', 'A long flowing phrase, with punctuation! '.repeat(30)],
  ['unbroken', 'verylongunbrokenlyric'.repeat(15)],
] as const) {
  test(`${name} lines preserve content and wrap without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await start(page, { Type: 'Line', StartTime: 0, Content: [{ Type: 'Vocal', Text: text, StartTime: 0, EndTime: 100 }] });
    await expect(page.locator(active)).toHaveText(text.trim());
    const measurements = await page.locator('.LyricsContent').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, rowWidth: el.querySelector('.line')!.getBoundingClientRect().width }));
    expect(measurements.scroll).toBeLessThanOrEqual(measurements.width + 1); expect(measurements.rowWidth).toBeLessThanOrEqual(measurements.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
    expect(await page.locator('.line .letter').count()).toBe(0);
    if (name === 'long' || name === 'unbroken') {
      await expect(page.locator(active)).toHaveClass(/OverflowLine/);
      const row = page.locator(active);
      expect(await row.evaluate(el => el.clientHeight)).toBeGreaterThan(100);
      await row.evaluate(el => { el.scrollTop = el.scrollHeight; });
      expect(await row.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual((await page.locator('.LyricsContent').boundingBox())!.height);
    }
    await expect.poll(() => page.locator('#lyrics').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await page.screenshot({ path: `test-results/spicy-upstream-${name}.png` });
  });
}
test('long word-synced groups also wrap without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 }); const text = 'longword'.repeat(20);
  await start(page, { Type: 'Syllable', StartTime: 0, Content: [{ Type: 'Vocal', Lead: { StartTime: 0, EndTime: 20, Syllables: [{ Text: text, StartTime: 0, EndTime: 20 }] } }] });
  await expect(page.locator(active)).toHaveText(text);
  const width = await page.locator('.LyricsContent').evaluate(el => el.clientWidth);
  expect((await page.locator('.letterGroup').boundingBox())!.width).toBeLessThanOrEqual(width + 1);
});
test('static lyrics remain readable and virtual scrolling reaches the last line', async ({ page }) => {
  await start(page, { Type: 'Static', Lines: Array.from({ length: 100 }, (_, i) => ({ Text: `Untimed phrase ${i}` })) });
  // Initial layout of 100 upstream rows can exceed ten seconds while Chromium
  // also renders WebGL in software. Keep the real visibility/scroll assertions.
  await expect(page.locator('.line.static').first()).toBeVisible({ timeout: 30_000 }); expect(await page.locator('.line [data-start],.line .letter').count()).toBe(0);
  const scroll = page.locator('.simplebar-content-wrapper');
  // Virtual rows replace estimated heights as they mount. Recompute the end
  // after each pass, and override CSS smooth scrolling for this endpoint check.
  await expect.poll(async () => scroll.evaluate(el => {
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    const last = el.querySelector<HTMLElement>('.line[data-line="99"]');
    if (!last) return false;
    const row = last.getBoundingClientRect(), viewport = el.getBoundingClientRect();
    return row.top >= viewport.top && row.bottom <= viewport.bottom;
  })).toBe(true);
  await expect(page.getByText('Untimed phrase 99', { exact: true })).toBeVisible();
});
for (const color of ['#e00028', '#0030d0', '#fff9d0', '#080909']) {
  test(`cover ${color} drives lyric text and glow`, async ({ page }) => {
    await start(page); await expect(page.locator(active)).toBeVisible();
    await cover(page, color);
    await expect.poll(() => page.locator('#lyrics').evaluate(el => el.style.getPropertyValue('--renderer-rgb'))).not.toBe('');
    const rgb = await page.locator('#lyrics').evaluate(el => el.style.getPropertyValue('--renderer-rgb').split(',').map(Number));
    if (color === '#e00028') expect(rgb[0]).toBeGreaterThan(Math.max(rgb[1], rgb[2]) * 1.5);
    if (color === '#e00028') {
      await expect.poll(() => page.locator('#app').evaluate(el => el.getAnimations().length)).toBe(0);
      await expect.poll(() => page.locator('#lyrics').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
      await page.screenshot({ path: 'test-results/spicy-upstream-cover.png' });
    }
    if (color === '#0030d0') expect(rgb[2]).toBeGreaterThan(rgb[0] * 1.5);
    const paint = await page.locator('.line.Active .letter').first().evaluate(el => getComputedStyle(el).backgroundImage);
    expect(paint).toContain('linear-gradient');
  });
}
test('neutral lyric text remains white after a saturated cover', async ({ page }) => {
  await start(page); await expect(page.locator(active)).toBeVisible();
  await cover(page, '#e00028');
  await expect.poll(() => page.locator('#lyrics').evaluate(el => el.style.getPropertyValue('--renderer-rgb'))).not.toBe('245,245,241');
  await page.keyboard.press('s'); await page.locator('[data-setting=lyricColor]').selectOption('neutral');
  await expect.poll(() => page.locator('#lyrics').evaluate(el => el.style.getPropertyValue('--renderer-rgb'))).toBe('245,245,241');
});
test('reduced motion and low power suppress transforms while keeping timing', async ({ page }) => {
  const clock = { position: 1, isPlaying: false }; await start(page, fixture, clock); await expect(page.locator(active)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator('#SpicyLyricsPage')).toHaveClass(/ReducedMotion/);
  expect(await page.locator('.line.Active .word,.line.Active .letter').first().evaluate(el => getComputedStyle(el).transform)).toBe('none');
  clock.position = 7; await expect(page.locator(active)).toHaveText('Floatinghome');
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.keyboard.press('s'); await page.locator('[data-setting=lowPower]').check(); await expect(page.locator('#SpicyLyricsPage')).toHaveClass(/ReducedMotion/);
});
test('the renderer label is removed and source attribution is in settings', async ({ page }) => {
  await start(page); await expect(page.locator(active)).toBeVisible();
  await expect(page.locator('#lyrics')).not.toContainText('Renderer:'); await expect(page.locator('.lyrics-credit')).toHaveCount(0);
  await page.keyboard.press('s');
  const settings = page.getByRole('dialog', { name: 'Fine tuning' });
  await expect(settings.getByRole('link', { name: 'Source and licenses', exact: true })).toHaveAttribute('href', /\/licenses\/$/);
  await expect(settings.getByRole('link', { name: 'Complete corresponding source snapshot' })).toHaveAttribute('href', /source\.zip$|\/archive\/[0-9a-f]{40}\.zip$/);
  await expect(settings).toContainText('Spicy Lyrics by Spikerko and contributors');
});
test('unclocked segments keep their text without receiving false timestamp attributes', async ({ page }) => {
  await start(page, { Type: 'Syllable', Content: [{ Type: 'Vocal', Lead: { StartTime: 0, EndTime: 20, Syllables: [
    { Text: 'Valid', StartTime: 0, EndTime: 2 }, { Text: 'Unscheduled', StartTime: -1, EndTime: 9 },
  ] } }] });
  await expect(page.locator(active)).toHaveText('ValidUnscheduled');
  const word = page.locator('.line.Active .word').filter({ hasText: 'Unscheduled' });
  await expect(word).toBeVisible(); expect(await word.getAttribute('data-start')).toBeNull();
  expect(await word.getAttribute('style')).not.toContain('NaN');
});
