FROM --platform=$BUILDPLATFORM node:24-bookworm

ARG TARGETARCH

# ── Extra CA certificates (optional, name-agnostic) ────────────────
# `dotfiles-agent/certs/` is a DROP FOLDER, not a file this build knows the
# name of. On a machine inside a corporate network, put root/intermediate
# certificates there (`*.pem` or `*.crt`, any names, any number) and rebuild.
# The folder is gitignored and a fresh clone holds nothing but `.gitkeep`, so
# every step here is conditional and the build must succeed with ZERO
# certificates — that is the normal case, not an error.
#
# Two trust stores have to be fed, and they are independent:
#   · OpenSSL's (`/usr/local/share/ca-certificates/*.crt` + `update-ca-certificates`)
#     → git, curl, openssl, chromium/playwright. The rename to `.crt` is
#     required: `update-ca-certificates` ignores files not ending in `.crt`, so
#     a `*.pem` dropped there would be trusted by nobody, silently.
#   · Node's own store → Node does NOT read the system bundle (it ships a
#     compiled-in Mozilla store), so `update-ca-certificates` alone never fixes
#     npm / yarn / pi / its MCP servers. They need `NODE_EXTRA_CA_CERTS`, which
#     accepts ONE file holding MANY certificates.
# The bundle is created even when empty: Node ignores an empty file silently,
# while a MISSING one prints a warning on every start. So the baked path always
# exists and is always safe to point at.
#
# Certificates only: a private key in this folder is a mistake, and the loop
# refuses it instead of quietly baking a secret into the image. The loop also
# rejects files with no `BEGIN CERTIFICATE` in them — `update-ca-certificates`
# does NOT inspect content, it appends whatever a `*.crt` file holds straight
# into the bundle, so without this filter a CSR or a stray text file would
# become a permanent junk entry in the system trust store.
# Two details here are load-bearing and easy to get wrong:
#   · `-e` before every pattern — a pattern starting with `-----` is parsed by
#     grep as an OPTION and exits 2, so `if ! grep` reads as "no certificate
#     here" and would silently skip every file while printing `0 trusted`.
#   · if files were provided but none passed the checks, the build FAILS —
#     succeeding with an untrusted store would look like success.
COPY dotfiles-agent/certs/ /tmp/agent-cas/
RUN set -eu; \
    bundle=/usr/local/share/ca-certificates/agent-extra-ca.pem; \
    : > "$bundle"; \
    found=0; seen=0; \
    for f in /tmp/agent-cas/*; do \
      case "$f" in *.pem|*.crt) ;; *) continue ;; esac; \
      [ -f "$f" ] || continue; \
      seen=$((seen + 1)); \
      name=$(basename "$f"); \
      if grep -qs -e "-----BEGIN .*PRIVATE KEY-----" "$f"; then \
        echo "CA: refusing $name — private key, not a certificate" >&2; \
        continue; \
      fi; \
      if ! grep -qs -e "-----BEGIN CERTIFICATE-----" "$f"; then \
        echo "CA: skipping $name — no PEM certificate in it" >&2; \
        continue; \
      fi; \
      dst="/usr/local/share/ca-certificates/${name%.*}.crt"; \
      if [ -e "$dst" ]; then \
        echo "CA: $dst already provided by another file — overwriting" >&2; \
      fi; \
      install -m 644 "$f" "$dst"; \
      cat "$f" >> "$bundle"; \
      found=$((found + 1)); \
    done; \
    if [ "$seen" -gt 0 ] && [ "$found" -eq 0 ]; then \
      echo "CA: ERROR — $seen file(s) in dotfiles-agent/certs/, none of them usable." >&2; \
      echo "    Each was reported above; a certificate must contain BEGIN CERTIFICATE." >&2; \
      exit 1; \
    fi; \
    if [ "$found" -gt 0 ]; then update-ca-certificates; fi; \
    rm -rf /tmp/agent-cas; \
    echo "CA: $found extra certificate file(s) trusted (0 = standard Debian store, fine)"
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/agent-extra-ca.pem

# ── Architecture mapping ───────────────────────────────────────
RUN if [ "$TARGETARCH" = "arm64" ]; then \
    NVIM_ARCH="arm64"; LUA_ARCH="arm64"; \
  else \
    NVIM_ARCH="x86_64"; LUA_ARCH="x64"; \
  fi \
  && echo "NVIM_ARCH=$NVIM_ARCH" >> /etc/environment \
  && echo "LUA_ARCH=$LUA_ARCH" >> /etc/environment

# ── System dependencies + gh CLI repo ──────────────────────────
# tini   → PID 1 init that reaps orphaned/zombie children (MCP servers,
#          browser helpers) which a plain `sleep infinity` PID 1 ignores.
# git-lfs → pull/push LFS-tracked assets in cloned repos.
# nginx  → run a repo's micro-frontend proxy config NATIVELY (no
#          docker-in-docker). Repos ship `nginx-local/conf.d/*.conf` written
#          for docker-compose; the devops agent rewrites the paths/hosts and
#          serves them with `nginx -c`.
RUN apt-get update && apt-get install -y --no-install-recommends \
  git git-lfs curl jq build-essential python3 unzip ripgrep fd-find fzf \
  htop luarocks tini nginx-light \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# ── Go toolchain ──────────────────────────────────────────────────
RUN . /etc/environment \
  && GO_VERSION=1.26.6 \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

# ── Go tools (parallel) ────────────────────────────────────────
ENV GOBIN=/usr/local/bin
RUN for pkg in \
      github.com/go-delve/delve/cmd/dlv@latest \
      golang.org/x/tools/cmd/goimports@latest \
      golang.org/x/tools/gopls@latest \
      github.com/parvez3019/go-swagger3@latest; do \
      for i in 1 2 3; do \
        go install "$pkg" && break; \
        echo "go install $pkg attempt $i failed, retrying..."; sleep 5; \
        [ "$i" -lt 3 ] || { echo \"FATAL: go install $pkg failed after 3 attempts\"; exit 1; }; \
      done; \
    done \
  # go-arch-lint: optional dev tool, known to lag behind bleeding-edge Go
  # releases. Try once; a failure must not block the image build.
  && go install github.com/fe3dback/go-arch-lint@latest \
     || echo 'WARNING: go-arch-lint not installed (likely Go version skew)' \
  # The compiled binaries live in $GOBIN; the module + build caches and the
  # /tmp/go-build* dirs the parallel installs left behind are ~850MB of pure
  # build residue. Clean them in THIS layer (a later rm would only whiteout).
  && go clean -cache -modcache \
  && rm -rf /tmp/go-build*

# ── golangci-lint ─────────────────────────────────────────────────
# The version comes from the `releases/latest` HTML REDIRECT, never from
# `api.github.com`. The REST API allows 60 unauthenticated requests per hour
# per IP — a budget this network shares with every other build — and its 403
# body arrives as a perfectly normal JSON error, so `jq -r .tag_name` prints
# `null` and the build dies on a 404 for `.../download/null/...`, which reads
# like a missing release. GitHub does not rate-limit the plain redirect, and
# `-f` still fails loudly on 429. The pinned fallback keeps the build working
# if the lookup ever returns nothing at all.
RUN . /etc/environment \
  && GCI_FALLBACK=v2.15.0 \
  && GCI_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/golangci/golangci-lint/releases/latest | sed 's#.*/tag/##') \
  && case "$GCI_VERSION" in v[0-9]*) ;; *) echo "WARN: golangci-lint version lookup returned '$GCI_VERSION' — falling back to ${GCI_FALLBACK}" >&2; GCI_VERSION=$GCI_FALLBACK ;; esac \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/golangci/golangci-lint/releases/download/${GCI_VERSION}/golangci-lint-${GCI_VERSION#v}-linux-${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local/bin --strip-components=1 "golangci-lint-${GCI_VERSION#v}-linux-${TARGETARCH}/golangci-lint"

# ── lazygit ───────────────────────────────────────────────────────
# Unlike golangci-lint and Go, lazygit assets use a lowercase GOOS and its own
# arch names (`x86_64`, not `amd64`).
RUN . /etc/environment \
  && LG_FALLBACK=0.66.2 \
  && LG_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/jesseduffield/lazygit/releases/latest | sed 's#.*/tag/v\?##') \
  && case "$LG_VERSION" in [0-9]*) ;; *) echo "WARN: lazygit version lookup returned '$LG_VERSION' — falling back to ${LG_FALLBACK}" >&2; LG_VERSION=$LG_FALLBACK ;; esac \
  && case "$TARGETARCH" in arm64) LG_ARCH=arm64 ;; *) LG_ARCH=x86_64 ;; esac \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v${LG_VERSION}/lazygit_${LG_VERSION}_linux_${LG_ARCH}.tar.gz" \
  | tar xz -C /usr/local/bin lazygit

