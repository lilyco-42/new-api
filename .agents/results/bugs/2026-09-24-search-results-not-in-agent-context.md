# Search results and pasted URLs were disconnected from Agent context

**Date:** 2026-09-24
**Severity:** Medium
**Status:** Fix implemented; GitHub Actions verification pending

## Problem

The Agent workspace reused the Playground globe search control. It sent text to `/api/agent/search` and displayed links in a popover, but there was no action to add the results to the chat draft. Entering `deepseek.com` searched for that string instead of asking the Agent to read the page. Pasting a URL into chat also did not reliably expose `web.fetch` unless the message included a read/summarize verb.

## Root cause

The search popover and the Agent's client-side `web.search` / `web.fetch` tools were separate paths. The popover's results remained component state, never becoming a chat message. Tool routing hid `web.fetch` for a URL-only message even though the browser crawler and approval flow already existed.

## Fix

- A URL or bare domain entered in the search popover is added to the chat draft as a page-reading request.
- Search results can be added to the chat draft with their title, HTTPS source URL, and bounded snippet; the user sends them to the model explicitly.
- A URL or bare domain in chat makes `web.fetch` available, unless the user explicitly declines page reading.
- Browser page-read failures become tool results so the model can explain CORS/network limits instead of failing the entire turn.
- The Agent prompt and research panel now explain the distinction between searching, reading a URL, and sending results to the model.

## Regression coverage

- URL-only and bare-domain routing expose `web.fetch`; a declined page read does not.
- URL normalization, safe result formatting, and the search popover's URL/results handoff are covered.
- A browser fetch error is returned to the tool loop as a readable result.

## Verification

Local builds and tests are intentionally not run. The user requires GitHub Actions for builds and tests; verification will be recorded after the branch workflow completes.
