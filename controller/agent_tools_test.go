package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestParseBingSearchRSSBoundsAndSanitizesResults(t *testing.T) {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
	<item><title>Rust &amp; WebAssembly</title><link>https://rustcc.cn/topic/1</link><description><![CDATA[<b>Local</b> Rust tools &amp; examples]]></description></item>
	<item><title>Unsafe result</title><link>javascript:alert(1)</link><description>must be ignored</description></item>
	<item><title>GitHub CLI</title><link>https://github.com/cli/cli</link><description>Second result</description></item>
</channel></rss>`

	items, err := parseBingSearchRSS([]byte(body), 1)
	if err != nil {
		t.Fatalf("parseBingSearchRSS returned an error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected one bounded result, got %d", len(items))
	}
	if items[0].Title != "Rust & WebAssembly" {
		t.Fatalf("unexpected title: %q", items[0].Title)
	}
	if items[0].URL != "https://rustcc.cn/topic/1" || items[0].Source != "rustcc.cn" {
		t.Fatalf("unexpected source URL: %#v", items[0])
	}
	if !strings.Contains(items[0].Snippet, "Local Rust tools & examples") || strings.Contains(items[0].Snippet, "<b>") {
		t.Fatalf("snippet was not converted to plain text: %q", items[0].Snippet)
	}
}

func TestParseBingSearchRSSSkipsUnsafeURLs(t *testing.T) {
	body := `<rss><channel><item><title>Unsafe</title><link>javascript:alert(1)</link></item></channel></rss>`
	items, err := parseBingSearchRSS([]byte(body), 5)
	if err != nil {
		t.Fatalf("parseBingSearchRSS returned an error: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected unsafe URL to be omitted, got %#v", items)
	}
}

func TestSearchSearXNGUsesConfiguredJSONEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") != "rustcc site:rustcc.cn" || r.URL.Query().Get("format") != "json" {
			t.Errorf("unexpected SearXNG query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]string{{
				"title":   "RustCC",
				"url":     "https://rustcc.cn/",
				"content": "Rust community",
			}},
		})
	}))
	defer server.Close()

	items, err := searchSearXNG(context.Background(), server.URL+"/search", "rustcc site:rustcc.cn", 5)
	if err != nil {
		t.Fatalf("searchSearXNG returned an error: %v", err)
	}
	if len(items) != 1 || items[0].Source != "rustcc.cn" || items[0].Title != "RustCC" {
		t.Fatalf("unexpected SearXNG results: %#v", items)
	}
}

func TestSearchSearXNGRejectsNonHTTPSEndpoints(t *testing.T) {
	if _, err := searchSearXNG(context.Background(), "file:///etc/passwd", "query", 1); err == nil {
		t.Fatal("expected a non-HTTP endpoint to be rejected")
	}
}

func TestFetchAgentSearchResponseBlocksUnlistedRedirectHost(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("result"))
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer source.Close()

	if _, err := fetchAgentSearchResponse(context.Background(), source.URL, "application/json"); err == nil {
		t.Fatal("expected cross-host redirect to be blocked")
	}
}

func TestFetchAgentSearchResponseAllowsExplicitRedirectHost(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("result"))
	}))
	defer destination.Close()
	destinationURL, err := url.Parse(destination.URL)
	if err != nil {
		t.Fatalf("parse destination URL: %v", err)
	}
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer source.Close()

	body, err := fetchAgentSearchResponse(context.Background(), source.URL, "application/json", destinationURL.Host)
	if err != nil {
		t.Fatalf("expected explicitly allowed regional redirect: %v", err)
	}
	if string(body) != "result" {
		t.Fatalf("unexpected response body: %q", body)
	}
}