# ── Neovim (from official releases) ──────────────────────────────
RUN . /etc/environment \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/neovim/neovim/releases/download/stable/nvim-linux-${NVIM_ARCH}.tar.gz" \
  | tar xz -C /usr/local --strip-components=1

# ── Bun (fast package manager) ─────────────────────────────────
ENV BUN_INSTALL=/opt/bun \
    BUN_INSTALL_CACHE_DIR=/opt/bun-cache
RUN for i in 1 2 3; do \
      curl -fsSL https://bun.sh/install | bash && break; \
      echo "Bun install attempt $i failed, retrying..."; sleep 5; \
      [ "$i" -lt 3 ] || { echo "FATAL: bun install failed after 3 attempts"; exit 1; }; \
    done \
  && "$BUN_INSTALL/bin/bun" --version \
  # Separate bun's download cache from the root-owned BUN_INSTALL dir
  # (shared world-writable so a future bun backend still works unprivileged).
  && mkdir -p "$BUN_INSTALL_CACHE_DIR" && chmod 777 "$BUN_INSTALL_CACHE_DIR"
ENV PATH="/opt/bun/bin:${PATH}"

# ── Shared, world-readable caches for tools installed as root ────
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# ── Node tools (LSP servers, formatters, linters) ────────────────
# Retry loop: Angular publishes @angular/cli before its @angular-devkit/*
# deps, so an unversioned install can hit a registry-propagation window
# where `latest` resolves but the just-published transitive deps do not.
RUN for i in 1 2 3; do \
      bun install -g \
        eslint_d stylelint \
        typescript-language-server bash-language-server \
        vscode-langservers-extracted @angular/language-server \
        @angular/cli playwright puppeteer \
        agent-browser skills \
        && break; \
      echo "Node tools install attempt $i failed, retrying..."; sleep 5; \
      [ "$i" -lt 3 ] || { echo "FATAL: node tools install failed after 3 attempts"; exit 1; }; \
    done \
  && corepack enable \
  && chmod +x /opt/bun/install/global/node_modules/agent-browser/bin/agent-browser-* \
  && AB_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
  && AGENT_BROWSER_BIN=/opt/bun/install/global/node_modules/agent-browser/bin/agent-browser-linux-${AB_ARCH} \
  && if [ -x "$AGENT_BROWSER_BIN" ]; then \
       ln -sf "$AGENT_BROWSER_BIN" /usr/local/bin/agent-browser; \
     else \
       echo "WARNING: agent-browser native binary not found"; \
     fi \
  && find /opt/bun/install/global/node_modules -type f -path '*/bin/*' -exec chmod +x {} + \
  # agent-browser ships a native binary per platform; keep only the one this
  # image can run (glibc linux on the target arch) and drop ~100MB of
  # win32/darwin/musl builds.
  && find "$(dirname "$AGENT_BROWSER_BIN")" -maxdepth 1 -type f \
       -name 'agent-browser-*' ! -name "agent-browser-linux-${AB_ARCH}" -delete

