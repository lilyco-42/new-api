# Browser-side search and crawling

The Agent's public-source search and page reader run on the user's device. The
web tool names and argument schemas remain the Agent-facing contract; this
folder contains the browser runtime behind those tools.

- `client-crawler.ts` performs bounded HTTPS reads with `credentials: omit`,
  refuses redirects, then sends the response bytes through `crawler_core.wasm`
  for text extraction.
- `web.crawl` follows only same-origin links, reads at most five pages, and
  stops after bounded response and text sizes. Page reads require explicit
  confirmation because extracted text is included in the selected model's
  conversation.
- `web.search` calls public GitHub, Hugging Face, and OpenAlex APIs directly
  from the browser. Each source adapter normalizes results to title, URL,
  snippet, and source, and partial source failures do not discard successful
  results.
- No page fetch or search query is proxied through the Lain42 server. The
  extracted text is returned to the Agent conversation for the selected model.

Browser `fetch` is subject to the target site's CORS policy. WebAssembly does
not bypass that policy; the browser host provides network access to the module.
Sites that deny cross-origin reads need a user-installed browser extension or
another explicitly user-owned runtime. They must not be routed through a shared
personal device.

To rebuild the checked-in WASM module, run `bun run build:agent-crawler-wasm`
from `web/` with LLVM `clang` and `wasm-ld` on `PATH`. The source is
`crawler_core.c`; the module has no network, filesystem, or cookie imports.
