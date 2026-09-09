FROM --platform=$BUILDPLATFORM node:24-bookworm

ARG TARGETARCH

# ── Architecture mapping ───────────────────────────────────────
RUN if [ "$TARGETARCH" = "arm64" ]; then \
    NVIM_ARCH="arm64"; LUA_ARCH="arm64"; \
  else \
    NVIM_ARCH="x86_64"; LUA_ARCH="x64"; \
  fi \
  && echo "NVIM_ARCH=$NVIM_ARCH" >> /etc/environment \
  && echo "LUA_ARCH=$LUA_ARCH" >> /etc/environment

# ── System dependencies + gh CLI repo ──────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl jq build-essential python3 unzip ripgrep fd-find fzf \
  htop luarocks \
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
RUN for i in 1 2 3; do \
    pids="" \
    && go install github.com/go-delve/delve/cmd/dlv@latest & pids="$pids $!" \
    && go install golang.org/x/tools/cmd/goimports@latest & pids="$pids $!" \
    && go install golang.org/x/tools/gopls@latest & pids="$pids $!" \
    && go install github.com/fe3dback/go-arch-lint@latest & pids="$pids $!" \
    && go install github.com/parvez3019/go-swagger3@latest & pids="$pids $!" \
    && fails=0; for p in $pids; do wait $p || fails=$((fails+1)); done \
    && [ $fails -eq 0 ] && break; \
    echo "Go tools attempt $i had $fails failure(s), retrying..."; sleep 5; \
    [ "$i" -lt 3 ] || { echo "FATAL: Go tools install failed after 3 attempts ($fails failures)"; exit 1; }; \
  done

# ── golangci-lint ─────────────────────────────────────────────────
RUN . /etc/environment \
  && GCI_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -s https://api.github.com/repos/golangci/golangci-lint/releases/latest | jq -r .tag_name) \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/golangci/golangci-lint/releases/download/${GCI_VERSION}/golangci-lint-${GCI_VERSION#v}-linux-${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local/bin --strip-components=1 "golangci-lint-${GCI_VERSION#v}-linux-${TARGETARCH}/golangci-lint"

# ── lazygit ───────────────────────────────────────────────────────
RUN . /etc/environment \
  && LG_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -s https://api.github.com/repos/jesseduffield/lazygit/releases/latest | jq -r .tag_name | sed 's/^v//') \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v${LG_VERSION}/lazygit_${LG_VERSION}_Linux_${TARGETARCH}.tar.gz" \
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
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PUPPETEER_CACHE_DIR=/opt/puppeteer-cache

# ── Node tools (LSP servers, formatters, linters) ────────────────
RUN bun install -g \
  eslint_d stylelint \
  typescript-language-server bash-language-server \
  vscode-langservers-extracted @angular/language-server \
  @angular/cli playwright puppeteer \
  agent-browser skills \
  && corepack enable \
  && chmod +x /opt/bun/install/global/node_modules/agent-browser/bin/agent-browser-* \
  && AB_ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
  && AGENT_BROWSER_BIN=/opt/bun/install/global/node_modules/agent-browser/bin/agent-browser-linux-${AB_ARCH} \
  && if [ -x "$AGENT_BROWSER_BIN" ]; then \
       ln -sf "$AGENT_BROWSER_BIN" /usr/local/bin/agent-browser; \
     else \
       echo "WARNING: agent-browser native binary not found"; \
     fi \
  && find /opt/bun/install/global/node_modules -type f -path '*/bin/*' -exec chmod +x {} +

# ── Browser-automation browsers ────────────────────────────────
# Install apt libs via the globally-installed playwright CLI (no npx fetch).
RUN playwright install-deps chromium firefox webkit \
  && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" "$PUPPETEER_CACHE_DIR" \
  && chmod 777 "$PLAYWRIGHT_BROWSERS_PATH" "$PUPPETEER_CACHE_DIR" \
  && for i in 1 2 3; do \
       playwright install chromium firefox webkit && break; \
       echo "Playwright browser install attempt $i failed, retrying..."; sleep 5; \
       [ "$i" -lt 3 ] || { echo "FATAL: playwright install failed after 3 attempts"; exit 1; }; \
     done \
  && for i in 1 2 3; do \
       puppeteer browsers install chrome && break; \
       echo "Puppeteer browser install attempt $i failed, retrying..."; sleep 5; \
       [ "$i" -lt 3 ] || { echo "FATAL: puppeteer browsers install failed after 3 attempts"; exit 1; }; \
     done

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
  # This repo pins an older playwright-core (1.54.2 → chromium-1181 /
  # firefox-1489), while the global playwright above already installed the
  # newer revisions (1234/1538) into PLAYWRIGHT_BROWSERS_PATH. Skip the
  # duplicate browser download and alias the pinned revision names onto
  # the newer builds — Playwright resolves builds purely by directory
  # name. Guarded so it is a no-op if the pinned revision ever exists.
  && cd "$PLAYWRIGHT_BROWSERS_PATH" \
  && for pair in \
       "chromium-1181 chromium-1234" \
       "chromium_headless_shell-1181 chromium_headless_shell-1234" \
       "firefox-1489 firefox-1538"; \
     do set -- $pair; [ -e "$1" ] || ln -s "$2" "$1"; done \
  && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