# ── qmd (BM25 search backend for pi-memory) ─────────────────────
# npm (not bun): better-sqlite3 ships prebuilt N-API binaries that real
# Node 24 resolves, while bun's node-ABI handling fails its install script.
RUN npm install -g @tobilu/qmd \
  && npm cache clean --force

# ── Browser-automation browsers ────────────────────────────────
# Install apt libs via the globally-installed playwright CLI (no npx fetch).
RUN playwright install-deps chromium firefox webkit \
  && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
  && chmod 777 "$PLAYWRIGHT_BROWSERS_PATH" \
  && for i in 1 2 3; do \
       playwright install chromium firefox webkit && break; \
       echo "Playwright browser install attempt $i failed, retrying..."; sleep 5; \
       [ "$i" -lt 3 ] || { echo "FATAL: playwright install failed after 3 attempts"; exit 1; }; \
     done \
  # playwright install создаёт .links/ с правами 755 (root-only запись) —
  # без chmod -R последующие вызовы playwright install (в т.ч. из проектов,
  # где агент работает под uid 1000) падают с EACCES на .links/. Рекурсивный
  # chmod после установки чинит это для всех агентов в контейнере.
  && chmod -R 777 "$PLAYWRIGHT_BROWSERS_PATH" \
  # Puppeteer's Chrome-for-Testing would duplicate the Playwright Chromium
  # installed just above. The puppeteer API stays available, but resolves the
  # shared system Chromium via PUPPETEER_EXECUTABLE_PATH (set with the
  # agent-browser ENV further down) instead of downloading ~660MB more.
  #
  # agent-browser needs a discoverable Chrome/Chromium binary.
  # Chrome for Testing has no Linux ARM64 build, so install
  # system Chromium (Debian bookworm ships one) and point
  # agent-browser at it via AGENT_BROWSER_EXECUTABLE_PATH (set in
  # the ENV below).  Playwright's install-deps above already pulled
  # the shared libraries agent-browser expects.  Do NOT run
  # `agent-browser install` here: it only downloads Chrome for
  # Testing, which fails on ARM64.
  # Smoke-test the agent-browser→Chromium wiring now (`doctor` does a
  # live headless launch); --no-sandbox is required in containers.
  && apt-get update && apt-get install -y --no-install-recommends chromium \
  && AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
     AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage" \
     agent-browser doctor --offline \
  && rm -rf /var/lib/apt/lists/*

