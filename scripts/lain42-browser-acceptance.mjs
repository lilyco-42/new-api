/** CI-only acceptance of the built New API Agent UI against real DSH/server routes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const origin = process.argv[2];
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const dshRoot = process.env.LAIN42_COMPOSITION_DSH_ROOT;
assert.ok(dshRoot, 'The reviewed DSH checkout is required; never skip this gate.');
const require = createRequire(join(dshRoot, 'apps/web/package.json'));
const { chromium, devices } = require('playwright');
const evidence = resolve(process.env.LAIN42_BROWSER_EVIDENCE_DIR ?? '.agents/results/browser-acceptance');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const fixture of [
    { name: 'desktop', username: 'composition-owner', context: { viewport: { width: 1365, height: 900 }, locale: 'en-US' } },
    { name: 'mobile', username: 'composition-other', context: { ...devices['Pixel 7'], locale: 'en-US' } },
  ]) {
    const context = await browser.newContext(fixture.context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      // A user logs in through the actual form. No API response interception,
      // injected auth store or shared browser cookie is used.
      await page.goto(`${origin}/sign-in?redirect=%2Fagent`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Username or Email', { exact: true }).fill(fixture.username);
      await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-password');
      await Promise.all([
        page.waitForURL(url => url.pathname !== '/sign-in', { timeout: 30000 }),
        page.getByRole('button', { name: 'Sign in', exact: true }).click(),
      ]);
      await page.goto(`${origin}/agent`, { waitUntil: 'domcontentloaded' });
      const input = page.getByPlaceholder('Ask anything', { exact: true });
      await input.waitFor({ state: 'visible', timeout: 30000 });
      await page.locator('input[type="file"]').first().setInputFiles({
        name: 'browser-note.txt', mimeType: 'text/plain', buffer: Buffer.from('CLIENT_FILE_FACT_42: this is an account-owned browser attachment.'),
      });
      await input.fill('Explain my attached browser note and include a Rust code block.');
      const send = page.getByRole('button', { name: 'Send', exact: true });
      await send.waitFor({ state: 'visible' });
      assert.equal(await send.isEnabled(), true, 'The model/attachment flow must be usable.');
      await send.click();
      await page.getByText('The attached note contains CLIENT_FILE_FACT_42.', { exact: false }).waitFor({ timeout: 45000 });
      await page.locator('pre').filter({ hasText: 'fn main()' }).first().waitFor({ timeout: 15000 });
      // The browser must preserve the current conversation after a real reload.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('The attached note contains CLIENT_FILE_FACT_42.', { exact: false }).waitFor({ timeout: 30000 });
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(layout.scroll <= layout.width + 1, `Horizontal overflow at ${fixture.name}: ${JSON.stringify(layout)}`);
      assert.deepEqual(errors, [], 'Uncaught browser errors');
      await page.screenshot({ path: join(evidence, `${fixture.name}.png`), fullPage: true });
      results.push({ viewport: fixture.name, login: 'password + real session', attachmentAnswer: true, rustCode: true, reload: true, horizontalOverflow: false });
    } catch (error) {
      await page.screenshot({ path: join(evidence, `${fixture.name}-failure.png`), fullPage: true });
      await writeFile(join(evidence, `${fixture.name}-failure.txt`), `${String(error)}\n${await page.locator('body').innerText()}`);
      throw error;
    } finally {
      await context.tracing.stop({ path: join(evidence, `${fixture.name}-trace.zip`) });
      await context.close();
    }
  }
  await writeFile(join(evidence, 'acceptance.json'), JSON.stringify({ scope: 'Built UI + New API + DSH, external model/GitHub fixtures; Chromium mobile emulation, not physical Android or production OAuth.', results }, null, 2));
  console.log(`Browser acceptance passed for ${results.map(result => result.viewport).join(', ')}.`);
} finally {
  await browser.close();
}
