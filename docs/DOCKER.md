# Docker web deployment and development

Panvas is a static browser application plus a separately packaged Electron app. Docker builds the browser application and serves it with Nginx. Google Drive and Supabase remain optional hosted providers; no local API, database or provider emulator is introduced.

## Prerequisites and start

Use Docker Engine/Desktop with Linux containers and Compose v2. Run from the repository root:

```sh
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example build
docker compose --env-file .env.example up -d --wait
docker compose --env-file .env.example ps
docker compose --env-file .env.example logs --tail=100
```

Open `http://localhost:8080/app`; `/` serves the landing page, `/download` the existing published download metadata. `http://localhost:8080/healthz` checks the web server. A health check alone does not verify editing or persistence.

```sh
docker compose --env-file .env.example restart web
docker compose --env-file .env.example down
```

The commands never remove volumes or user browser data. The default bind address is loopback. Set `PANVAS_WEB_PORT` to change the host port, or `PANVAS_BIND_ADDRESS` deliberately to expose it to a reverse proxy/network. No database ports or Docker socket are mounted.

## Configuration and state

`--env-file .env.example` uses explicit local-only defaults instead of accidentally inheriting a developer's real `.env`. To configure integrations, copy the template to an ignored local env file and pass that filename consistently to Compose. Compose forwards only the listed **public build arguments**, not the entire file. All `VITE_` values are compiled into JavaScript and visible to users. Never supply service-role keys, passwords or OAuth refresh/access tokens.

Public build options are `VITE_ENABLE_CLOUD_SYNC`, `VITE_PANVAS_SYNC_V2`, `VITE_PANVAS_GOOGLE_WEB_CLIENT_ID`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_PANVAS_BUILD_ID`. Rebuild after changing them; changing container runtime environment cannot modify an already compiled app. Marketing-only and analytics are disabled in this image. Configure OAuth authorized origins for the actual HTTPS origin before enabling cloud integration. Do not treat mocked-provider tests as a live-provider sign-off.

The server is stateless. **Workspaces are stored in each browser's IndexedDB**, not inside the container. There is no server data volume to persist or back up. Restarting/replacing a container at the same origin retains browser data. Different scheme/hostname/port means different origin and different data. Use Panvas backup export/import to move work; do not clear the old origin first.

Remote production access requires a TLS reverse proxy. The image listens on HTTP 8080 and deliberately does not guess a domain or provision certificates. Clipboard, microphone, OAuth and service workers have secure-context restrictions. Loopback browser contexts support most local APIs; the offline shell intentionally does not register on HTTP localhost. On HTTPS, service-worker caching remains in the browser. `index.html` is revalidated, hashed `/assets/` files are immutable, missing assets return 404 and `service-worker.js` is not cached by the server.

## Container controls

- Multi-stage lockfile install; Electron download is skipped for the web build.
- Node and unprivileged Nginx base images are pinned by version and digest.
- Final process runs as UID/GID 101 with a read-only root and bounded `/tmp` tmpfs.
- All Linux capabilities are dropped; no-new-privileges, memory/CPU limits, bounded logs and graceful SIGQUIT shutdown are configured.
- Health check probes `/healthz`; Nginx writes access/error logs to stdout/stderr.
- Source, credentials, tests and build tooling are absent from the runtime image.

Digest updates are intentional maintenance: inspect upstream advisories, update both version and digest, rebuild and retest. These controls do not make an image vulnerability-free. CI builds but never pushes an image.

## Development

The development Compose file is standalone, not an override:

```sh
docker compose --env-file .env.example -f compose.dev.yaml config --quiet
docker compose --env-file .env.example -f compose.dev.yaml up --build -d --wait
docker compose --env-file .env.example -f compose.dev.yaml logs -f web-dev
docker compose --env-file .env.example -f compose.dev.yaml exec web-dev npm run typecheck
docker compose --env-file .env.example -f compose.dev.yaml exec web-dev node --test tests/documentation-flow.test.ts tests/notebook-code-highlight.test.ts
docker compose --env-file .env.example -f compose.dev.yaml restart web-dev
docker compose --env-file .env.example -f compose.dev.yaml down
```

Open `http://localhost:3000/app`. Edit host `src/`, `public/` and supported config files; Vite uses polling for Docker Desktop bind mounts. Dependency changes require `up --build`. The unprivileged development image includes dev tools; production does not. Native Electron, Windows Ink, native pickers and installer checks require Windows, not this container.

To reset a test, stop its containers and discard only the **disposable browser profile** created for the test. No `down -v`, system prune, normal-profile wipe or Panvas storage-root deletion is needed.

## Troubleshooting

If `docker version` shows no server, start Docker Desktop and wait for the Linux engine. If the port is occupied, use another `PANVAS_WEB_PORT` and remember it creates another browser origin. If health fails, inspect `docker compose --env-file .env.example logs web`. If editing works but remote clipboard/audio does not, verify HTTPS and permissions. If an update shows old UI, reload and check the service worker before clearing any data; export a backup first.

References: [Compose services](https://docs.docker.com/reference/compose-file/services/), [Compose build specification](https://docs.docker.com/reference/compose-file/build/), [Nginx unprivileged image](https://github.com/nginx/docker-nginx-unprivileged).
