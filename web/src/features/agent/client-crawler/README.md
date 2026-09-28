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
  from the browser. Auto routing uses GitHub/Hugging Face for technical
  discovery and includes OpenAlex only when the query explicitly asks for
  papers or research; callers can select one index or all supported indexes.
  OpenAlex results also need lexical overlap with the query before they are
  shown. Explicit broad web searches use the configured Lain42 search provider
  and send it only the search query. RustCC, CodeReset, GHFind, blogs, and
  forums have no dedicated adapters; broad web search can still find public
  pages on those sites. Each source normalizes results to title, URL, snippet,
  and source, and partial source failures do not discard successful results.
- Page fetches and crawling stay in the browser when possible. Search results
  are returned to the Agent conversation for the selected model. The configured
  search provider does not receive connected-account credentials or browser
  cookies.

Browser `fetch` is subject to the target site's CORS policy. WebAssembly does
not bypass that policy; the browser host provides network access to the module.
Sites that deny cross-origin reads need a user-installed browser extension or
another explicitly user-owned runtime. They must not be routed through a shared
personal device.

To build the browser WASM modules, run `bun run build:agent-wasm` from
`web/` with LLVM `clang` and `wasm-ld` on `PATH`. This builds the checked-in
`crawler_core.wasm` from `crawler_core.c` and the generated
`binary_analyzer.wasm` from `src/lib/client-binary/binary_analyzer.c`. Both
modules have no network, filesystem, or cookie imports. The binary analyzer
reads at most a 64 KiB prefix and returns metadata only; it never returns file
bytes. Normal development, build, and test scripts build both modules first.
