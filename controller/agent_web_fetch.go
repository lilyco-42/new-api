package controller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"golang.org/x/net/html"
)

const (
	maxAgentFetchURLRunes = 2048
	maxAgentFetchBody     = 1 << 20
	maxAgentFetchText     = 16000
)

type agentWebFetchResult struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	ContentType string `json:"content_type"`
	FetchedAt   string `json:"fetched_at"`
	Text        string `json:"text"`
	Truncated   bool   `json:"truncated"`
}

var agentFetchDeniedPrefixes = mustAgentFetchPrefixes(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/128",
	"::1/128",
	"64:ff9b:1::/48",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"fc00::/7",
	"fe80::/10",
	"ff00::/8",
)

func mustAgentFetchPrefixes(cidrs ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(cidrs))
	for _, cidr := range cidrs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil {
			panic("invalid Agent fetch deny prefix: " + cidr)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes
}

// AgentWebFetch reads a bounded public text page for the authenticated Agent.
func AgentWebFetch(c *gin.Context) {
	pageURL, err := validateAgentFetchURL(c.Query("url"))
	if err != nil {
		writeAgentError(c, http.StatusBadRequest, "AGENT_FETCH_INVALID", "url must be a public HTTP(S) page on the default port")
		return
	}
	result, err := fetchAgentWebPage(c.Request.Context(), pageURL)
	if err != nil {
		writeAgentError(c, http.StatusBadGateway, "AGENT_FETCH_UNAVAILABLE", "the page could not be safely fetched as a supported text document")
		return
	}
	common.ApiSuccess(c, result)
}