# Browserless: separate service (browserless/chrome), not installed here.
#   Run alongside: docker run -p 3000:3000 browserless/chrome

# ── Lua LSP ──────────────────────────────────────────────────────
RUN . /etc/environment \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/LuaLS/lua-language-server/releases/download/3.14.0/lua-language-server-3.14.0-linux-${LUA_ARCH}.tar.gz" \
  | tar xz -C /usr/local/bin

# ── web-search-mcp ───────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/mrkrsl/web-search-mcp.git /opt/web-search-mcp \
  && cd /opt/web-search-mcp \
  && bun install \
  && bun run build \
  # This repo pins an older playwright-core, while the global playwright
  # above installed newer revisions into PLAYWRIGHT_BROWSERS_PATH. Skip the
  # duplicate browser download and alias the pinned revision names onto the
  # installed builds — Playwright resolves builds purely by directory name.
  # Both sides are derived at build time so a Playwright bump can't leave
  # the aliases dangling: the pinned names come from the repo's own
  # browsers.json, the targets are the newest installed dir of each kind.
  #
  # chromium needs extra care: versions ≥1.63 lay out the binary at
  # chrome-linux-arm64/chrome (or -x64), while 1.54.2 expects the generic
  # chrome-linux/chrome. A bare top-level symlink doesn't bridge the inner
  # arch-suffix. For chromium we create a thunk directory with inner aliases;
  # other browsers (firefox, webkit, ffmpeg) get a plain symlink.
  && PW_BROWSERS_JSON=/opt/web-search-mcp/node_modules/playwright-core/browsers.json \
  && cd "$PLAYWRIGHT_BROWSERS_PATH" \
  && jq -r '.browsers[] | select(.installByDefault) | "\(.name) \(.revision)"' \
       "$PW_BROWSERS_JSON" \
     | while read -r name rev; do \
         base="$(printf '%s' "$name" | tr '-' '_')"; \
         dir="${base}-${rev}"; \
         [ -e "$dir" ] && continue; \
         target="$(find . -maxdepth 1 -mindepth 1 -type d -name "${base}-*" | sort -V | tail -n1)"; \
         if [ -z "$target" ]; then continue; fi; \
         case "$base" in \
           chromium*) \
             # Inner layout changed from chrome-linux/{chrome,headless_shell}
             # to chrome-linux-<arch>/chrome with headless in a separate dir.
             # The headless_shell entry (chromium_headless_shell) also needs
             # a thunk — the 1.54.2 inner path chrome-linux/headless_shell
             # resolves to chrome-headless-shell-linux-<arch>/ in 1.63.
             # Try a thunk dir with inner aliases; if the expected layout is
             # absent, fall back to plain symlink so the build doesn't break.
             { mkdir -p "$dir/chrome-linux" && \
               if [ "$base" = "chromium" ]; then \
                 # Main chromium: chrome from own dir, headless_shell from
                 # the separate headless_shell dir
                 src_chrome="$(find "$target" -maxdepth 2 -name chrome \
                                -not -path '*/nacl*' | head -n1)" && \
                 hs_src_dir="$(find . -maxdepth 1 -type d \
                                -name 'chromium_headless_shell-*' | sort -V | tail -n1)"; \
               else \
                 # chromium_headless_shell: only headless_shell, from own dir
                 src_chrome=""; \
                 hs_src_dir="$target"; \
               fi && \
               { [ -z "$src_chrome" ] || \
                 ln -sf "../../${src_chrome#./}" "$dir/chrome-linux/chrome"; } && \
               src_hs="$(find "$hs_src_dir" -maxdepth 2 \
                          -name 'chrome-headless-shell' | head -n1)" && \
               [ -n "$src_hs" ] && \
               ln -sf "../../${src_hs#./}" "$dir/chrome-linux/headless_shell" && \
               echo "  alias $dir -> thunk"; } || \
             { rm -rf "$dir" && ln -sfn "${target#./}" "$dir" && \
               printf '  WARNING: chromium thunk failed for %s, fallback symlink %s -> %s\n' \
                 "$dir" "$dir" "${target#./}"; };; \
           *) \
             ln -sfn "${target#./}" "$dir" && \
             echo "  alias $dir -> ${target#./}";; \
         esac; \
       done

