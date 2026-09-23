/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export type ClientSearchResult = {
  title: string
  url: string
  snippet?: string
  source: string
}

export type ClientPageResult = {
  title: string
  url: string
  text: string
  fetched_at: string
  links: string[]
}

export type ClientSearchResponse = {
  execution: 'browser-wasm'
  query: string
  fetched_at: string
  sources: string[]
  warnings: string[]
  items: ClientSearchResult[]
}

export type ClientSearchScope =
  | 'auto'
  | 'github'
  | 'huggingface'
  | 'papers'
  | 'all'

export type ClientCrawlResponse = {
  execution: 'browser-wasm'
  start_url: string
  query: string
  fetched_at: string
  pages: Array<{
    title: string
    url: string
    excerpt: string
    matched_terms: string[]
  }>
  warnings: string[]
}

type CrawlerCore = {
  memory: WebAssembly.Memory
  extract_html_text: (
    inputPointer: number,
    inputLength: number,
    outputPointer: number,
    outputCapacity: number
  ) => number
}

type GitHubRepository = {
  full_name?: string
  html_url?: string
  description?: string | null
  stargazers_count?: number
  updated_at?: string
}

type HuggingFaceModel = {
  modelId?: string
  id?: string
  pipeline_tag?: string
  downloads?: number
  likes?: number
}

type OpenAlexWork = {
  id?: string
  doi?: string | null
  title?: string | null
  publication_year?: number | null
  cited_by_count?: number
  primary_location?: { landing_page_url?: string | null } | null
}

const MAX_PAGE_BYTES = 1024 * 1024
const MAX_SEARCH_RESPONSE_BYTES = 512 * 1024
const MAX_PAGE_TEXT = 12_000
const PAGE_TIMEOUT_MS = 10_000
const MAX_CRAWL_PAGES = 5
const CRAWLER_WASM_URL = '/agent/crawler_core.wasm'
const OPENALEX_QUERY_STOP_WORDS = new Set([
  'about',
  'academic',
  'article',
  'articles',
  'find',
  'from',
  'into',
  'latest',
  'literature',
  'paper',
  'papers',
  'please',
  'research',
  'search',
  'scholarly',
  'study',
  'studies',
  'the',
  'this',
  'using',
  'with',
])

let crawlerCorePromise: Promise<CrawlerCore> | undefined

function safePublicHttpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('URL must be an absolute public HTTPS address.')
  }
  const host = url.hostname
    .toLowerCase()
    .replaceAll(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.onion') ||
    host.includes(':') ||
    /^[\d.]+$/.test(host)
  ) {
    throw new Error('Only public HTTPS pages on the default port can be read.')
  }
  url.hash = ''
  return url
}

