/** Actual mobile-emulated UI and real DSH model, with only synthetic user data. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const origin = process.argv[2];
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const root = process.env.LAIN42_COMPOSITION_DSH_ROOT;
const evidence = process.env.LAIN42_PROTOTYPE_EVIDENCE_DIR;
assert.ok(root && evidence, 'Actions runtime and evidence paths are required.');
assert.equal(process.env.LAIN42_PROTOTYPE_NVIDIA_KEY, undefined,
  'The browser driver must not inherit the provider credential.');
const require = createRequire(join(root, 'apps/web/package.json'));
const { chromium, devices } = require('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US' });
const page = await context.newPage();
const posts = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
});
try {
  await page.goto(`${origin}/sign-in?redirect=%2Fagent`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username or Email', { exact: true }).fill('prototype-owner');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-prototype-browser-password');
  await Promise.all([
    page.waitForURL(url => url.pathname !== '/sign-in', { timeout: 30000 }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.goto(`${origin}/agent`, { waitUntil: 'domcontentloaded' });
  const input = page.getByPlaceholder('Ask anything', { exact: true });
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'mobile-note.txt', mimeType: 'text/plain',
    buffer: Buffer.from('CLIENT_MOBILE_NOTE_638: the delivery color is coral.'),
  });
  // Neither required fact appears in the user's instruction or filename. The
  // assistant locator below cannot pass merely by finding the user's bubble.
  await input.fill('Read my attached note. Give its exact marker and delivery color in one sentence.');
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent/dsh/turns', { timeout: 65000 }),
    page.getByRole('button', { name: 'Send', exact: true }).click(),
  ]);
  assert.equal(response.status(), 200, 'Actual hosted model turn must succeed.');
  const answer = (await response.json()).data.answer;
  assert.match(answer, /CLIENT_MOBILE_NOTE_638/);
  assert.match(answer, /coral/i);
  const assistant = page.locator('.is-assistant').filter({ hasText: 'CLIENT_MOBILE_NOTE_638' });
  await assistant.waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await assistant.innerText(), /coral/i);
  assert.equal(posts.filter(path => path === '/api/agent/dsh/turns').length, 1);
  assert.equal(posts.some(path => /^\/(?:pg|v1)\/(?:chat\/completions|responses)$/.test(path)), false,
    'The mobile browser must use DSH, not direct inference.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await assistant.waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await assistant.innerText(), /coral/i);
  assert.equal(posts.filter(path => path === '/api/agent/dsh/turns').length, 1,
    'Reload must preserve the real answer without resubmission.');
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(layout.scroll <= layout.width + 1, 'Mobile page must fit its viewport.');
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  await page.screenshot({ path: join(evidence, 'mobile-real-model.png'), fullPage: true });
  console.log('Actual mobile-emulated login, attachment, DSH answer and reload passed.');
} finally {
  // No trace, cookie, network body, private credential or actual user file is
  // exported. The sole screenshot contains the declared synthetic conversation.
  await context.close();
  await browser.close();
}
