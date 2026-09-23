package controller

import (
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

func TestValidateAgentFetchURL(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		wantErr bool
		wantURL string
	}{
		{name: "https page", value: "https://example.com/docs?q=rust#section", wantURL: "https://example.com/docs?q=rust"},
		{name: "http default port", value: "http://example.com:80/", wantURL: "http://example.com:80/"},
		{name: "file scheme", value: "file:///etc/passwd", wantErr: true},
		{name: "userinfo", value: "https://user:pass@example.com/", wantErr: true},
		{name: "loopback", value: "http://127.0.0.1/", wantErr: true},
		{name: "private address", value: "http://10.0.0.2/", wantErr: true},
		{name: "ipv6 loopback", value: "http://[::1]/", wantErr: true},
		{name: "non-default port", value: "https://example.com:8443/", wantErr: true},
		{name: "trailing dot", value: "https://example.com./", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := validateAgentFetchURL(test.value)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateAgentFetchURL error = %v, wantErr %v", err, test.wantErr)
			}
			if err == nil && parsed.String() != test.wantURL {
				t.Fatalf("URL = %q, want %q", parsed.String(), test.wantURL)
			}
		})
	}
}

func TestIsPublicAgentFetchIP(t *testing.T) {
	tests := []struct {
		address string
		allowed bool
	}{
		{address: "1.1.1.1", allowed: true},
		{address: "2606:4700:4700::1111", allowed: true},
		{address: "10.0.0.1"},
		{address: "100.64.0.1"},
		{address: "169.254.169.254"},
		{address: "192.0.2.1"},
		{address: "198.18.0.1"},
		{address: "::ffff:127.0.0.1"},
		{address: "fc00::1"},
		{address: "2001:db8::1"},
	}
	for _, test := range tests {
		t.Run(test.address, func(t *testing.T) {
			address, err := netip.ParseAddr(test.address)
			if err != nil {
				t.Fatal(err)
			}
			if got := isPublicAgentFetchIP(address); got != test.allowed {
				t.Fatalf("isPublicAgentFetchIP(%s) = %v, want %v", address, got, test.allowed)
			}
		})
	}
}

func TestDialPublicAgentFetchHostRejectsLocalAddressAndPort(t *testing.T) {
	if _, err := dialPublicAgentFetchHost(t.Context(), "tcp", "127.0.0.1:80"); err == nil {
		t.Fatal("expected local address to be rejected")
	}
	if _, err := dialPublicAgentFetchHost(t.Context(), "tcp", "example.com:8080"); err == nil {
		t.Fatal("expected non-default port to be rejected")
	}
}

func TestExtractAgentFetchTextRemovesActiveContent(t *testing.T) {
	body := []byte(`<html><head><title>Rust &amp; WASM</title><script>ignore this script</script></head><body><h1>Docs</h1><p>Read the guide.</p><style>ignore these styles</style></body></html>`)
	text, title := extractAgentFetchText(body, "text/html")
	if title != "Rust & WASM" {
		t.Fatalf("unexpected title: %q", title)
	}
	if !strings.Contains(text, "Read the guide.") || strings.Contains(text, "ignore") {
		t.Fatalf("unexpected extracted text: %q", text)
	}
}

func TestBoundAgentFetchText(t *testing.T) {
	got, truncated := boundAgentFetchText("abcdef", 3)
	if !truncated || got != "abc…" {
		t.Fatalf("boundAgentFetchText = (%q, %v), want (%q, true)", got, truncated, "abc…")
	}
}

func TestValidateAgentFetchRedirect(t *testing.T) {
	previousURL, _ := url.Parse("https://docs.example.com/start")
	previous := []*http.Request{{URL: previousURL}}
	tests := []struct {
		name    string
		target  string
		count   int
		wantErr bool
	}{
		{name: "public redirect", target: "https://example.org/guide"},
		{name: "private redirect", target: "http://169.254.169.254/latest/meta-data/", wantErr: true},
		{name: "HTTPS downgrade", target: "http://example.org/guide", wantErr: true},
		{name: "excessive redirects", target: "https://example.org/guide", count: 3, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target, err := url.Parse(test.target)
			if err != nil {
				t.Fatal(err)
			}
			request := &http.Request{URL: target}
			prior := previous
			for range test.count {
				prior = append(prior, &http.Request{URL: previousURL})
			}
			err = validateAgentFetchRedirect(request, prior)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateAgentFetchRedirect error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}
