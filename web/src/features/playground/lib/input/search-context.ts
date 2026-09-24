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
export type BrowserSearchResult = {
  title: string
  url: string
  snippet?: string
}

/** Find explicit public-page URLs in chat text, including a bare domain. */
export function containsPublicPageUrlReference(value: string): boolean {
  const candidates = value.match(
    /https:\/\/[^\s<>"'`]+|(?:^|\s)(?:www\.)?(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/giu
  )
  return (
    candidates?.some((candidate) =>
      normalizePublicPageUrlInput(
        candidate.trim().replace(/^[^a-z\d]+|[.,;!?)}\]]+$/giu, '')
      )
    ) ?? false
  )
}

/**
 * Treat an HTTPS URL or a bare public-looking domain as a page-reading request.
 */
export function normalizePublicPageUrlInput(value: string): string | null {
  const input = value.trim()
  if (!input || /\s/u.test(input)) return null

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(input)
  if (hasScheme && !/^https:\/\//iu.test(input)) return null
  if (
    !hasScheme &&
    !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/iu.test(
      input
    )
  ) {
    return null
  }

  try {
    const url = new URL(hasScheme ? input : `https://${input}`)
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443')
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Serialize bounded search snippets as source context the user can send to the
 * model.
 */
export function formatSearchResultsForPrompt(
  query: string,
  results: BrowserSearchResult[]
): string {
  const lines = [`Browser search results for: ${query.trim().slice(0, 200)}`]
  const entries = results.slice(0, 6).flatMap((result) => {
    const title = result.title.trim().slice(0, 240)
    if (!title) return []

    let url: URL
    try {
      url = new URL(result.url)
    } catch {
      return []
    }
    if (url.protocol !== 'https:' || url.username || url.password) return []

    const snippet = result.snippet?.trim().slice(0, 600)
    return [
      `- ${title}\n  Source: ${url.toString()}${snippet ? `\n  ${snippet}` : ''}`,
    ]
  })
  if (entries.length === 0) lines.push('No safe source results were available.')
  else lines.push(...entries)
  return lines.join('\n\n')
}