func validateAgentFetchURL(raw string) (*url.URL, error) {
	if strings.TrimSpace(raw) != raw || raw == "" || len([]rune(raw)) > maxAgentFetchURLRunes {
		return nil, errors.New("invalid URL length or whitespace")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || parsed.Opaque != "" || parsed.User != nil {
		return nil, errors.New("invalid URL")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("only HTTP and HTTPS are supported")
	}
	host := parsed.Hostname()
	if host == "" || parsed.Host == "" {
		return nil, errors.New("missing host")
	}
	port := parsed.Port()
	if (parsed.Scheme == "http" && port != "" && port != "80") || (parsed.Scheme == "https" && port != "" && port != "443") {
		return nil, errors.New("non-default port")
	}
	if strings.HasSuffix(host, ".") {
		return nil, errors.New("trailing-dot hosts are not supported")
	}
	if address, err := netip.ParseAddr(host); err == nil && !isPublicAgentFetchIP(address) {
		return nil, errors.New("non-public IP address")
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed, nil
}

func isPublicAgentFetchIP(address netip.Addr) bool {
	if address.Zone() != "" {
		return false
	}
	if address.Is4In6() {
		address = address.Unmap()
	}
	if !address.IsValid() || !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsMulticast() || address.IsUnspecified() {
		return false
	}
	for _, prefix := range agentFetchDeniedPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func fetchAgentWebPage(ctx context.Context, pageURL *url.URL) (*agentWebFetchResult, error) {
	if pageURL == nil {
		return nil, errors.New("missing page URL")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/html, application/xhtml+xml, text/plain, text/markdown, application/json, application/xml, text/xml;q=0.8")
	request.Header.Set("User-Agent", "Lain42-Agent/1.0 (+https://lain42.top/agent)")
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialPublicAgentFetchHost,
		TLSHandshakeTimeout:   4 * time.Second,
		ResponseHeaderTimeout: 4 * time.Second,
		MaxConnsPerHost:       2,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
		CheckRedirect: func(next *http.Request, previous []*http.Request) error {
			return validateAgentFetchRedirect(next, previous)
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("source returned status %d", response.StatusCode)
	}
	contentType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || !isSupportedAgentFetchContentType(strings.ToLower(contentType)) {
		return nil, errors.New("unsupported content type")
	}
	contentType = strings.ToLower(contentType)
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAgentFetchBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxAgentFetchBody {
		return nil, errors.New("source document exceeds size limit")
	}
	text, title := extractAgentFetchText(body, contentType)
	text, truncated := boundAgentFetchText(text, maxAgentFetchText)
	if text == "" {
		return nil, errors.New("source contains no readable text")
	}
	return &agentWebFetchResult{
		URL:         response.Request.URL.String(),
		Title:       title,
		ContentType: contentType,
		FetchedAt:   time.Now().UTC().Format(time.RFC3339),
		Text:        text,
		Truncated:   truncated,
	}, nil
}

func validateAgentFetchRedirect(next *http.Request, previous []*http.Request) error {
	if next == nil || next.URL == nil || len(previous) == 0 || len(previous) >= 3 {
		return errors.New("invalid or excessive redirect")
	}
	validatedURL, err := validateAgentFetchURL(next.URL.String())
	if err != nil {
		return errors.New("redirect target is not allowed")
	}
	if previous[len(previous)-1].URL.Scheme == "https" && validatedURL.Scheme != "https" {
		return errors.New("HTTPS downgrade redirect is not allowed")
	}
	next.URL = validatedURL
	return nil
}

func dialPublicAgentFetchHost(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("unsupported network")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || (port != "80" && port != "443") {
		return nil, errors.New("non-default destination port")
	}
	if literal, err := netip.ParseAddr(host); err == nil {
		if !isPublicAgentFetchIP(literal) {
			return nil, errors.New("non-public destination address")
		}
		return (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, network, net.JoinHostPort(literal.String(), port))
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 || len(addresses) > 32 {
		return nil, errors.New("host resolution failed")
	}
	for _, address := range addresses {
		if !isPublicAgentFetchIP(address) {
			return nil, errors.New("host resolved to a non-public address")
		}
	}
	var lastErr error
	for _, resolved := range addresses {
		connection, dialErr := (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, network, net.JoinHostPort(resolved.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

func isSupportedAgentFetchContentType(contentType string) bool {
	switch contentType {
	case "text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json", "application/xml", "text/xml", "application/rss+xml", "application/atom+xml":
		return true
	default:
		return strings.HasSuffix(contentType, "+json") || strings.HasSuffix(contentType, "+xml")
	}
}

func extractAgentFetchText(body []byte, contentType string) (text, title string) {
	if contentType != "text/html" && contentType != "application/xhtml+xml" {
		return string(body), ""
	}
	document, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return "", ""
	}
	var content strings.Builder
	var pageTitle strings.Builder
	var walk func(*html.Node, bool)
	walk = func(node *html.Node, inTitle bool) {
		if node.Type == html.ElementNode {
			tag := strings.ToLower(node.Data)
			if tag == "script" || tag == "style" || tag == "noscript" || tag == "svg" || tag == "canvas" || tag == "template" {
				return
			}
			if tag == "title" {
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					if child.Type == html.TextNode {
						pageTitle.WriteString(child.Data)
					}
				}
				return
			}
			if isAgentFetchBlockTag(tag) {
				content.WriteByte('\n')
			}
		}
		if node.Type == html.TextNode && !inTitle {
			content.WriteString(node.Data)
			content.WriteByte(' ')
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child, inTitle)
		}
		if node.Type == html.ElementNode && isAgentFetchBlockTag(strings.ToLower(node.Data)) {
			content.WriteByte('\n')
		}
	}
	walk(document, false)
	return strings.TrimSpace(content.String()), strings.Join(strings.Fields(pageTitle.String()), " ")
}

func isAgentFetchBlockTag(tag string) bool {
	switch tag {
	case "address", "article", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul":
		return true
	default:
		return false
	}
}

func boundAgentFetchText(value string, maxRunes int) (string, bool) {
	value = strings.ToValidUTF8(value, "�")
	if maxRunes <= 0 {
		return "", value != ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return strings.TrimSpace(value), false
	}
	return strings.TrimSpace(string(runes[:maxRunes])) + "…", true
}
