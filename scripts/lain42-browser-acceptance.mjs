/** CI-only acceptance of the built New API Agent UI against real DSH/server routes. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const origin = process.argv[2];
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const dshRoot = process.env.LAIN42_COMPOSITION_DSH_ROOT;
assert.ok(dshRoot, 'The reviewed DSH checkout is required; never skip this gate.');
const modelFixture = process.env.LAIN42_BROWSER_MODEL_FIXTURE;
assert.match(modelFixture ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const require = createRequire(join(dshRoot, 'apps/web/package.json'));
const { chromium, devices } = require('playwright');
const evidence = resolve(process.env.LAIN42_BROWSER_EVIDENCE_DIR ?? '.agents/results/browser-acceptance');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function signIn(page, username) {
  await page.goto(`${origin}/sign-in?redirect=%2Fagent`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username or Email', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-password');
  await Promise.all([
    page.waitForURL(url => url.pathname !== '/sign-in', { timeout: 30000 }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.goto(`${origin}/agent`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask anything', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
}
async function signOut(page) {
  await page.goto(`${origin}/profile`, { waitUntil: 'domcontentloaded' });
  // The fixture usernames both render the existing avatar fallback "C".
  await page.getByRole('button', { name: 'C', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await Promise.all([
    page.waitForURL(url => url.pathname === '/sign-in', { timeout: 30000 }),
    page.getByRole('alertdialog', { name: 'Sign out', exact: true })
      .getByRole('button', { name: 'Sign out', exact: true }).click(),
  ]);
}
try {
  for (const fixture of [
    { name: 'desktop', username: 'composition-owner', context: { viewport: { width: 1365, height: 900 }, locale: 'en-US' } },
    { name: 'mobile', username: 'composition-other', context: { ...devices['Pixel 7'], locale: 'en-US' } },
  ]) {
    const context = await browser.newContext(fixture.context);
    const page = await context.newPage();
    const errors = [];
    const postedPaths = [];
    const hostedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      const path = new URL(request.url()).pathname;
      postedPaths.push(path);
      if (path === '/api/agent/dsh/turns') {
        const submitted = request.postDataJSON();
        // Observe only identities; do not retain credentials or attachment bodies.
        hostedRequests.push({ session: submitted.session_id, request: submitted.request_id });
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      // A user logs in through the actual form. No API response interception,
      // injected auth store or shared browser cookie is used.
      await signIn(page, fixture.username);
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
      // The shipped code viewer uses CodeMirror with an accessible textbox,
      // rather than a pre element. Verify its real language label and content.
      const rustCode = page.getByRole('textbox', { name: 'rust', exact: true });
      await rustCode.waitFor({ timeout: 15000 });
      assert.match(await rustCode.innerText(), /fn main\(\)/);
      assert.equal(await rustCode.getAttribute('aria-readonly'), 'true');
      assert.equal(postedPaths.filter(path => path === '/api/agent/dsh/turns').length, 1,
        'The attachment answer must come through the hosted DSH turn, not the legacy chat loop.');
      assert.equal(postedPaths.some(path => /^\/(?:pg|v1)\/(?:chat\/completions|responses)$/.test(path)), false,
        'The browser must not bypass DSH with direct model inference.');
      // The browser must preserve the current conversation after a real reload.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('The attached note contains CLIENT_FILE_FACT_42.', { exact: false }).waitFor({ timeout: 30000 });
      await input.fill('What does that Rust code print?');
      await send.click();
      await page.getByText('That Rust code prints CLIENT_FILE_FACT_42.', { exact: true }).waitFor({ timeout: 45000 });
      assert.equal(postedPaths.filter(path => path === '/api/agent/dsh/turns').length, 2,
        'The follow-up must reuse the hosted conversation after reload.');
      assert.equal(hostedRequests.length, 2);
      assert.match(hostedRequests[0].session, /^[A-Za-z0-9]{64}$/);
      assert.equal(hostedRequests[1].session, hostedRequests[0].session,
        'Reload must retain the actual hosted session, not rebuild context in a new one.');
      assert.notEqual(hostedRequests[1].request, hostedRequests[0].request,
        'A new user message must have its own request identity.');
      assert.equal(postedPaths.some(path => /^\/(?:pg|v1)\/(?:chat\/completions|responses)$/.test(path)), false,
        'Follow-up inference must also remain in the DSH conversation.');
      // Hold only the external provider, then actually navigate away from the
      // in-flight website request. No website response or auth is intercepted.
      await input.fill(`Recover this browser task for ${fixture.name}.`);
      await send.click();
      const started = await fetch(`${modelFixture}/fixture/browser/${fixture.name}/started`, {
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(started.status, 204, 'The original browser inference must start before navigation.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      const retry = page.getByRole('button', { name: 'Retry', exact: true });
      await retry.waitFor({ state: 'visible', timeout: 15000 });
      const released = await fetch(`${modelFixture}/fixture/browser/${fixture.name}/release`, {
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(released.status, 204);
      await retry.click();
      await page.getByText(`Recovered ${fixture.name} without another inference.`, { exact: true }).waitFor({ timeout: 45000 });
      assert.equal(hostedRequests.length, 4, 'Retry must use the hosted original request.');
      assert.equal(hostedRequests[3].session, hostedRequests[2].session,
        'Retry after navigation must retain the accepted session.');
      assert.equal(hostedRequests[3].request, hostedRequests[2].request,
        'Retry after navigation must retain the accepted request; do not infer or charge again.');
      assert.equal(postedPaths.includes('/api/agent/dsh/turns/cancel'), false,
        'Navigating away is not an explicit Stop.');
      if (fixture.name === 'desktop') {
        // Keep this same browser storage and cookie jar. Separate contexts alone
        // do not establish that signing out hides the previous user's history.
        await signOut(page);
        await signIn(page, 'composition-other');
        await page.getByText('No saved conversations yet', { exact: true }).waitFor({ timeout: 15000 });
        assert.equal(await page.getByText('Recovered desktop without another inference.', { exact: true }).count(), 0);
        assert.equal(await page.getByText('The attached note contains CLIENT_FILE_FACT_42.', { exact: false }).count(), 0);
        assert.equal(await page.getByRole('button', { name: /Recover this browser task for desktop/ }).count(), 0);
        await page.screenshot({ path: join(evidence, 'account-b-same-browser.png'), fullPage: true });
        await signOut(page);
        await signIn(page, 'composition-owner');
        await page.getByText('Recovered desktop without another inference.', { exact: true }).waitFor({ timeout: 15000 });
        assert.equal(hostedRequests.length, 4, 'Account switching must not replay any model request.');
      }
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(layout.scroll <= layout.width + 1, `Horizontal overflow at ${fixture.name}: ${JSON.stringify(layout)}`);
      assert.deepEqual(errors, [], 'Uncaught browser errors');
      await page.screenshot({ path: join(evidence, `${fixture.name}.png`), fullPage: true });
      results.push({ viewport: fixture.name, login: 'password + real session', hostedDSHTurn: true, attachmentAnswer: true, rustCode: true, reload: true, contextualFollowUp: true, interruptedTurnRetry: true, sameBrowserAccountSwitch: fixture.name === 'desktop', horizontalOverflow: false });
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
