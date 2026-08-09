package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

// LocalSession is an in-process interactive shell PTY.
type LocalSession struct {
	ID   string
	Shell string
	Cwd   string
	File *os.File // master PTY
	Cmd  *exec.Cmd
}

func spawnLocalPty(shell []string, cwd string, cols, rows int) (*LocalSession, error) {
	if len(shell) == 0 {
		shell = []string{"/bin/bash", "-l"}
	}
	file := shell[0]
	args := shell[1:]
	if !strings.Contains(file, "/") {
		if p, err := exec.LookPath(file); err == nil {
			file = p
		}
	}
	if _, err := os.Stat(file); err != nil {
		// Fall back to sh
		if p, e := exec.LookPath("sh"); e == nil {
			file = p
			args = nil
		} else {
			return nil, fmt.Errorf("shell not found: %s", shell[0])
		}
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
		cwd, _ = os.Getwd()
	}

	cmd := exec.Command(file, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"CLICOLOR=1",
		"CLICOLOR_FORCE=1",
		"FORCE_COLOR=1",
		"HELM_TERMINAL=1",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
	if err != nil {
		return nil, err
	}

	display := strings.Join(append([]string{filepath.Base(file)}, args...), " ")
	if strings.HasPrefix(file, "/") {
		display = strings.Join(append([]string{file}, args...), " ")
	}

	return &LocalSession{
		ID:    uuid.NewString(),
		Shell: display,
		Cwd:   cwd,
		File:  ptmx,
		Cmd:   cmd,
	}, nil
}

func (s *LocalSession) Resize(cols, rows int) error {
	return pty.Setsize(s.File, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
}

func (s *LocalSession) Close() {
	if s.File != nil {
		_ = s.File.Close()
	}
	if s.Cmd != nil && s.Cmd.Process != nil {
		_ = s.Cmd.Process.Signal(syscall.SIGTERM)
	}
}
