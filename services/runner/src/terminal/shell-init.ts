/**
 * Interactive shell bootstrap for WebSSH: common aliases + color-friendly ls.
 * Materialized to a temp rc file and passed via bash --rcfile / zsh ZDOTDIR.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bash / POSIX-ish rc sourced for interactive WebSSH sessions. */
export const HELM_TERMINAL_RC = `# HelmCode WebSSH interactive defaults
# Generated — do not edit by hand (see shell-init.ts).

# Soft-load system / user configs when present (ignore errors).
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc 2>/dev/null
[ -r "\${HOME}/.bashrc" ] && . "\${HOME}/.bashrc" 2>/dev/null

# ---- color ls (GNU coreutils vs BSD) --------------------------------------
if command -v ls >/dev/null 2>&1; then
  if ls --color=auto / >/dev/null 2>&1; then
    alias ls='ls --color=auto'
  elif ls -G / >/dev/null 2>&1; then
    alias ls='ls -G'
  fi
fi

alias ll='ls -lah'
alias la='ls -A'
alias l='ls -CF'

# ---- grep -----------------------------------------------------------------
if command -v grep >/dev/null 2>&1; then
  if grep --color=auto --help >/dev/null 2>&1; then
    alias grep='grep --color=auto'
    alias egrep='egrep --color=auto'
    alias fgrep='fgrep --color=auto'
  fi
fi

# ---- navigation / git -----------------------------------------------------
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

if command -v git >/dev/null 2>&1; then
  alias g='git'
  alias gs='git status'
  alias gd='git diff'
  alias ga='git add'
  alias gc='git commit'
  alias gl='git log --oneline --decorate -20'
  alias gp='git pull'
  alias gco='git checkout'
  alias gb='git branch'
fi

# ---- quality of life ------------------------------------------------------
alias c='clear'
alias h='history'
alias please='sudo'

# Friendly prompt hint (only if PS1 still default-ish — avoid clobbering rich themes).
if [ -z "\${HELM_TERMINAL_PROMPT_SET:-}" ]; then
  case \${PS1-} in
    ''|'\\\\s-\\\\v\\\\\$ '|'\\\\u@\\\\h:\\\\w\\\\\$ ')
      export PS1='\\\\[\\\\e[32m\\\\]\\\\u@helm\\\\[\\\\e[0m\\\\]:\\\\[\\\\e[34m\\\\]\\\\w\\\\[\\\\e[0m\\\\]\\\\$ '
      export HELM_TERMINAL_PROMPT_SET=1
      ;;
  esac
fi
`;

const RC_BASENAME = "helm-terminal.rc";
const ZDOT_DIRNAME = "helm-terminal-zdot";

let cachedRcPath: string | undefined;
let cachedZdotDir: string | undefined;

/** Write (idempotent) bash rc and return its absolute path. */
export function ensureBashRcPath(): string {
  if (cachedRcPath) return cachedRcPath;
  const path = join(tmpdir(), RC_BASENAME);
  writeFileSync(path, HELM_TERMINAL_RC, { encoding: "utf8", mode: 0o644 });
  cachedRcPath = path;
  return path;
}

/**
 * Zsh reads \`$ZDOTDIR/.zshrc\` for interactive shells.
 * We drop a minimal .zshrc that sources the same alias block.
 */
export function ensureZshDotDir(): string {
  if (cachedZdotDir) return cachedZdotDir;
  const dir = join(tmpdir(), ZDOT_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const zshrc = `# HelmCode WebSSH zsh bootstrap
emulate -L sh
. "${ensureBashRcPath().replace(/"/g, '\\"')}" 2>/dev/null || true
`;
  writeFileSync(join(dir, ".zshrc"), zshrc, { encoding: "utf8", mode: 0o644 });
  cachedZdotDir = dir;
  return dir;
}

export function isBashLike(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  return base === "bash" || file.endsWith("/bash");
}

export function isZshLike(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  return base === "zsh" || file.endsWith("/zsh");
}

/**
 * Rewrite shell argv so interactive sessions load Helm aliases.
 * Prefer interactive non-login + --rcfile so our rc is not skipped by -l.
 */
export function applyHelmShellInit(
  file: string,
  args: string[],
  env: Record<string, string>,
): { file: string; args: string[]; env: Record<string, string>; display: string } {
  if (isBashLike(file)) {
    const rc = ensureBashRcPath();
    // Drop leading -l / --login so --rcfile is applied reliably.
    const filtered = args.filter((a) => a !== "-l" && a !== "--login");
    const nextArgs = ["--rcfile", rc, "-i", ...filtered.filter((a) => a !== "-i")];
    return {
      file,
      args: nextArgs,
      env,
      display: `${file} --rcfile helm-terminal.rc -i`,
    };
  }

  if (isZshLike(file)) {
    const zdot = ensureZshDotDir();
    const filtered = args.filter((a) => a !== "-l" && a !== "--login");
    const nextArgs = ["-i", ...filtered.filter((a) => a !== "-i")];
    return {
      file,
      args: nextArgs,
      env: { ...env, ZDOTDIR: zdot },
      display: `${file} -i (ZDOTDIR=helm-terminal)`,
    };
  }

  return {
    file,
    args,
    env,
    display: [file, ...args].join(" "),
  };
}
