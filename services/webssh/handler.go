package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// TerminalHandler upgrades WebSocket connections and bridges an in-process PTY.
type TerminalHandler struct {
	APIToken  string // empty = open (dev)
	Shell     []string
	Workdir   string
	Heartbeat time.Duration
	MaxSess   int
	active    int
	mu        sync.Mutex
	upgrader  websocket.Upgrader
}

func NewTerminalHandler(apiToken, workdir string, shell []string, heartbeat time.Duration, maxSess int) *TerminalHandler {
	if len(shell) == 0 {
		shell = []string{"/bin/bash", "-l"}
	}
	if heartbeat <= 0 {
		heartbeat = 25 * time.Second
	}
	if maxSess <= 0 {
		maxSess = 8
	}
	return &TerminalHandler{
		APIToken:  apiToken,
		Shell:     shell,
		Workdir:   workdir,
		Heartbeat: heartbeat,
		MaxSess:   maxSess,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true }, // tighten in production
		},
	}
}

// ServeHTTP handles GET /v1/terminal and /api/v1/terminal/ws.
func (h *TerminalHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Path
	if path != "/v1/terminal" && path != "/api/v1/terminal/ws" {
		http.NotFound(w, r)
		return
	}
	if !h.authorize(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	cols := queryInt(r, "cols", 80, 1, 500)
	rows := queryInt(r, "rows", 24, 1, 200)

	h.mu.Lock()
	if h.active >= h.MaxSess {
		h.mu.Unlock()
		http.Error(w, "terminal session limit reached", http.StatusServiceUnavailable)
		return
	}
	h.active++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.active--
		h.mu.Unlock()
	}()

	ws, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
	}
	defer ws.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	sess, err := spawnLocalPty(h.Shell, h.Workdir, cols, rows)
	if err != nil {
		_ = writeJSON(ws, map[string]any{"type": "error", "message": err.Error()})
		return
	}
	defer sess.Close()

	_ = writeJSON(ws, map[string]any{
		"type":      "ready",
		"sessionId": sess.ID,
		"backend":   "local-pty",
		"shell":     sess.Shell,
		"cwd":       sess.Cwd,
	})

	var writeMu sync.Mutex
	safeWrite := func(mt int, data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return ws.WriteMessage(mt, data)
	}

	// PTY → WebSocket
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := sess.File.Read(buf)
			if n > 0 {
				if err := safeWrite(websocket.BinaryMessage, buf[:n]); err != nil {
					cancel()
					return
				}
			}
			if err != nil {
				_ = safeWrite(websocket.TextMessage, mustJSON(map[string]any{"type": "exit"}))
				cancel()
				return
			}
		}
	}()

	// Heartbeat
	go func() {
		t := time.NewTicker(h.Heartbeat)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				writeMu.Lock()
				_ = ws.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second))
				writeMu.Unlock()
				_ = safeWrite(websocket.TextMessage, mustJSON(map[string]any{"type": "pong", "t": time.Now().UnixMilli()}))
			}
		}
	}()

	// WebSocket → PTY
	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			cancel()
			return
		}
		if mt == websocket.BinaryMessage {
			if _, err := sess.File.Write(data); err != nil {
				cancel()
				return
			}
			continue
		}
		text := string(data)
		if !strings.HasPrefix(text, "{") {
			_, _ = sess.File.Write(data)
			continue
		}
		var msg struct {
			Type string `json:"type"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
			T    int64  `json:"t"`
			Data string `json:"data"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "ping":
			_ = safeWrite(websocket.TextMessage, mustJSON(map[string]any{"type": "pong", "t": msg.T}))
		case "stdin":
			_, _ = sess.File.Write([]byte(msg.Data))
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				if err := sess.Resize(msg.Cols, msg.Rows); err != nil {
					_ = safeWrite(websocket.TextMessage, mustJSON(map[string]any{"type": "error", "message": err.Error()}))
				}
			}
		}
	}
}

func (h *TerminalHandler) authorize(r *http.Request) bool {
	if h.APIToken == "" {
		return true
	}
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") && subtleEqual(strings.TrimPrefix(auth, "Bearer "), h.APIToken) {
		return true
	}
	if q := strings.TrimSpace(r.URL.Query().Get("token")); q != "" && subtleEqual(q, h.APIToken) {
		return true
	}
	return false
}

func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

func queryInt(r *http.Request, key string, def, min, max int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func writeJSON(ws *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return ws.WriteMessage(websocket.TextMessage, b)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