# ── UID/GID alignment with host ──────────────────────────────────
ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# ── Pi coding agent ──────────────────────────────────────────────
RUN bun install -g @earendil-works/pi-coding-agent

USER agent
WORKDIR /home/agent
ENV GOPATH="/home/agent/go"
ENV PATH="/home/agent/go/bin:${PATH}"

# ── Seed pi config so package installs find the packages to install ──
# Host pi/settings.json is copied later (kept LAST so dotfile edits don't
# invalidate the heavy installs). Seed a minimal config now; the finalize
# step below merges the installed `packages` back in. No `npmCommand` is
# set, so pi falls back to its default `npm` backend.
RUN mkdir -p /home/agent/.pi/agent/npm /home/agent/.pi/agent/sessions \
  && printf '%s\n' \
       '{"packages":["npm:pi-mcp-adapter","npm:pi-lens","npm:@narumitw/pi-goal","npm:pi-agents-talk-to-each-other"]}' \
       > /home/agent/.pi/agent/settings.json \
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
    done

# ── Remote skills: parallel git clone --depth 1 ─────────────────
# (no skills CLI → no simple-git hangs). Format: repo:subpath.
RUN git config --global protocol.version 2 \
  && export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true \
  && TMP=/tmp/skills-clone-$$ && mkdir -p "$TMP" "$HOME/.agents/skills" \
  && set -- \
       "vercel-labs/agent-browser:skills/agent-browser" \
       "juliusbrussee/caveman:skills/caveman" \
       "mattpocock/skills:skills/engineering/domain-modeling" \
       "mattpocock/skills:skills/engineering/grill-with-docs" \
       "mattpocock/skills:skills/productivity/handoff" \
       "joneshong-skills/writing-great-skills:." \
       "anthropics/skills:skills/frontend-design" \
       "dietrichgebert/ponytail:skills/ponytail" \
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
  && for entry; do \
       repo="${entry%%:*}"; subpath="${entry#*:}"; \
       if [ "$subpath" = "." ]; then \
         skill="$(basename "$repo")"; src="$TMP/$repo"; \
       else \
         skill="$(basename "$subpath")"; src="$TMP/$repo/$subpath"; \
       fi; \
       cp -r "$src" "$HOME/.agents/skills/$skill" && echo "  -> $skill"; \
     done \
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
COPY --chown=agent:agent GLOBAL_AGENTS.md /tmp/pi-config/AGENTS.md
COPY --chown=agent:agent nvim/ /home/agent/.config/nvim/
COPY --chown=agent:agent agent-skills/ /home/agent/.agents/skills/

# ── Finalize pi config → ~/.pi/agent/ ───────────────────────────
# Overwrite (or create) the web-search entry in the CONTAINER's config copy.
# The host mcp.json is host-specific (stale macOS paths, varies per machine,
# entry may be missing or disabled), so the image does not trust it.
# env points the server's bundled playwright at the shared browser cache
# (its pinned playwright-core resolves builds from PLAYWRIGHT_BROWSERS_PATH;
# without it it falls back to an empty ~/.cache/ms-playwright and every
# search dies with "Search engine: None; 0 results").
RUN jq '.mcpServers["web-search"] = {"command": "node", "args": ["/opt/web-search-mcp/dist/index.js"], "disabled": false, "env": {"PLAYWRIGHT_BROWSERS_PATH": "/opt/ms-playwright"}}' \
    /tmp/pi-config/mcp.json > /tmp/pi-config/mcp.json.new \
  && mv /tmp/pi-config/mcp.json.new /tmp/pi-config/mcp.json \
  && mkdir -p /home/agent/.pi/agent \
  # Copy host config but exclude any host-arch `npm/` (macOS binaries) so it
  # can't clobber the container packages installed above.
  && tar --exclude='./npm' -C /tmp/pi-config -cf - . \
     | tar -C /home/agent/.pi/agent -xf - \
  && rm -f /home/agent/.pi/agent/extensions/permissions.ts \
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

# ── Pre-trust workspace + sessions volume ──────────────────────
# Mount sessions at runtime: -v ~/.agent-sessions:/home/agent/.pi/agent/sessions
RUN mkdir -p /home/agent/.pi/agent/sessions \
  && echo '{"/home/agent/workspace":true}' > /home/agent/.pi/agent/trust.json
VOLUME /home/agent/.pi/agent/sessions