async function fetchWithTimeout(
  url: URL,
  signal: AbortSignal,
  accept: string,
  cache: RequestCache = 'default'
): Promise<Response> {
  if (signal.aborted) {
    throw new DOMException('The request was cancelled.', 'AbortError')
  }
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('Request timed out.')),
    PAGE_TIMEOUT_MS
  )
  try {
    return await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache,
      headers: { Accept: accept },
      signal: controller.signal,
    })
  } catch {
    if (signal.aborted) {
      throw new DOMException('The request was cancelled.', 'AbortError')
    }
    if (controller.signal.aborted) {
      throw new Error(`Reading ${url.hostname} timed out.`)
    }
    throw new Error(
      `The browser could not read ${url.hostname}. The site may block cross-origin access (CORS); the page was not fetched through the Lain42 server.`
    )
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', forwardAbort)
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('The page is larger than the client-side read limit.')
  }
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error('The page is larger than the client-side read limit.')
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new Error('The page is larger than the client-side read limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

async function loadCrawlerCore(): Promise<CrawlerCore> {
  crawlerCorePromise ??= (async () => {
    const response = await fetch(CRAWLER_WASM_URL, {
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!response.ok) {
      throw new Error('The browser-side WASM crawler could not load.')
    }
    const { instance } = await WebAssembly.instantiate(
      await response.arrayBuffer()
    )
    const exports = instance.exports as unknown as CrawlerCore
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.extract_html_text !== 'function'
    ) {
      throw new Error('The browser-side WASM crawler has an invalid module.')
    }
    return exports
  })().catch((error: unknown) => {
    crawlerCorePromise = undefined
    throw error
  })
  return crawlerCorePromise
}

export async function extractHtmlTextWasm(html: string): Promise<string> {
  const core = await loadCrawlerCore()
  const input = new TextEncoder().encode(html)
  const inputPointer = 1024
  const outputPointer = Math.ceil((inputPointer + input.byteLength + 8) / 8) * 8
  const outputCapacity = Math.min(
    MAX_PAGE_BYTES,
    Math.max(1024, input.byteLength)
  )
  const requiredBytes = outputPointer + outputCapacity
  const missingBytes = requiredBytes - core.memory.buffer.byteLength
  if (missingBytes > 0) core.memory.grow(Math.ceil(missingBytes / 65_536))
  const memory = new Uint8Array(core.memory.buffer)
  memory.set(input, inputPointer)
  const outputLength = core.extract_html_text(
    inputPointer,
    input.byteLength,
    outputPointer,
    outputCapacity
  )
  const text = new TextDecoder('utf-8').decode(
    memory.slice(outputPointer, outputPointer + outputLength)
  )
  return text.slice(0, MAX_PAGE_TEXT)
}

function readDocumentMetadata(
  html: string,
  baseUrl: URL
): {
  title: string
  links: string[]
} {
  if (typeof DOMParser === 'undefined') {
    return { title: baseUrl.hostname, links: [] }
  }
  const document = new DOMParser().parseFromString(html, 'text/html')
  const title =
    document.querySelector('title')?.textContent?.trim() || baseUrl.hostname
  const links = [...document.querySelectorAll('a[href]')]
    .map((anchor) => {
      try {
        const target = safePublicHttpsUrl(
          new URL(anchor.getAttribute('href') || '', baseUrl).toString()
        )
        return target.origin === baseUrl.origin ? target.toString() : undefined
      } catch {
        return undefined
      }
    })
    .filter((link): link is string => Boolean(link))
  return { title, links: [...new Set(links)] }
}

export async function fetchClientPage(
  rawUrl: string,
  signal: AbortSignal
): Promise<ClientPageResult> {
  const requestedUrl = safePublicHttpsUrl(rawUrl)
  const response = await fetchWithTimeout(
    requestedUrl,
    signal,
    'text/html, text/plain, application/xhtml+xml, application/xml, text/xml'
  )
  if (!response.ok) {
    throw new Error(`The page returned HTTP ${response.status}.`)
  }
  const finalUrl = safePublicHttpsUrl(response.url || requestedUrl.toString())
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (
    !contentType.includes('text/html') &&
    !contentType.includes('text/plain') &&
    !contentType.includes('application/xhtml+xml') &&
    !contentType.includes('application/xml') &&
    !contentType.includes('text/xml')
  ) {
    throw new Error(
      'Only public text and HTML pages are supported by this crawler.'
    )
  }
  const html = await readBoundedText(response, MAX_PAGE_BYTES)
  const { title, links } = readDocumentMetadata(html, finalUrl)
  return {
    title,
    url: finalUrl.toString(),
    text: await extractHtmlTextWasm(html),
    fetched_at: new Date().toISOString(),
    links,
  }
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []),
  ].slice(0, 8)
}