# ── UID/GID alignment with host ──────────────────────────────────
ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# ── Pi coding agent ──────────────────────────────────────────────
# Point agent-browser at system Chromium (Chrome for Testing has no ARM64).
# --no-sandbox is required to launch Chromium inside a container.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage" \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN bun install -g @earendil-works/pi-coding-agent \
  # Drop the download cache (keep the dir: it stays world-writable for
  # unprivileged future `bun install`s).
  && rm -rf "${BUN_INSTALL_CACHE_DIR:?}"/*

USER agent
WORKDIR /home/agent
ENV GOPATH="/home/agent/go"
ENV PATH="/home/agent/go/bin:${PATH}"

# ── Seed pi config so package installs find the packages to install ──
# Host pi/settings.json is copied later (kept LAST so dotfile edits don't
# invalidate the heavy installs). Seed a minimal config now; the finalize
# step below merges the installed `packages` back in. No `npmCommand` is
# set, so pi falls back to its default `npm` backend.
RUN BASE_PKGS='{"packages":["npm:pi-lens","npm:@narumitw/pi-goal","npm:pi-agents-talk-to-each-other","npm:pi-memory"]}' \
  && mkdir -p /home/agent/.pi/agent/npm /home/agent/.pi/agent/sessions \
               /home/agent/.pi/agent/memory \
  && printf '%s\n' "$BASE_PKGS" > /home/agent/.pi/agent/settings.json \
  && printf '%s\n' '{"name":"pi-extensions","private":true}' \
       > /home/agent/.pi/agent/npm/package.json

# ── Pi packages: ONE install of everything in settings.json ─────
# `pi update --extensions` resolves + installs every package listed in
# settings.json in a single `npm install` (the old approach ran 4× `pi
# install` + a separate update, each a full `npm install`).
RUN for i in 1 2 3; do \
      pi update --extensions --no-approve && break; \
      echo "Pi packages attempt $i failed, retrying..."; sleep 5; \
      [ "$i" -lt 3 ] || { echo "FATAL: pi package install failed after 3 attempts"; exit 1; }; \
    done \
  # Drop install/download caches in the SAME layer that produced them (a
  # later `rm` only whiteouts and still ships the bytes). yarn/go-build/qmd
  # are defensive: today they are runtime caches, but if a future install
  # step populates them they must not be baked into the image. qmd models
  # in particular are dead weight while PI_MEMORY_QMD_UPDATE=off.
  && rm -rf /home/agent/.npm /home/agent/.cache/yarn \
            /home/agent/.cache/go-build /home/agent/.cache/qmd

# ── Per-process room override (PI_AGENT_ROOM) ────────────────────
# Honor PI_AGENT_ROOM so each task forces its own room (issue-resolver
# sets issue-<id>) above the global defaultRoom. Fail loudly if upstream
# reshapes the line this patch anchors to.
RUN ROOM_EXT=/home/agent/.pi/agent/npm/node_modules/pi-agents-talk-to-each-other/extensions/agent-room/index.ts \
  && grep -q 'const defaultRoom = readConfig().defaultRoom;' "$ROOM_EXT" \
  && sed -i 's/const defaultRoom = readConfig().defaultRoom;/const defaultRoom = process.env.PI_AGENT_ROOM || readConfig().defaultRoom;/' "$ROOM_EXT" \
  && grep -q "process.env.PI_AGENT_ROOM" "$ROOM_EXT" \
  || { echo "ERROR: room extension anchor not found — PI_AGENT_ROOM patch failed"; exit 1; }

# ── Remote skills: parallel git clone --depth 1 ─────────────────
# (no skills CLI → no simple-git hangs). Format: repo:subpath.
# `writing-great-skills` was renamed upstream to `writing-for-agents`
# (mattpocock/skills) — the stale path 404s and the clone loop used to
# swallow it; only the live name is listed, and the loop now fails the build
# if any listed source is missing.
RUN git config --global protocol.version 2 \
  && git config --global --add safe.directory /home/agent/workspace \
  && export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
  && TMP=/tmp/skills-clone-$$ && mkdir -p "$TMP" "$HOME/.agents/skills" \
  && set -- \
       "vercel-labs/agent-browser:skills/agent-browser" \
       "juliusbrussee/caveman:skills/caveman" \
       "juliusbrussee/caveman:skills/ultracave" \
       "juliusbrussee/caveman:skills/megacave" \
       "mattpocock/skills:skills/engineering/domain-modeling" \
       "mattpocock/skills:skills/engineering/code-review" \
       "mattpocock/skills:skills/engineering/wayfinder" \
       "mattpocock/skills:skills/engineering/codebase-design" \
       "mattpocock/skills:skills/engineering/tdd" \
       # PR body shape — the original (credits: Dex Horthy / Humanlayer show-me).
       # Our own fork of it is gone: two versions of one contract drift silently.
       "mattpocock/skills:skills/engineering/pr" \
       "mattpocock/skills:skills/engineering/diagnosing-bugs" \
       "obra/superpowers:skills/verification-before-completion" \
       "mattpocock/skills:skills/engineering/retro" \
       # Interview-by-design-tree method; `wayfinder` calls Skill("grilling") in
       # four places, so installing the original repairs those references and
       # keeps upstream updates. `agent-skills/refine` is a thin adapter over it.
       "mattpocock/skills:skills/productivity/grilling" \
       "mattpocock/skills:skills/productivity/to-questionnaire" \
       "mattpocock/skills:skills/productivity/teach" \
       "mattpocock/skills:skills/productivity/writing-for-agents" \
       "vercel-labs/agent-skills:skills/web-design-guidelines" \
       "dietrichgebert/ponytail:skills/ponytail" \
       "yonatangross/orchestkit:src/skills/glyph" \
       # Visual craft for human-facing artifacts. Portable (no MCP, no Claude-Code
       # frontmatter) — unlike orchestkit's `visualize-plan`, which needs
       # memory/page-serve/notebooklm MCP servers we do not ship.
       "anthropics/skills:skills/frontend-design" \
       "anthropics/skills:skills/theme-factory" \
  && repos="" \
  && for entry; do \
       r="${entry%%:*}"; \
       case " $repos " in *" $r "*) ;; *) repos="$repos $r";; esac; \
     done \
  && pids="" \
  && for repo in $repos; do \
       git clone --depth 1 --single-branch \
         "https://github.com/$repo.git" "$TMP/$repo" & \
       pids="$pids $!"; \
     done \
  && for p in $pids; do wait "$p" || echo "Clone failed: $p"; done \
  && missing="" \
  && for entry; do \
       repo="${entry%%:*}"; subpath="${entry#*:}"; \
       if [ "$subpath" = "." ]; then \
         skill="$(basename "$repo")"; src="$TMP/$repo"; \
       else \
         skill="$(basename "$subpath")"; src="$TMP/$repo/$subpath"; \
       fi; \
       # A failed clone (network hiccup, renamed/removed upstream path) must
       # not silently drop a skill: record it and fail after the loop.
       if [ -d "$src" ]; then \
         cp -r "$src" "$HOME/.agents/skills/$skill" && echo "  -> $skill"; \
       else \
         echo "WARNING: skill source missing: $repo/$subpath"; \
         missing="$missing $skill"; \
       fi; \
     done \
  && if [ -n "$missing" ]; then \
       echo "FATAL: remote skill(s) missing after clone:$missing" >&2; \
       exit 1; \
     fi \
  && rm -rf "$TMP" \
  && mkdir -p "$HOME/.agents/skills/clean-code" \
  && curl -fsSL \
       "https://raw.githubusercontent.com/sickn33/agentic-awesome-skills/main/skills/clean-code/SKILL.md" \
       -o "$HOME/.agents/skills/clean-code/SKILL.md" \
  && echo "  -> clean-code"

# Stash the package state (tiny) so the host config COPY below can't drop it.
RUN jq -c '{packages: (.packages // [])}' \
    /home/agent/.pi/agent/settings.json > /tmp/pi-pkg-meta.json

# ── Host config (volatile — kept LAST so edits only bust this layer) ──
COPY --chown=agent:agent pi/ /tmp/pi-config/
# GLOBAL_AGENTS.md must NOT land in /tmp/pi-config: `pi/AGENTS.md` is a
# symlink and `COPY pi/` restores it over any file we put there. Stage it
# separately and overwrite the symlink in the finalize step below.
COPY --chown=agent:agent GLOBAL_AGENTS.md /tmp/GLOBAL_AGENTS.md
COPY --chown=agent:agent nvim/ /home/agent/.config/nvim/
COPY --chown=agent:agent agent-skills/ /home/agent/.agents/skills/

# ── Finalize pi config → ~/.pi/agent/ ───────────────────────────
# Overwrite (or create) the web-search entry in the CONTAINER's config copy.
# The host mcp.json is host-specific (stale macOS paths, varies per
# machine, entry may be missing or disabled), so the image does not trust it.
# env points the server's bundled playwright at the shared browser cache
# (its pinned playwright-core resolves builds from PLAYWRIGHT_BROWSERS_PATH;
# without it it falls back to an empty ~/.cache/ms-playwright and every
# search dies with "Search engine: None; 0 results").
RUN jq '.mcpServers["web-search"] = {"command": "node", "args": ["/opt/web-search-mcp/dist/index.js"], "enabled": true, "env": {"PLAYWRIGHT_BROWSERS_PATH": "/opt/ms-playwright"}}' \
    /tmp/pi-config/mcp.json > /tmp/pi-config/mcp.json.new \
  && mv /tmp/pi-config/mcp.json.new /tmp/pi-config/mcp.json \
  && mkdir -p /home/agent/.pi/agent \
  # Copy host config but exclude any host-arch `npm/` (macOS binaries) so it
  # can't clobber the container packages installed above.
  && tar --exclude='./npm' -C /tmp/pi-config -cf - . \
     | tar -C /home/agent/.pi/agent -xf - \
  && rm -f /home/agent/.pi/agent/extensions/permissions.ts \
  # Rewrite localhost/127.0.0.1 → host.docker.internal in mcp.json
  # URLs so MCP bridges running on the host are reachable from the container.
  && mv /home/agent/.pi/agent/mcp.json /tmp/mcp-in.json \
  && jq 'walk(if type == "object" and has("url") then .url |= gsub("://(?<host>localhost|127\\.0\\.0\\.1)(?<rest>[:/])"; "://host.docker.internal\(.rest)") else . end)' \
       /tmp/mcp-in.json > /home/agent/.pi/agent/mcp.json \
  && rm -f /tmp/mcp-in.json \
  # `pi/AGENTS.md` arrives as a symlink to ../GLOBAL_AGENTS.md — correct on
  # the host, dangling inside the image. A dangling rules file means every
  # agent silently runs with NO shared rules, so replace it with the real
  # file staged above.
  && cp --remove-destination /tmp/GLOBAL_AGENTS.md \
       /home/agent/.pi/agent/AGENTS.md \
  && rm -f /tmp/GLOBAL_AGENTS.md \
  # Host pi/ config may carry ~/.pi/agent/bin/{fd,rg} downloaded for the HOST
  # arch (e.g. macOS arm64 Mach-O). pi picks bin/ first by existence only,
  # so a wrong-arch binary shadows system fd/fdfind and silently breaks
  # @ file autocomplete (Exec format error, swallowed). Drop it; pi then
  # falls back to system fd (symlinked above) or re-downloads correctly.
  && rm -rf /home/agent/.pi/agent/bin \
  # Re-apply the packages installed during the build.
  && jq -s '.[0] * .[1]' \
       /home/agent/.pi/agent/settings.json /tmp/pi-pkg-meta.json \
       > /tmp/pi-settings.merged \
  && mv /tmp/pi-settings.merged /home/agent/.pi/agent/settings.json \
  && rm -rf /tmp/pi-config /tmp/pi-pkg-meta.json

# ── pi-lens default posture ──────────────────────────────────────
# Auto-format OFF by default in the container. pi-lens's formatter
# auto-detect would otherwise reformat files with its own Biome/Prettier
# fallback even when the project only declares eslint_d, so formatting is
# left to the project's own tooling. A repo can opt back in with
# `{"format": {"enabled": true}}` in its own `.pi-lens.json`.
RUN mkdir -p /home/agent/.pi-lens \
  && printf '%s\n' '{"format":{"enabled":false}}' \
       > /home/agent/.pi-lens/config.json

# ── Pre-trust workspace + sessions/memory volumes ─────────────
# Mount sessions at runtime: -v agent-sessions:/home/agent/.pi/agent/sessions
# Mount memory at runtime:  -v agent-memory:/home/agent/.pi/agent/memory
#
# Both dirs MUST exist in the image before a volume is mounted over them:
# Docker seeds a new named volume from the image's content (ownership
# included), but a volume at a path the image lacks comes up root:root and
# the agent user cannot write to it.
#
# The memory dir is deliberately NOT ~/.pi/agent itself — a volume there
# would shadow the baked settings.json/models.json/mcp.json/npm
# and break the package setup installed above.
RUN mkdir -p /home/agent/.pi/agent/sessions /home/agent/.pi/agent/memory \
      /home/agent/.pi/agent/rooms \
  && echo '{"/home/agent/workspace":true}' > /home/agent/.pi/agent/trust.json
# pi-memory stores MEMORY.md + daily logs here (env var, not config file).
ENV PI_MEMORY_DIR=/home/agent/.pi/agent/memory
# Disable background qmd embedding — the GGUF models peak container/host CPU
# with no GPU passthrough from macOS. Keyword (BM25) search still works; the
# agent defaults to it (see GLOBAL_AGENTS.md). Set to "background" to re-enable.
ENV PI_MEMORY_QMD_UPDATE=off
VOLUME /home/agent/.pi/agent/sessions
VOLUME /home/agent/.pi/agent/memory
VOLUME /home/agent/.pi/agent/rooms

# ── PID 1 init ───────────────────────────────────────────────────
# tini as PID 1 reaps zombie children (chrome-devtools-mcp, browser helpers)
# that a plain `sleep infinity` init ignores. The launch scripts
# (spawn-pi-agent.sh / attach.sh) override the ENTRYPOINT with
# `--entrypoint sleep`, so they pass `--init` instead to get the same
# docker-init (tini) reaper at PID 1. docker-compose.yml keeps the
# ENTRYPOINT below (it only overrides `command`).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

