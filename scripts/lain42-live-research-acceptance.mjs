/** Actual mobile UI, public sources, client WASM parsing and real DSH answers. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const origin = process.argv[2];
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const root = process.env.LAIN42_COMPOSITION_DSH_ROOT;
const evidence = process.env.LAIN42_PROTOTYPE_EVIDENCE_DIR;
const documentURL = process.env.LAIN42_RESEARCH_DOCUMENT_URL;
assert.ok(root && evidence);
assert.match(documentURL ?? '', /^https:\/\/raw\.githubusercontent\.com\/lilyco-42\/new-api\/[0-9a-f]{40}\/testdata\/lain42-browser-research\.html$/);
assert.equal(process.env.LAIN42_PROTOTYPE_NVIDIA_KEY, undefined);
const require = createRequire(join(root, 'apps/web/package.json'));
const { chromium, devices } = require('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-US', reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
const turns = [];
let publicSearchResponse = false;
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  const url = new URL(response.url());
  if (url.hostname === 'api.github.com' && url.pathname === '/search/repositories' && response.status() === 200) {
    const headers = response.request().headers();
    assert.equal(headers.authorization, undefined, 'Public client search must omit connected-account credentials.');
    assert.equal(headers.cookie, undefined);
    publicSearchResponse = true;
  }
});
page.on('request', request => {
  const url = new URL(request.url());
  if (url.origin !== origin || request.method() !== 'POST') return;
  assert.equal(/^\/(?:pg|v1)\/(?:chat\/completions|responses)$/.test(url.pathname), false,
    'The browser must use DSH, not direct inference.');
  if (url.pathname === '/api/agent/dsh/turns') {
    const { text } = request.postDataJSON();
    turns.push({ pageEvidence: text.includes('WASM_PAGE_FACT_824'),
      scriptOmitted: !text.includes('SCRIPT_NONCONTENT_559'),
      searchEvidence: text.includes('https://github.com/ast-grep/ast-grep') });
  }
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
  async function send(text) {
    await input.fill(text);
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent/dsh/turns', { timeout: 65000 }),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    assert.equal(response.status(), 200, 'Actual research turn must succeed.');
    const answer = (await response.json()).data.answer;
    assert.equal(typeof answer, 'string');
    assert.ok(answer.length);
    return answer;
  }
  const searchAnswer = await send('请用网页搜索查 GitHub 上 ast-grep 的官方仓库，给出仓库名称、用途和来源链接。不要搜索我的个人仓库，不要调用本地 CLI 或设备。');
  assert.match(searchAnswer, /https:\/\/github\.com\/ast-grep\/ast-grep/);
  assert.equal(publicSearchResponse, true, 'The actual browser must obtain public search data.');
  assert.equal(turns[0].searchEvidence, true, 'Search data must enter the same hosted turn.');
  await page.locator('.is-assistant').filter({ hasText: 'https://github.com/ast-grep/ast-grep' }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(evidence, 'mobile-public-search.png'), fullPage: true, animations: 'disabled' });

  let approvals = 0;
  page.on('dialog', async dialog => {
    assert.equal(dialog.type(), 'confirm');
    assert.match(dialog.message(), /^Read 1 public page\(s\) from raw\.githubusercontent\.com using this device's network\?/);
    approvals += 1;
    await dialog.accept();
  });
  const pageResponse = page.waitForResponse(response => response.url() === documentURL, { timeout: 25000 });
  const wasmResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/agent/crawler_core.wasm', { timeout: 25000 });
  const pageAnswer = await send(`New task: read this public page ${documentURL} and tell me its exact diagnostic marker, delivery color and revision rule. Cite the page URL. Do not search or revisit the ast-grep task.`);
  const [fetched, wasm] = await Promise.all([pageResponse, wasmResponse]);
  assert.equal(fetched.status(), 200, 'Actual anonymous public HTTPS page read must succeed.');
  assert.equal(fetched.request().headers().authorization, undefined);
  assert.equal(fetched.request().headers().cookie, undefined);
  assert.equal(wasm.status(), 200, 'The actual deployed WASM module must load.');
  assert.deepEqual([...new Uint8Array(await wasm.body()).slice(0, 4)], [0, 97, 115, 109]);
  assert.equal(approvals, 1, 'Only the requested page should be approved.');
  assert.equal(turns[1].pageEvidence, true);
  assert.equal(turns[1].scriptOmitted, true, 'Non-content script must not enter model input.');
  assert.match(pageAnswer, /WASM_PAGE_FACT_824/);
  assert.match(pageAnswer, /teal/i);
  assert.match(pageAnswer, /revision/i);
  assert.ok(pageAnswer.includes(documentURL));
  const assistant = page.locator('.is-assistant').filter({ hasText: 'WASM_PAGE_FACT_824' });
  await assistant.waitFor({ timeout: 15000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await assistant.waitFor({ timeout: 15000 });
  assert.equal(turns.length, 2, 'Reload must not repeat inference.');
  const followup = await send('From the page you just read, what was the delivery color? Reply with that color only.');
  assert.equal(followup.trim().toLowerCase(), 'teal');
  assert.equal(turns.length, 3);
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(layout.scroll <= layout.width + 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, 'mobile-wasm-page.png'), fullPage: true, animations: 'disabled' });
  console.log('Real mobile public search, approved client WASM page read, sourced answers, reload and follow-up passed.');
} finally {
  // Only synthetic screenshots are exported; no traces, credentials or bodies.
  await context.close();
  await browser.close();
}
