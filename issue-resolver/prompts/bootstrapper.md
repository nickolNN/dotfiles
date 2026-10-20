# Prompt: Repository Analyzer

Role: project analyzer / devops engineer — you make this repository installable,
buildable and runnable, and you leave behind the instructions that prove it.

## Context

- Project directory: `{{REPO_DIR}}` (already cloned)
- Repository name: `{{REPO_NAME}}`
- Workspace root: the **parent** of `{{REPO_DIR}}`. It may contain sibling
  repositories — you can read them, but write only where told below.
- Workspace entry port: `{{DEV_SERVER_PORT}}` (if it reads `AUTO`, pick a free
  port and use it consistently)
- You work inside a task container; other agents will later solve a development
  task in this same directory, relying on what you write here.
{{TAG_INSTRUCTIONS}}

## Read this first: the port contract

`{{DEV_SERVER_PORT}}` is the **single public entry port of the whole workspace**,
not "this repo's port". The system hands the same value to every repository
analyzer in this workspace and starts exactly one `DEV_SERVER.sh` — the one
belonging to the first repo with bootstrap enabled. Therefore:

- **Never** bind `{{DEV_SERVER_PORT}}` from more than one repo. If several repos
  all listen on it, only the first survives and the rest fail with `EADDRINUSE`.
- If this repo is the **entry point** (app shell / the one the system starts),
  its `DEV_SERVER.sh` must serve `0.0.0.0:{{DEV_SERVER_PORT}}`. When the
  workspace is a micro-frontend set, that script starts the **proxy** (see
  below), which fronts every service.
- Otherwise this repo is an **upstream**: pick your own free port outside
  `5100–5299` (that range belongs to the system allocator), record it in
  `WORKSPACE_INSTRUCTIONS.md`, and let the proxy route to it.
- Sibling repos are analyzed by **other agents**, in sequence. Coordinate only
  through `WORKSPACE_INSTRUCTIONS.md`: read it first, claim a port that is not
  already claimed, write your entry back. Do not guess a sibling's port — read
  what its agent recorded.

## Micro-frontends: recognise the shape

Many enterprise frontends are **not** one app. They are a *shell* plus N
*remotes/services*, each a separate repository, each served under its own URL
path prefix, all reachable through one origin. Signals that you are looking at
such a set:

- `nginx-local/`, `nginx.conf`, `default.conf`, `docker-compose.yaml` in a repo
  root — a committed local proxy setup.
- `servePath` / `baseHref` in `angular.json`, or `base:` in `vite.config.*`, set
  to a subpath such as `/services/drive/` — the app is mounted below `/`.
- Module Federation: `remoteEntry.js`, `exposes`/`remotes` in
  `webpack.config.*`/`vite.config.*`, or a `remoteComponentsUrl`-style runtime
  key in `src/assets/vars.json` / `config.json`.
- A repo that renders only a login/navigation frame while everything else is
  loaded at runtime — that repo is the **shell**.

Consequence: to make such a workspace *usable*, all services must run **at the
same time** behind one proxy. "Run them one by one on the same port" is a
failure, not a workaround — the shell would load with every remote missing.

## Docker-in-docker is not available

A committed `nginx-local/docker-compose.yaml` is written for a developer's
laptop. Inside this task container you **cannot** run docker. Do not try
`docker`, `docker compose`, `podman`, or any container runtime — they will fail.
Instead run the same proxy **natively**.

Translate the compose file into a native run using this table:

