// Command helm-webssh is a standalone WebSSH gateway (optional Go sidecar).
//
// Prefer the in-process Node gateway in open-core for the monorepo runtime.
// Both use local PTY (no docker.sock).
//
//	TERMINAL_WORKDIR=/app/main_repo OPENCORE_API_TOKEN=... ./helm-webssh
//
// Listens on :8081 by default; path /v1/terminal (alias /api/v1/terminal/ws).
package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	addr := env("HTTP_ADDR", ":8081")
	token := os.Getenv("OPENCORE_API_TOKEN")
	workdir := env("TERMINAL_WORKDIR", "/app/main_repo")
	shellRaw := env("TERMINAL_SHELL", "/bin/bash -l")
	shell := strings.Fields(shellRaw)
	maxSess := envInt("TERMINAL_MAX_SESSIONS", 8)

	h := NewTerminalHandler(token, workdir, shell, 25*time.Second, maxSess)

	mux := http.NewServeMux()
	mux.Handle("/v1/terminal", h)
	mux.Handle("/api/v1/terminal/ws", h)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"helm-webssh","backend":"local-pty"}`))
	})

	log.Printf("helm-webssh listening on %s backend=local-pty workdir=%s", addr, workdir)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
