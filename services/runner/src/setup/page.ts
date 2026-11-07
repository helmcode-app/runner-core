export function renderSetupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>HelmCode runner setup</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0f1115;
      --fg: #e8eaed;
      --muted: #9aa0a6;
      --card: #1a1d23;
      --line: #2a2f38;
      --accent: #6ea8fe;
      --ok: #3dd68c;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f7f9;
        --fg: #1a1d23;
        --muted: #5f6368;
        --card: #fff;
        --line: #e2e5ea;
        --accent: #1b6ef3;
        --ok: #0f9d58;
      }
    }
    * { box-sizing: border-box; }
    body {
      font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      max-width: 40rem;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }
    h1 { font-size: 1.35rem; font-weight: 650; margin: 0 0 .25rem; }
    .lede { color: var(--muted); margin: 0 0 1.5rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 1.15rem 1.2rem 1.25rem;
      margin: 0 0 1rem;
    }
    .step {
      font-size: .72rem;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 650;
      margin: 0 0 .35rem;
    }
    h2 { font-size: 1.05rem; margin: 0 0 .5rem; font-weight: 600; }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.85rem;
      letter-spacing: .22em;
      font-weight: 650;
      margin: .65rem 0;
    }
    .gh-code {
      letter-spacing: .18em;
      font-size: 2rem;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-radius: 10px;
      padding: .55rem .8rem;
      display: inline-block;
    }
    button, .btn {
      font: inherit;
      font-weight: 600;
      border: 0;
      border-radius: 10px;
      padding: .6rem 1rem;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      text-decoration: none;
      display: inline-block;
    }
    button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); }
    button:disabled { opacity: .55; cursor: default; }
    .muted { color: var(--muted); font-size: .92rem; }
    .ok { color: var(--ok); font-weight: 600; }
    .err { color: #e85d5d; min-height: 1.2em; }
    #qr { display: block; margin: .75rem 0; border-radius: 8px; background: #fff; }
    .repo-list { display: flex; flex-direction: column; gap: .45rem; margin-top: .75rem; }
    .repo-list button { text-align: left; background: transparent; color: var(--fg); border: 1px solid var(--line); }
    .repo-list button:hover { border-color: var(--accent); }
    .wait { margin-top: .75rem; }
    input[type=text] {
      font: inherit;
      width: 100%;
      margin: .6rem 0 .8rem;
      padding: .55rem .7rem;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--fg);
      letter-spacing: .12em;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <h1>HelmCode runner</h1>
  <p class="lede" id="phase">Loading…</p>
  <div id="pair"></div>
  <div id="rest"></div>
  <p class="err" id="err"></p>
  <script>
    const $ = (id) => document.getElementById(id);
    async function api(path, opts = {}) {
      const res = await fetch(path, {
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
        ...opts,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    }
    async function boot() {
      await refresh();
    }
    async function refresh() {
      $("err").textContent = "";
      const pub = await api("/v1/setup");
      const rest = $("rest");
      rest.innerHTML = "";
      let session = null;
      try { session = await api("/v1/setup/session"); } catch (_) {}
      if (!session) {
        $("phase").textContent = pub.paired
          ? "A device is already enrolled. Add another from HelmCode."
          : "Pair from HelmCode with the setup code printed by the runner.";
        $("pair").innerHTML = "<div class=card><p class=step>iPad</p><h2>Pair in HelmCode</h2>"
          + "<p class=muted>The terminal shows a short code like <code>SDCN-9XZS</code>. Enter that URL and code in HelmCode. This page does not pair a device.</p>"
          + "<p class=muted>To link GitHub here, enter that setup code, or a code from <code>setup:browser</code>.</p>"
          + "<input id=code type=text autocomplete=off spellcheck=false placeholder=SDCN-9XZS>"
          + "<button id=unlock>Unlock this page</button></div>";
        $("unlock").onclick = unlock;
        return;
      }
      const label = {
        pairing: "Pair the iPad in HelmCode, then link GitHub here if you need a repo.",
        github: "GitHub next.",
        clone: "Pick a repository to clone.",
        ready: "Runner is ready.",
      };
      $("phase").textContent = label[session.phase] || ("Phase: " + session.phase);
      $("pair").innerHTML = "<div class=card><p class=step>iPad</p><h2>Devices</h2><p class=muted>Add or remove devices in HelmCode. This page does not show a pairing QR.</p></div>";
      if (session.phase === "ready") {
        rest.innerHTML = "<div class=card><p class=step>Repository</p><h2>Connected</h2>"
          + (session.repo ? "<p class=ok>" + session.repo.owner + "/" + session.repo.repo + "</p>" : "<p class=muted>Using the git repo already on this runner.</p>")
          + "</div>";
        return;
      }
      if (session.hasRepo && (session.phase === "pairing" || session.phase === "github")) {
        rest.innerHTML = "<div class=card><p class=step>Repository</p><h2>Already on disk</h2><p class=muted>HOST_REPO / existing git — GitHub clone is skipped after pairing.</p></div>";
        return;
      }
      if (session.phase === "pairing" || session.phase === "github") {
        if (session.githubConfigured) showGithub();
        else rest.innerHTML = "<div class=card><p class=muted>GitHub OAuth client id is not configured.</p></div>";
        return;
      }
      if (session.phase === "clone") await showClone(session);
    }
    async function unlock() {
      $("err").textContent = "";
      const code = ($("code").value || "").trim();
      try {
        await api("/v1/setup/browser", { method: "POST", body: JSON.stringify({ code }) });
        await refresh();
      } catch (e) {
        $("err").textContent = e.message;
      }
    }
    function showGithub() {
      $("rest").innerHTML = "<div class=card><p class=step>Step 2 · GitHub</p><h2>Authorize this runner</h2>"
        + "<p class=muted>Opens GitHub in this browser. Enter the code, then come back — this page waits.</p>"
        + "<button id=gh>Continue with GitHub</button>"
        + "<div id=ghst class=wait></div></div>";
      $("gh").onclick = startGh;
    }
    async function startGh() {
      $("err").textContent = "";
      $("gh").disabled = true;
      try {
        const d = await api("/v1/setup/github/start", { method: "POST", body: "{}" });
        $("ghst").innerHTML = "<p class=muted>Enter this code on GitHub</p>"
          + "<p class='code gh-code'>" + d.userCode + "</p>"
          + "<p><a class=btn href='" + d.verificationUri + "' target=_blank rel=noopener>Open GitHub</a></p>"
          + "<p class=muted id=ghwait>Waiting for authorization…</p>";
        pollGh();
      } catch (e) {
        $("gh").disabled = false;
        $("err").textContent = e.message;
      }
    }
    async function pollGh() {
      try {
        const r = await api("/v1/setup/github/poll");
        if (r.status === "complete") { await refresh(); return; }
        if (r.status === "pending") { setTimeout(pollGh, r.intervalMs || 5000); return; }
        $("err").textContent = r.error || r.status;
        $("gh").disabled = false;
      } catch (e) { $("err").textContent = e.message; }
    }
    async function showClone(s) {
      $("rest").innerHTML = "<div class=card><p class=step>Step 3 · Clone</p><h2>Choose a repository</h2>"
        + "<p class=muted>Signed in as <strong>" + (s.githubLogin || "GitHub") + "</strong></p>"
        + "<div class=repo-list id=repos>Loading…</div></div>";
      try {
        const list = await api("/v1/setup/github/repos");
        const box = $("repos");
        box.innerHTML = "";
        for (const repo of list.repos || []) {
          const b = document.createElement("button");
          b.textContent = repo.owner + "/" + repo.repo + (repo.private ? "  private" : "");
          b.onclick = async () => {
            b.disabled = true;
            try {
              await api("/v1/setup/github/clone", {
                method: "POST",
                body: JSON.stringify({ owner: repo.owner, repo: repo.repo }),
              });
              await refresh();
            } catch (e) { $("err").textContent = e.message; b.disabled = false; }
          };
          box.appendChild(b);
        }
        if (!(list.repos || []).length) box.textContent = "No repositories returned.";
      } catch (e) { $("err").textContent = e.message; }
    }
    boot().catch((e) => { $("err").textContent = e.message; });
  </script>
</body>
</html>`;
}