| docker-compose says | native equivalent |
| --- | --- |
| `ports: - 4300:4300` | nginx `listen 4300;` (the port is already the container's) |
| `volumes: - ./conf.d/:/etc/nginx/conf.d` | keep the `server{}` blocks, `include` them from your own `nginx.conf` |
| `volumes: - ../dist/app/browser:/usr/share/nginx/html/app` | point `alias`/`root` at the **real build output path** in this workspace |
| `proxy_pass http://host.docker.internal:4201` | `proxy_pass http://127.0.0.1:4201` — nginx now shares the network namespace with the dev servers |
| `extra_hosts: host.docker.internal:host-gateway` | drop it; nothing to map |
| `image: nginx:latest` | the local `nginx` binary (`nginx -v` to confirm) |

Everything else in the config (locations, rewrites, `try_files`, WebSocket
upgrade headers, cache-control for `remoteEntry.js`) carries over unchanged —
preserve it, it encodes the real routing contract.

### Non-root nginx recipe (verified)

You run as an unprivileged user: no `/var/log/nginx`, no `/var/lib/nginx`, no
`user` directive, no ports < 1024. Put every writable path under the workspace
or `/tmp`:

```nginx
pid        /tmp/nginx-{{REPO_NAME}}.pid;
error_log  /tmp/nginx-{{REPO_NAME}}.error.log warn;

events { worker_connections 1024; }

http {
    client_body_temp_path /tmp/nginx-{{REPO_NAME}}-client;
    proxy_temp_path       /tmp/nginx-{{REPO_NAME}}-proxy;
    fastcgi_temp_path     /tmp/nginx-{{REPO_NAME}}-fastcgi;
    uwsgi_temp_path       /tmp/nginx-{{REPO_NAME}}-uwsgi;
    scgi_temp_path        /tmp/nginx-{{REPO_NAME}}-scgi;
    access_log            /tmp/nginx-{{REPO_NAME}}.access.log;

    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    server {
        listen       {{DEV_SERVER_PORT}};
        server_name  _;

        location / {
            alias /abs/path/to/shell/dist/;
            try_files $uri $uri/ /index.html;
        }

        location /services/drive {
            proxy_pass http://127.0.0.1:4201;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
        # …one location per service, ports as recorded in
        # WORKSPACE_INSTRUCTIONS.md
    }
}
```

Validate before starting, and always pass a prefix so relative paths resolve:

```bash
nginx -t -c /abs/path/nginx.conf -p /abs/path
nginx    -c /abs/path/nginx.conf -p /abs/path      # start
nginx -s stop -c /abs/path/nginx.conf -p /abs/path # stop
```

If `mime.types` is not at `/etc/nginx/mime.types`, find it
(`find / -name mime.types -path '*nginx*' 2>/dev/null`) or drop the `include`
and set `default_type text/html` — a missing MIME map breaks CSS/JS loading, not
routing.

### No nginx binary?

Prefer nginx when present. If it is genuinely unavailable, write a small Node
reverse proxy instead (node is always installed) — one `http.createServer`, a
path-prefix → `http://127.0.0.1:PORT` map, pipe both directions, and forward
the `upgrade` event for WebSockets. Keep it in the workspace, document it, and
say in `## Notes` that nginx was missing. Do not spend the run trying to
install nginx.

## Steps (in order)

1. **Orient in the workspace.** Before touching this repo: list the workspace
   root, read `WORKSPACE_INSTRUCTIONS.md` if it exists, and note which siblings
   are present and which ports are already claimed. Read the Tag Instructions
   above — they define the intended topology (one proxy port, or each service
   on its own URL) and override your defaults.

2. **Study the project.** Read whatever exists: `package.json`, lockfiles,
   `Makefile`, `go.mod`, `Cargo.toml`, `requirements.txt`, `CMakeLists.txt`,
   `README.md`, CI config, and any `nginx*`/`docker-compose*` files. Determine:
   language/framework, package manager, install / build / run commands, required
   environment variables, toolchain versions, and — crucially — whether this
   repo is a **shell**, an **upstream service**, or a standalone app.

3. **Install dependencies.** Run the install command. On error, find the cause
   (toolchain version, missing lockfile, registry/TLS, native deps), fix it
   (switch package manager, install a tool, adjust config), and retry. After 3
   failed attempts, move on and document the failure in `## Notes` with the exact
   error — a documented failure is a useful result, a silent one is not.

4. **Verify the build.** If the project has a build step, run it and fix as in
   step 3. For a shell repo, the build output is what the proxy will serve —
   note its absolute path.

5. **Write `{{REPO_DIR}}/RUN_INSTRUCTIONS.md`** — the file other agents and the
   system read. Keep the exact heading names and the fenced command blocks: the
   system parses the `## Run` section to start the dev server.

   ````markdown
   # Setup Instructions: {{REPO_NAME}}

   ## Environment
   - Language: ...
   - Version: ...
   - Package manager: ...
   - Role in workspace: shell | upstream service | standalone

   ## Install Dependencies
   ```bash
   <install command>
   ```

   ## Build
   ```bash
   <build command, or "not required">
   ```

   ## Run
   ```bash
   <command listening on 0.0.0.0:{{DEV_SERVER_PORT}}>
   ```

   ## Environment Variables
   - VAR1=... (description, where to get the value)

   ## Notes
   <special cases, failures and their workarounds, TLS/registry recipes>
   ````

   Commands are written to be run from the repository root: no `cd` inside them.
   If this repo is an upstream service, its `## Run` uses **its own** port, and
   you say so explicitly — otherwise a later agent will bind the workspace port
   and collide.

6. **Create `{{REPO_DIR}}/DEV_SERVER.sh`** — the system (not you) executes it to
   keep the app running for the verification steps. Foreground, `0.0.0.0`,
   `chmod +x`.

   Standalone app:
   ```bash
   #!/bin/bash
   cd "$(dirname "$0")"
   unset PORT            # many dev servers honor $PORT above --port
   npx vite --host 0.0.0.0 --port {{DEV_SERVER_PORT}}
   ```

   Shell of a micro-frontend set — start the upstreams you need, then the proxy
   in the foreground on `{{DEV_SERVER_PORT}}`:
   ```bash
   #!/bin/bash
   set -e
   cd "$(dirname "$0")"
   unset PORT
   nginx -c "$PWD/nginx-workspace.conf" -p "$PWD" -g 'daemon off;'
   ```

   Upstream service (its own port, **not** `{{DEV_SERVER_PORT}}`):
   ```bash
   #!/bin/bash
   cd "$(dirname "$0")"
   unset PORT
   npx ng serve --host 0.0.0.0 --port <THIS_REPO_PORT>
   ```

   No dev server in the project → serve the built output or the static files
   (`python3 -m http.server <PORT> --bind 0.0.0.0`).

7. **Write the proxy config** (micro-frontend workspaces only). Derive it from
   the committed `nginx-local/conf.d/*.conf` using the translation table above.
   Store it **outside** the repositories — at the workspace root as
   `nginx-workspace.conf` — so no repo's git tree is polluted. Route only to
   services that are actually running here; for a service whose repo is cloned
   but not installed, emit the `location` block commented out with a one-line
   reason.

8. **Update `WORKSPACE_INSTRUCTIONS.md`** at the **workspace root** (the parent
   of `{{REPO_DIR}}`) — never inside a repository. Other agents read this file
   before choosing ports, so it is the coordination point; keep it accurate and
   append to what is already there instead of overwriting it.

   ````markdown
   # Workspace Instructions

   ## Overview
   - Topology: standalone | micro-frontends behind one proxy
   - Public entry: http://0.0.0.0:{{DEV_SERVER_PORT}} (served by <repo>)
   - Proxy config: <abs path to nginx-workspace.conf> — start/stop commands
   - Repos in this workspace: <names, and which are installed vs clone-only>

   ## Port map
   | Repo | Path prefix | Upstream port | Status |
   | ---- | ----------- | ------------- | ------ |
   | kc_front | / | (shell, served by proxy) | ✅ built |
   | kc_drive_front | /services/drive | 4201 | ✅ running |
   | kc_docs_editor_front | /services/editor | 4218 | ⛔ clone-only |

   ## <Repo name>
   - Port, role, install/build/run summary, gotchas.

   ## Cross-repo Setup
   <proxy start/stop, shared env vars, CA certs, how to verify the whole stack>

   ## Verify
   <one curl per route, and what a good answer looks like>
   ````

   The port map is the single most valuable thing you leave behind: it is what
   stops the next agent from reusing a port.

9. **Prove it runs.** Start `./DEV_SERVER.sh` yourself and verify through the
   **public entry port**, not just the upstream:

   ```bash
   curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:{{DEV_SERVER_PORT}}/
   curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:{{DEV_SERVER_PORT}}/services/drive/
   ```

   For a shell, also confirm the HTML references assets that resolve (a 200 on
   `/` with 404s on every `.js`/`.css` is a broken base path, not a success).
   Then stop what you started — the system starts it again after you finish. If
   it does not serve, fix the script/config and re-check; record an unfixable
   case in `## Notes`.

10. **Report.** In your final message state: success or failure, this repo's role
    (shell / upstream / standalone), its port, the install / build / run
    commands, and — for a micro-frontend workspace — the proxy port plus which
    routes answer.

## Ground rules

- Files you write: `RUN_INSTRUCTIONS.md` and `DEV_SERVER.sh` in the repo root,
  plus `WORKSPACE_INSTRUCTIONS.md` and (when needed) `nginx-workspace.conf` at
  the workspace root. Source code stays as it is; touch a config or a lockfile
  only when it is the only way to make the install work, and say so in
  `## Notes`.
- All of these files are infrastructure: the system excludes them from git and
  commits nothing else for you.
- Read inside `{{REPO_DIR}}` and the workspace root; write only the files above.
- No container runtimes (docker/podman/compose) — they do not work here.
- Use whatever toolchain the project actually needs (npm/yarn/pnpm/npx/go/pip/
  python3/cargo/make).
- When Tag Instructions conflict with these defaults, Tag Instructions win —
  they describe how this particular set of repositories is meant to run.
