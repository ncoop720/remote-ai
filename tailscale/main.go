// remote-ai-tailscale puts the remote-ai dashboard on your tailnet: it joins as its own device
// (with tsnet, so the Tailscale app isn't needed on this computer), serves HTTPS with the
// certificate Tailscale provides, and passes requests to the dashboard on localhost.
//
// It also serves the sessions' dev servers for previews: the dashboard says which ports they use,
// and each is served on the same port of this tailnet device (https://<device>:3100), passed to
// the dashboard's preview proxy with the port in X-Remote-AI-Preview-Port.
//
// The dashboard server starts it and talks to it over stdio. It writes its state as JSON lines on
// stdout and takes {"cmd":"logout"} and {"cmd":"ports","ports":[3100]} on stdin; when stdin closes
// (the server exited), it stops.
//
//	remote-ai-tailscale --state-dir DIR --hostname NAME --target http://127.0.0.1:8787 \
//	  --preview-target http://127.0.0.1:8789
//
// Requests are marked with X-Remote-AI-Proxy (the secret from $REMOTE_AI_PROXY_SECRET) and
// X-Remote-AI-Tailscale-Login (who sent them), so the server can trust its owner's own devices.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

// Event is one line of output: the state the server shows in its Connect a phone page.
type Event struct {
	State    string `json:"state"`              // starting, needs-login, needs-approval, running, error
	LoginURL string `json:"loginUrl,omitempty"` // where to sign in, while state is needs-login
	URL      string `json:"url,omitempty"`      // the dashboard's address on the tailnet
	Login    string `json:"login,omitempty"`    // who this computer is signed in as
	HTTPS    *bool  `json:"https,omitempty"`    // false: MagicDNS or HTTPS certificates are off in the tailnet
	Message  string `json:"message,omitempty"`
}

var (
	outMu sync.Mutex
	last  string
)

// emit writes an event, unless it says the same as the previous one.
func emit(e Event) {
	b, _ := json.Marshal(e)
	outMu.Lock()
	defer outMu.Unlock()
	if string(b) == last {
		return
	}
	last = string(b)
	fmt.Println(last)
}

func fail(msg string, args ...any) {
	emit(Event{State: "error", Message: fmt.Sprintf(msg, args...)})
	os.Exit(1)
}

func main() {
	stateDir := flag.String("state-dir", "", "where to keep this device's Tailscale state")
	hostname := flag.String("hostname", "remote-ai", "device name on the tailnet")
	target := flag.String("target", "http://127.0.0.1:8787", "the dashboard to serve")
	previewTarget := flag.String("preview-target", "", "the dashboard's preview proxy, for dev-server ports")
	flag.Parse()
	if *stateDir == "" {
		fail("--state-dir is required")
	}
	backend, err := url.Parse(*target)
	if err != nil {
		fail("bad --target: %v", err)
	}
	var previews *url.URL
	if *previewTarget != "" {
		if previews, err = url.Parse(*previewTarget); err != nil {
			fail("bad --preview-target: %v", err)
		}
	}
	// Diagnostics go to stderr, which the server logs; stdout carries only events.
	log.SetOutput(os.Stderr)

	srv := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
		Logf:     func(string, ...any) {},
		// The sign-in URL reaches the dashboard as an event; tsnet's own reminder suggests an auth key instead.
		UserLogf: func(format string, args ...any) {
			if !strings.HasPrefix(format, "To start this tsnet server") {
				log.Printf(format, args...)
			}
		},
	}
	emit(Event{State: "starting"})
	if err := srv.Start(); err != nil {
		fail("starting Tailscale: %v", err)
	}
	defer srv.Close()
	lc, err := srv.LocalClient()
	if err != nil {
		fail("%v", err)
	}

	n := &node{srv: srv, lc: lc, backend: backend, previews: previews, secret: os.Getenv("REMOTE_AI_PROXY_SECRET"), listeners: map[int]net.Listener{}}
	n.loginOf = n.whois
	ctx, cancel := context.WithCancel(context.Background())
	go n.commands(ctx, cancel)
	go n.serve(ctx)
	<-ctx.Done()
}

// node is this device on the tailnet: what it serves, and on which ports.
type node struct {
	srv      *tsnet.Server
	lc       *local.Client
	backend  *url.URL
	previews *url.URL
	secret   string
	loginOf  func(ctx context.Context, remoteAddr string) string

	mu        sync.Mutex
	running   bool // the dashboard is being served; previews can be too
	https     bool
	dnsName   string
	wanted    []int // dev-server ports to serve, from the dashboard
	listeners map[int]net.Listener
}

// commands reads stdin; when it closes, the dashboard server is gone and so is the reason to run.
func (n *node) commands(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var cmd struct {
			Cmd   string
			Ports []int
		}
		if json.Unmarshal(scanner.Bytes(), &cmd) != nil {
			continue
		}
		switch cmd.Cmd {
		case "logout":
			if err := n.lc.Logout(ctx); err != nil {
				log.Printf("logout: %v", err)
			}
		case "ports":
			n.mu.Lock()
			n.wanted = cmd.Ports
			n.mu.Unlock()
			n.syncPreviews()
		}
	}
}

