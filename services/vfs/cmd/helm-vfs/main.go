// Command helm-vfs is the HelmCode high-performance VFS process.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdin (requests) / stdout
// (responses + vfs/didChange notifications). Logs go to stderr only.
//
//	helm-vfs [--root /app/main_repo]
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/helmcode-app/runner-core/services/vfs/internal/vfs"
)

func main() {
	root := flag.String("root", envOr("VFS_ROOT", envOr("MAIN_REPO_PATH", "/app/main_repo")),
		"workspace root to expose (absolute path)")
	flag.Parse()

	if err := vfs.Serve(os.Stdin, os.Stdout, os.Stderr, *root); err != nil {
		fmt.Fprintf(os.Stderr, "helm-vfs: %v\n", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
