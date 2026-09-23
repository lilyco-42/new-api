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
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  crawlClientSite,
  fetchClientPage,
  searchClientSources,
} from './client-crawler'

const wasmBytes = new Uint8Array(
  await readFile(path.resolve('public/agent/crawler_core.wasm'))
)
const wasmAssetPath = '/agent/crawler_core.wasm'

describe('client-side WASM crawler', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches a public page from the browser and extracts text in WASM', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === wasmAssetPath) return new Response(wasmBytes)
      return new Response(
        '<html><head><title>Guide &amp; Notes</title><script>secret()</script></head><body><h1>Rust</h1><p>Wasm &lt;native&gt;</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } }
      )
    })

    const page = await fetchClientPage(
      'https://docs.example.com/guide#install',
      new AbortController().signal
    )

    expect(page.title).toBe('Guide & Notes')
    expect(page.text).toBe('Guide & Notes\nRust\nWasm <native>')
    expect(page.url).toBe('https://docs.example.com/guide')
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://docs.example.com/guide'),
      expect.objectContaining({
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    )
  })

  it('uses a WASM parser with no network or host imports', () => {
    const module = new WebAssembly.Module(wasmBytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
  })

  it('crawls only same-origin links and stops at the requested page count', async () => {
    const pages = new Map([
      [
        'https://docs.example.com/',
        '<title>Index</title><p>Rust guide</p><a href="/one">one</a><a href="https://other.example.net/no">outside</a>',
      ],
      [
        'https://docs.example.com/one',
        '<title>One</title><p>WASM safety</p><a href="/two">two</a>',
      ],
      ['https://docs.example.com/two', '<title>Two</title><p>Rust memory</p>'],
    ])
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === wasmAssetPath) return new Response(wasmBytes)
      const html = pages.get(url)
      if (!html) throw new Error(`Unexpected request: ${url}`)
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    })

    const result = await crawlClientSite(
      'https://docs.example.com/',
      'Rust',
      2,
      new AbortController().signal
    )

    expect(result.execution).toBe('browser-wasm')
    expect(result.pages.map((page) => page.url)).toEqual([
      'https://docs.example.com/',
      'https://docs.example.com/one',
    ])
    expect(result.pages[0]?.matched_terms).toContain('rust')
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      'https://other.example.net/no'
    )
  })

  it('searches public indexes directly from the browser without sending cookies', async () => {
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        expect(init?.credentials).toBe('omit')
        if (url.hostname === 'api.github.com') {
          return Response.json({
            items: [
              {
                full_name: 'rust-lang/rust',
                html_url: 'https://github.com/rust-lang/rust',
                stargazers_count: 100,
              },
            ],
          })
        }
        if (url.hostname === 'huggingface.co') {
          return Response.json([
            { modelId: 'example/rust-model', downloads: 20 },
          ])
        }
        if (url.hostname === 'api.openalex.org') {
          return Response.json({
            results: [
              {
                title: 'Rust systems research',
                id: 'https://openalex.org/W1',
                publication_year: 2026,
              },
            ],
          })
        }
        throw new Error(`Unexpected source: ${url.hostname}`)
      }
    )

    const result = await searchClientSources(
      'rust',
      8,
      new AbortController().signal
    )

    expect(result.execution).toBe('browser-wasm')
    expect(result.sources).toEqual(['GitHub', 'Hugging Face', 'OpenAlex'])
    expect(result.items.map((item) => item.source)).toEqual([
      'GitHub',
      'Hugging Face',
      'OpenAlex',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects local-network targets before making a request', async () => {
    await expect(
      fetchClientPage('https://192.168.1.1/admin', new AbortController().signal)
    ).rejects.toThrow('Only public HTTPS pages')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports CORS blocks without falling back to a server-side fetch', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(
      fetchClientPage('https://rustcc.cn/', new AbortController().signal)
    ).rejects.toThrow('not fetched through the Lain42 server')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://rustcc.cn/')
  })
})
