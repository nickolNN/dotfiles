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

# ── System dependencies ──────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl jq build-essential python3 unzip ripgrep fd-find fzf \
  htop luarocks chromium \
  && ln -s /usr/bin/chromium /usr/local/bin/chromium \
  && rm -rf /var/lib/apt/lists/*

# ── Go toolchain ──────────────────────────────────────────────────
RUN . /etc/environment \
  && GO_VERSION=1.26.6 \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

# ── Go tools ──────────────────────────────────────────────────────
ENV GOBIN=/usr/local/bin
RUN for i in 1 2 3; do \
    go install github.com/go-delve/delve/cmd/dlv@latest \
      && go install golang.org/x/tools/cmd/goimports@latest \
      && go install golang.org/x/tools/gopls@latest \
      && go install github.com/fe3dback/go-arch-lint@latest \
      && go install github.com/parvez3019/go-swagger3@latest \
      && break; \
    echo "Go tools attempt $i failed, retrying..."; sleep 5; \
  done

# ── golangci-lint ─────────────────────────────────────────────────
RUN . /etc/environment \
  && GCI_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -s https://api.github.com/repos/golangci/golangci-lint/releases/latest | jq -r .tag_name) \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/golangci/golangci-lint/releases/download/${GCI_VERSION}/golangci-lint-${GCI_VERSION#v}-linux-${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local/bin --strip-components=1 "golangci-lint-${GCI_VERSION#v}-linux-${TARGETARCH}/golangci-lint"

# ── k9s ───────────────────────────────────────────────────────────
RUN . /etc/environment \
  && K9S_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -s https://api.github.com/repos/derailed/k9s/releases/latest | jq -r .tag_name) \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/k9s_Linux_${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local/bin k9s

# ── lazygit ───────────────────────────────────────────────────────
RUN . /etc/environment \
  && LG_VERSION=$(curl --retry 3 --retry-delay 5 --retry-all-errors -s https://api.github.com/repos/jesseduffield/lazygit/releases/latest | jq -r .tag_name | sed 's/^v//') \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/jesseduffield/lazygit/releases/download/v${LG_VERSION}/lazygit_${LG_VERSION}_Linux_${TARGETARCH}.tar.gz" \
  | tar xz -C /usr/local/bin lazygit

# ── GitHub CLI ───────────────────────────────────────────────────
RUN curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# ── Neovim (from official releases) ──────────────────────────────
RUN . /etc/environment \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/neovim/neovim/releases/download/stable/nvim-linux-${NVIM_ARCH}.tar.gz" \
  | tar xz -C /usr/local --strip-components=1

# ── Node tools (LSP servers, formatters, linters) ────────────────
RUN npm install -g \
  eslint_d stylelint \
  typescript-language-server bash-language-server \
  vscode-langservers-extracted @angular/language-server \
  @angular/cli playwright puppeteer selenium-webdriver cypress \
  agent-browser \
  && corepack enable \
  && AGENT_BROWSER_BIN=$(ls /usr/local/lib/node_modules/agent-browser/agent-browser-linux-* 2>/dev/null | head -1) \
  && if [ -n "$AGENT_BROWSER_BIN" ]; then \
       ln -sf "$AGENT_BROWSER_BIN" /usr/local/bin/agent-browser; \
     else \
       echo "WARNING: agent-browser native binary not found"; \
     fi

# ── Browser-automation browsers ────────────────────────────────
# Puppeteer downloads its own Chrome during npm install (above)
RUN npx cypress install

# ── Playwright system dependencies (root) ────────────────────────
RUN apt-get update \
  && for i in 1 2 3; do \
       npx playwright install-deps chromium firefox webkit && break; \
       echo "Attempt $i failed, retrying..."; sleep 5; \
     done
# Browserless: separate service (browserless/chrome), not installed here.
#   Run alongside: docker run -p 3000:3000 browserless/chrome

# ── Lua LSP ──────────────────────────────────────────────────────
RUN . /etc/environment \
  && curl --retry 3 --retry-delay 5 --retry-all-errors -fsSL "https://github.com/LuaLS/lua-language-server/releases/download/3.14.0/lua-language-server-3.14.0-linux-${LUA_ARCH}.tar.gz" \
  | tar xz -C /usr/local/bin

# ── web-search-mcp ───────────────────────────────────────────────
RUN git clone https://github.com/mrkrsl/web-search-mcp.git /opt/web-search-mcp \
  && cd /opt/web-search-mcp \
  && npm install \
  && npm run build

# ── UID/GID alignment with host ──────────────────────────────────
ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# ── Pi coding agent ──────────────────────────────────────────────
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2

USER agent
WORKDIR /home/agent
ENV GOPATH="/home/agent/go"
ENV PATH="/home/agent/go/bin:${PATH}"

# ── Pi config → ~/.pi/agent/ (default location) ──────────────────
COPY --chown=agent:agent pi/ /tmp/pi-config/

# Fix web-search-mcp path for container
RUN sed -i \
  's|/Users/nickolaylobanov/code/web-search-mcp/dist/index.js|/opt/web-search-mcp/dist/index.js|g' \
  /tmp/pi-config/mcp.json

# AGENTS.md is a symlink → resolve it from GLOBAL_AGENTS.md
COPY --chown=agent:agent GLOBAL_AGENTS.md /tmp/global-agents.md
RUN rm /tmp/pi-config/AGENTS.md \
  && cp /tmp/global-agents.md /tmp/pi-config/AGENTS.md \
  && rm /tmp/global-agents.md

# Move to default Pi config dir, remove host-only permissions extension
RUN mkdir -p /home/agent/.pi/agent \
  && cp -r /tmp/pi-config/* /home/agent/.pi/agent/ \
  && rm -f /home/agent/.pi/agent/extensions/permissions.ts \
  && rm -rf /tmp/pi-config

# Pi packages
RUN pi install npm:pi-mcp-adapter \
  && pi install npm:pi-lens \
  && pi install npm:@narumitw/pi-goal

# ── Skills ────────────────────────────────────────────────────────
RUN git config --global http.postBuffer 524288000 \
  && for i in 1 2 3; do \
       npx skills add vercel-labs/agent-browser --skill agent-browser -y \
         && npx skills add juliusbrussee/caveman --skill caveman -y \
         && npx skills add sickn33/agentic-awesome-skills --skill clean-code -y \
         && npx skills add mattpocock/skills --skill domain-modeling --skill grill-with-docs -y \
         && npx skills add anthropics/skills --skill frontend-design -y \
         && npx skills add dietrichgebert/ponytail --skill ponytail -y \
         && break; \
       echo "Skills attempt $i failed, retrying..."; sleep 5; \
     done

# ── Neovim config → ~/.config/nvim/ ──────────────────────────────
COPY --chown=agent:agent nvim/ /home/agent/.config/nvim/

# Pre-install LazyVim plugins and Mason tools
RUN nvim --headless '+Lazy sync' '+qa' 2>/dev/null || true
RUN nvim --headless '+MasonToolsInstall' '+qa' 2>/dev/null || true

# ── Playwright browsers (agent user) ─────────────────────────────
RUN for i in 1 2 3; do \
      npx playwright install chromium firefox webkit && break; \
      echo "Attempt $i failed, retrying..."; sleep 5; \
    done

# ── Pre-trust the workspace ─────────────────────────────────────
RUN mkdir -p /home/agent/.pi/agent \
  && echo '{"/home/agent/workspace":true}' > /home/agent/.pi/agent/trust.json

# ── Agent sessions volume ────────────────────────────────────────
# Mount at runtime: -v ~/.agent-sessions:/home/agent/.pi/agent/sessions
RUN mkdir -p /home/agent/.pi/agent/sessions
VOLUME /home/agent/.pi/agent/sessions

