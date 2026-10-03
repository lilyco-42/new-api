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
const hostedRequests = [];
let currentAuthorization;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.origin !== origin) return;
  // Real sign-in supplies this synthetic account's JWT. Retain it only in
  // memory for adversarial API probes; never inject UI auth or export it.
  const authorization = request.headers().authorization;
  if (url.pathname.startsWith('/api/') && authorization) currentAuthorization = authorization;
  if (request.method() !== 'POST') return;
  posts.push(url.pathname);
  if (url.pathname === '/api/agent/dsh/turns') {
    const { session_id, request_id, model } = request.postDataJSON();
    hostedRequests.push({ session_id, request_id, model });
  }
});
async function signIn(username) {
  currentAuthorization = undefined;
  await page.goto(`${origin}/sign-in?redirect=%2Fagent`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username or Email', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-prototype-browser-password');
  await Promise.all([
    page.waitForURL(url => url.pathname !== '/sign-in', { timeout: 30000 }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.goto(`${origin}/agent`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask anything', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
}
async function signOut() {
  await page.goto(`${origin}/profile`, { waitUntil: 'domcontentloaded' });
  // Both declared prototype usernames use the application's "P" fallback.
  await page.getByRole('button', { name: 'P', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await Promise.all([
    page.waitForURL(url => url.pathname === '/sign-in', { timeout: 30000 }),
    page.getByRole('alertdialog', { name: 'Sign out', exact: true })
      .getByRole('button', { name: 'Sign out', exact: true }).click(),
  ]);
}
try {
  await signIn('prototype-owner');
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
  assert.equal(hostedRequests.length, 1);
  const original = hostedRequests[0];
  assert.match(original.session_id, /^[A-Za-z0-9]{64}$/);
  assert.match(original.request_id, /^[0-9a-f-]{36}$/);

  // Same mobile cookie/storage context, with actual UI logout and login.
  // B must neither inherit A's visible history nor obtain/cancel its request.
  await signOut();
  await signIn('prototype-other');
  assert.ok(currentAuthorization?.startsWith('Bearer '), 'B must have its own actual signed-in credential.');
  const headers = { Authorization: currentAuthorization };
  const self = await context.request.get(`${origin}/api/user/self`, { headers });
  assert.equal(self.status(), 200);
  assert.equal((await self.json()).data.username, 'prototype-other');
  assert.equal(await page.locator('.is-assistant').count(), 0, 'B must have an empty conversation.');
  assert.equal(await page.getByText('CLIENT_MOBILE_NOTE_638', { exact: false }).count(), 0,
    'A attachment/answer must not appear for B.');
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Lain42 Agent', exact: true })
    .getByText('No saved conversations yet', { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(evidence, 'mobile-account-b.png'), fullPage: true });
  for (const probe of [
    { path: '/api/agent/dsh/turns', data: { ...original, text: 'Read the original response for this request.' } },
    { path: '/api/agent/dsh/turns/cancel', data: { session_id: original.session_id, request_id: original.request_id } },
  ]) {
    const denied = await context.request.post(`${origin}${probe.path}`, { headers, data: probe.data });
    assert.equal(denied.status(), 404, 'B must be rejected before DSH or inference.');
    const body = await denied.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AGENT_DSH_SESSION_NOT_FOUND');
    assert.equal(body.data, undefined, 'Foreign answer must not be returned.');
  }
  await signOut();
  await signIn('prototype-owner');
  await assistant.waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await assistant.innerText(), /coral/i);
  assert.equal(hostedRequests.length, 1, 'Account switching must not replay the original model turn.');
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(layout.scroll <= layout.width + 1, 'Mobile page must fit its viewport.');
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  await page.screenshot({ path: join(evidence, 'mobile-real-model.png'), fullPage: true });
  console.log('Actual mobile-emulated login, attachment, answer/reload, account history switch and foreign turn/cancel denial passed.');
} finally {
  currentAuthorization = undefined;
  // No trace, cookie, network body, private credential or actual user file is
  // exported. The sole screenshot contains the declared synthetic conversation.
  await context.close();
  await browser.close();
}