// serve waits for the device to be signed in, then serves the dashboard. It reports the state
// as it changes, including signing out and back in.
func (n *node) serve(ctx context.Context) {
	listening := false
	for ctx.Err() == nil {
		st, err := n.lc.StatusWithoutPeers(ctx)
		if err != nil {
			log.Printf("status: %v", err)
			time.Sleep(time.Second)
			continue
		}
		switch st.BackendState {
		case ipn.NeedsLogin.String():
			if st.AuthURL != "" {
				emit(Event{State: "needs-login", LoginURL: st.AuthURL})
			}
		case ipn.NeedsMachineAuth.String():
			emit(Event{State: "needs-approval", Message: "An admin of the tailnet has to approve this device"})
		case ipn.Running.String():
			login := ""
			if st.Self != nil {
				login = st.User[st.Self.UserID].LoginName
			}
			dnsName := ""
			if st.Self != nil {
				dnsName = strings.TrimSuffix(st.Self.DNSName, ".")
			}
			https := st.CurrentTailnet != nil && st.CurrentTailnet.MagicDNSEnabled && len(st.CertDomains) > 0
			if !listening {
				if err := n.listen(https, dnsName); err != nil {
					fail("listening on the tailnet: %v", err)
				}
				listening = true
				if https {
					go warmCertificate(ctx, n.lc, dnsName)
				}
				n.mu.Lock()
				n.running, n.https, n.dnsName = true, https, dnsName
				n.mu.Unlock()
				n.syncPreviews()
			}
			scheme := "http"
			if https {
				scheme = "https"
			}
			e := Event{State: "running", URL: scheme + "://" + dnsName, Login: login, HTTPS: &https}
			if !https {
				e.Message = "Turn on MagicDNS and HTTPS certificates in the DNS page of the Tailscale admin console for notifications and an installable app"
			}
			emit(e)
		default:
			emit(Event{State: "starting"})
		}
		time.Sleep(time.Second)
	}
}

// warmCertificate fetches the HTTPS certificate now, so the first phone to connect doesn't wait for it.
func warmCertificate(ctx context.Context, lc *local.Client, domain string) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if _, _, err := lc.CertPair(ctx, domain); err != nil {
		log.Printf("certificate for %s: %v", domain, err)
	}
}

// listenOn opens a tailnet port, with TLS when the tailnet gives this device a certificate.
func (n *node) listenOn(port int, https bool) (net.Listener, error) {
	addr := fmt.Sprintf(":%d", port)
	if https {
		return n.srv.ListenTLS("tcp", addr)
	}
	return n.srv.Listen("tcp", addr)
}

func (n *node) listen(https bool, dnsName string) error {
	port := 80
	if https {
		port = 443
	}
	ln, err := n.listenOn(port, https)
	if err != nil {
		return err
	}
	go http.Serve(ln, newProxy(n.backend, n.secret, n.loginOf, 0))
	if https {
		// Plain http on the tailnet just points to https.
		plain, err := n.srv.Listen("tcp", ":80")
		if err != nil {
			return err
		}
		go http.Serve(plain, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://"+dnsName+r.URL.RequestURI(), http.StatusMovedPermanently)
		}))
	}
	return nil
}

// syncPreviews serves exactly the dev-server ports the dashboard asked for, once running.
func (n *node) syncPreviews() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.running || n.previews == nil {
		return
	}
	wanted := map[int]bool{}
	for _, p := range n.wanted {
		if p >= 1024 && p <= 65535 {
			wanted[p] = true
		}
	}
	for port, ln := range n.listeners {
		if !wanted[port] {
			ln.Close()
			delete(n.listeners, port)
		}
	}
	for port := range wanted {
		if n.listeners[port] != nil {
			continue
		}
		ln, err := n.listenOn(port, n.https)
		if err != nil {
			log.Printf("preview port %d: %v", port, err)
			continue
		}
		n.listeners[port] = ln
		go http.Serve(ln, newProxy(n.previews, n.secret, n.loginOf, port))
	}
}

// whois is the Tailscale login of whoever sent a request; empty for tagged devices and unknowns.
func (n *node) whois(ctx context.Context, remoteAddr string) string {
	res, err := n.lc.WhoIs(ctx, remoteAddr)
	if err != nil || res.UserProfile == nil || res.Node == nil || res.Node.IsTagged() {
		return ""
	}
	return res.UserProfile.LoginName
}

// newProxy passes requests (and WebSockets, and event streams) to the dashboard, saying who sent
// them. A previewPort says which dev server the request is for.
func newProxy(backend *url.URL, secret string, loginOf func(context.Context, string) string, previewPort int) http.Handler {
	var cacheMu sync.Mutex
	type who struct {
		login   string
		expires time.Time
	}
	cache := map[string]who{}
	cachedLoginOf := func(ctx context.Context, remoteAddr string) string {
		host, _, _ := net.SplitHostPort(remoteAddr)
		cacheMu.Lock()
		w, ok := cache[host]
		cacheMu.Unlock()
		if ok && time.Now().Before(w.expires) {
			return w.login
		}
		login := loginOf(ctx, remoteAddr)
		cacheMu.Lock()
		cache[host] = who{login, time.Now().Add(time.Minute)}
		cacheMu.Unlock()
		return login
	}

	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(backend)
			pr.SetXForwarded()
			// Nobody but this proxy gets to say who they are.
			for name := range pr.Out.Header {
				if strings.HasPrefix(strings.ToLower(name), "x-remote-ai-") {
					pr.Out.Header.Del(name)
				}
			}
			pr.Out.Header.Set("X-Remote-AI-Proxy", secret)
			if login := cachedLoginOf(pr.In.Context(), pr.In.RemoteAddr); login != "" {
				pr.Out.Header.Set("X-Remote-AI-Tailscale-Login", login)
			}
			if previewPort != 0 {
				pr.Out.Header.Set("X-Remote-AI-Preview-Port", fmt.Sprint(previewPort))
			}
		},
		// Event streams (session status, logs, chat) must not be buffered.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "remote-ai isn't responding on this computer", http.StatusBadGateway)
		},
	}
}