function excerptFor(text: string, terms: string[], limit: number): string {
  if (text.length <= limit) return text
  const lowerText = text.toLowerCase()
  const firstMatch = terms
    .map((term) => lowerText.indexOf(term))
    .filter((offset) => offset >= 0)
    .sort((left, right) => left - right)[0]
  const start =
    firstMatch === undefined
      ? 0
      : Math.max(0, firstMatch - Math.floor(limit / 4))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + limit)}${start + limit < text.length ? '…' : ''}`
}

export async function crawlClientSite(
  rawUrl: string,
  query: string,
  requestedPageLimit: number,
  signal: AbortSignal
): Promise<ClientCrawlResponse> {
  const startUrl = safePublicHttpsUrl(rawUrl)
  const pageLimit = Math.max(1, Math.min(MAX_CRAWL_PAGES, requestedPageLimit))
  const terms = queryTerms(query)
  const queue = [startUrl.toString()]
  const visited = new Set<string>()
  const pages: ClientCrawlResponse['pages'] = []
  const warnings: string[] = []
  let totalTextLength = 0

  while (
    queue.length > 0 &&
    visited.size < pageLimit &&
    totalTextLength < 36_000
  ) {
    if (signal.aborted) {
      throw new DOMException('The crawl was cancelled.', 'AbortError')
    }
    const nextUrl = queue.shift()
    if (!nextUrl) continue
    if (visited.has(nextUrl)) continue
    visited.add(nextUrl)
    try {
      const page = await fetchClientPage(nextUrl, signal)
      const lowerText = page.text.toLowerCase()
      const matchedTerms = terms.filter((term) => lowerText.includes(term))
      pages.push({
        title: page.title,
        url: page.url,
        excerpt: excerptFor(page.text, terms, 1_200),
        matched_terms: matchedTerms,
      })
      totalTextLength += page.text.length
      for (const link of page.links) {
        if (
          !visited.has(link) &&
          !queue.includes(link) &&
          visited.size + queue.length < 20
        ) {
          queue.push(link)
        }
      }
    } catch (error) {
      if (visited.size === 1) throw error
      warnings.push(
        `${nextUrl}: ${error instanceof Error ? error.message : 'read failed'}`
      )
    }
  }

  return {
    execution: 'browser-wasm',
    start_url: startUrl.toString(),
    query,
    fetched_at: new Date().toISOString(),
    pages,
    warnings: warnings.slice(0, 5),
  }
}

async function fetchJson<T>(url: URL, signal: AbortSignal): Promise<T> {
  const response = await fetchWithTimeout(
    url,
    signal,
    'application/json, application/vnd.github+json'
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (
    !contentType.includes('application/json') &&
    !contentType.includes('application/vnd.github+json')
  ) {
    throw new Error('The public source returned a non-JSON response.')
  }
  return JSON.parse(
    await readBoundedText(response, MAX_SEARCH_RESPONSE_BYTES)
  ) as T
}

async function searchGitHub(query: string, limit: number, signal: AbortSignal) {
  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('sort', 'stars')
  url.searchParams.set('order', 'desc')
  url.searchParams.set('per_page', String(limit))
  const response = await fetchJson<{ items?: GitHubRepository[] }>(url, signal)
  return (response.items || []).map((repo) => ({
    title: repo.full_name || 'GitHub repository',
    url: repo.html_url || '',
    snippet: [
      repo.description,
      typeof repo.stargazers_count === 'number'
        ? `${repo.stargazers_count} stars`
        : '',
      repo.updated_at ? `updated ${repo.updated_at}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    source: 'GitHub',
  }))
}

