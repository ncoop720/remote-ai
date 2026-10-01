package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// The proxy decides who a request is from; whatever the sender claims is replaced.
func TestProxyMarksRequests(t *testing.T) {
	var got http.Header
	var host string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, host = r.Header.Clone(), r.Host
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	loginOf := func(ctx context.Context, addr string) string { return "me@example.com" }

	front := httptest.NewServer(newProxy(target, "s3cret", loginOf, 3100))
	defer front.Close()
	req, _ := http.NewRequest("GET", front.URL+"/x", nil)
	req.Header.Set("X-Remote-AI-Proxy", "forged")
	req.Header.Set("X-Remote-AI-Tailscale-Login", "someone@else.com")
	req.Header.Set("X-Forwarded-For", "6.6.6.6")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	for name, want := range map[string]string{
		"X-Remote-Ai-Proxy":           "s3cret",
		"X-Remote-Ai-Tailscale-Login": "me@example.com",
		"X-Remote-Ai-Preview-Port":    "3100",
		"X-Forwarded-For":             "127.0.0.1",
	} {
		if v := got.Values(name); len(v) != 1 || v[0] != want {
			t.Errorf("%s = %q, want %q", name, v, want)
		}
	}
	if got.Get("X-Forwarded-Host") == "" || host != target.Host {
		t.Errorf("forwarded host %q, host %q", got.Get("X-Forwarded-Host"), host)
	}
}

// Tagged devices and unknown senders get no login, so the dashboard asks them to pair.
func TestProxyWithoutLogin(t *testing.T) {
	var got http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = r.Header.Clone() }))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	front := httptest.NewServer(newProxy(target, "s3cret", func(context.Context, string) string { return "" }, 0))
	defer front.Close()
	req, _ := http.NewRequest("GET", front.URL, nil)
	req.Header.Set("X-Remote-AI-Tailscale-Login", "me@example.com")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if v := got.Get("X-Remote-AI-Tailscale-Login"); v != "" {
		t.Errorf("login = %q, want none", v)
	}
	if v := got.Get("X-Remote-AI-Preview-Port"); v != "" {
		t.Errorf("preview port = %q on a dashboard request", v)
	}
}