async function searchHuggingFace(
  query: string,
  limit: number,
  signal: AbortSignal
) {
  const url = new URL('https://huggingface.co/api/models')
  url.searchParams.set('search', query)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('sort', 'downloads')
  const response = await fetchJson<HuggingFaceModel[]>(url, signal)
  return response.map((model) => {
    const modelId = model.modelId || model.id || 'Hugging Face model'
    const encodedPath = modelId.split('/').map(encodeURIComponent).join('/')
    return {
      title: modelId,
      url: `https://huggingface.co/${encodedPath}`,
      snippet: [
        model.pipeline_tag,
        typeof model.downloads === 'number'
          ? `${model.downloads} downloads`
          : '',
        typeof model.likes === 'number' ? `${model.likes} likes` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      source: 'Hugging Face',
    }
  })
}

async function searchOpenAlex(
  query: string,
  limit: number,
  signal: AbortSignal
) {
  const url = new URL('https://api.openalex.org/works')
  url.searchParams.set('search', query)
  url.searchParams.set('per-page', String(limit))
  url.searchParams.set(
    'select',
    'id,doi,title,publication_year,cited_by_count,primary_location'
  )
  const response = await fetchJson<{ results?: OpenAlexWork[] }>(url, signal)
  return (response.results || []).map((work) => ({
    title: work.title || 'Research work',
    url:
      work.primary_location?.landing_page_url ||
      work.doi ||
      work.id ||
      'https://openalex.org',
    snippet: [
      work.publication_year,
      typeof work.cited_by_count === 'number'
        ? `${work.cited_by_count} citations`
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    source: 'OpenAlex',
  }))
}

export async function searchClientSources(
  rawQuery: string,
  requestedLimit: number,
  signal: AbortSignal,
  requestedScope: ClientSearchScope = 'auto'
): Promise<ClientSearchResponse> {
  const query = rawQuery.trim()
  const limit = Math.max(1, Math.min(8, requestedLimit))
  const wantsPapers =
    /\b(?:papers?|research|stud(?:y|ies)|academic|scholarly|arxiv|doi|literature|citations?)\b|论文|研究|学术|预印本|引用/iu.test(
      query
    )
  const wantsGitHub =
    /\b(?:github|repos?|repositories|issues?|pull requests?|trending|projects?|code|source code|open source|stars?)\b|仓库|代码|项目|开源|议题|拉取请求/iu.test(
      query
    )
  const wantsHuggingFace =
    /\b(?:hugging[ -]?face|hf|models?|datasets?|spaces?|checkpoints?|weights?)\b|模型|数据集|权重|模型卡/iu.test(
      query
    )
  const asksForWebsiteSearch =
    /\b(?:website|web site|site search|blog|news|forum|community|rustcc|code[ -]?reset|ghfind)\b|网页搜索|网站|官网|博客|新闻|论坛|社区/iu.test(
      query
    )
  const explicitlyNamesSupportedIndex =
    /\b(?:github|hugging[ -]?face|hf|openalex)\b/iu.test(query)

  let selectedNames: string[]
  switch (requestedScope) {
    case 'github':
      selectedNames = ['GitHub']
      break
    case 'huggingface':
      selectedNames = ['Hugging Face']
      break
    case 'papers':
      selectedNames = ['OpenAlex']
      break
    case 'all':
      selectedNames = ['GitHub', 'Hugging Face', 'OpenAlex']
      break
    default: {
      selectedNames = []
      if (asksForWebsiteSearch && !explicitlyNamesSupportedIndex) break
      if (wantsGitHub) selectedNames.push('GitHub')
      if (wantsHuggingFace) selectedNames.push('Hugging Face')
      if (wantsPapers) selectedNames.push('OpenAlex')
      if (selectedNames.length === 0 && !asksForWebsiteSearch) {
        // General technical discovery uses project/model indexes. Scholarly
        // search is opt-in so unrelated papers do not pollute ordinary queries.
        selectedNames = ['GitHub', 'Hugging Face']
      }
      break
    }
  }

  if (selectedNames.length === 0) {
    return {
      execution: 'browser-wasm',
      query,
      fetched_at: new Date().toISOString(),
      sources: [],
      warnings: [
        'This query targets general websites or community pages, which are not indexed by the available client search adapters. Provide a public HTTPS URL for the browser-side reader when the site allows CORS.',
      ],
      items: [],
    }
  }

  const perSourceLimit = Math.max(1, Math.ceil(limit / selectedNames.length))
  const adapters = {
    GitHub: () => searchGitHub(query, perSourceLimit, signal),
    'Hugging Face': () => searchHuggingFace(query, perSourceLimit, signal),
    OpenAlex: () => searchOpenAlex(query, perSourceLimit, signal),
  }
  const sources = selectedNames.map((name) => ({
    name,
    search: adapters[name as keyof typeof adapters],
  }))
  const results = await Promise.allSettled(
    sources.map((source) => source.search())
  )
  const items: ClientSearchResult[] = []
  const successfulSources: string[] = []
  const warnings: string[] = []
  results.forEach((result, index) => {
    const source = sources[index]
    if (result.status === 'fulfilled') {
      successfulSources.push(source.name)
      items.push(...result.value)
    } else {
      warnings.push(
        `${source.name}: ${result.reason instanceof Error ? result.reason.message : 'unavailable'}`
      )
    }
  })
  if (successfulSources.length === 0) {
    throw new Error(
      'Client search could not reach any public source. Check this device’s network; the search was not routed through the Lain42 server.'
    )
  }

  const queryTerms = [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
        (term) => term.length > 2 && !OPENALEX_QUERY_STOP_WORDS.has(term)
      )
    ),
  ]
  const matchText = (value: string) =>
    value.toLowerCase().replaceAll('asynchronous', 'async')
  const minOpenAlexMatches =
    queryTerms.length > 0 ? Math.min(2, Math.ceil(queryTerms.length / 2)) : 0
  const relevantItems = items.filter((item) => {
    if (item.source !== 'OpenAlex' || minOpenAlexMatches === 0) return true
    const searchableText = matchText(`${item.title} ${item.snippet || ''}`)
    const matchingTerms = queryTerms.filter((term) =>
      searchableText.includes(matchText(term))
    )
    return matchingTerms.length >= minOpenAlexMatches
  })
  const filteredOpenAlexCount = items.length - relevantItems.length
  if (filteredOpenAlexCount > 0) {
    warnings.push(
      `OpenAlex: filtered ${filteredOpenAlexCount} result(s) with weak query-term overlap.`
    )
  }

  return {
    execution: 'browser-wasm',
    query,
    fetched_at: new Date().toISOString(),
    sources: successfulSources,
    warnings: warnings.slice(0, 3),
    items: relevantItems.filter((item) => item.url).slice(0, limit),
  }
}
