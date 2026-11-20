# Deployment

English | [中文](deployment.md)

How to run Yuanshu, configure access control, and use it from a phone. For the project overview see the [README](../README.en.md). The design documents linked below are in Chinese.

## Options and access control

`yuanshu serve` starts the server. Options come from the command line or from environment variables; the command line wins:

| Meaning | Command line | Environment variable | Default |
|---|---|---|---|
| Listen address | `--host` | `YUANSHU_HOST` | `127.0.0.1` |
| Listen port | `--port` | `YUANSHU_PORT` | `7420` |
| Data directory | `--data-dir` | `YUANSHU_DATA_DIR` | `~/.yuanshu` |
| Access token | `--token` | `YUANSHU_TOKEN` | none (may be omitted only when listening on loopback) |
| Allowed source networks | `--allow-cidr` (comma-separated) | `YUANSHU_ALLOW_CIDR` | unrestricted |
| Extra trusted page origins | `--trusted-origin` (comma-separated, e.g. `https://ys.example.com`) | `YUANSHU_TRUSTED_ORIGINS` | none |
| Port range for service forwarding | `--forward-ports` (e.g. `24100-24199`) | `YUANSHU_FORWARD_PORTS` | `24100-24199` |

Startup checks and access control:

- Unknown options, invalid ports and misspelled `YUANSHU_*` variables make startup fail instead of being silently ignored.
- **Listening on a non-loopback address requires a token**, otherwise startup fails. A token is at least 32 characters from `A-Za-z0-9._~-`; pass it through the environment (command-line arguments show up in the process list).
- With a token set, REST and WebSocket under `/api/v1` must carry `Authorization: Bearer <token>` (a WebSocket may instead give `bearer.<token>` in `Sec-WebSocket-Protocol`); `/healthz` and static pages need no token. Ten wrong tokens from one source lock it out for 60 seconds (429).
- With a source network list set, requests from outside it get 403.
- Browser requests (WebSocket included) that carry an `Origin` must match the request's `Host` (or the `X-Forwarded-Host` a reverse proxy supplies) in host and port, otherwise the answer is 403 `forbidden_origin`: the session cookie is not port-scoped, so without this check a page on another port of the same host could ride it. If a reverse proxy rewrites `Host` to an internal address and sends no `X-Forwarded-Host` (nginx does by default; Caddy keeps `Host`), put the public address into the extra trusted origins.
- There is no TLS and the token travels in clear text: use it only on trusted networks. Behind a reverse proxy, the network list and rate limiting see the proxy's address.
- Health probe: `GET /healthz`, which returns `{"status":"ok","version":"…"}`.

## Docker

The image is not published yet; build it from the repository root: `docker build -t yuanshu .`. The image runs as user `node` (uid 1000), keeps its data in `/data` and listens on `0.0.0.0:7420`.

```bash
docker run -d --name yuanshu -p 7420:7420 -e YUANSHU_TOKEN -v yuanshu-data:/data yuanshu
```

- The container listens on `0.0.0.0`, so `YUANSHU_TOKEN` is mandatory (export it in your shell first; `-e YUANSHU_TOKEN` forwards only the name, so the token stays off the command line), otherwise the container fails to start.
- A named volume (as above) inherits the ownership of `/data` in the image and works out of the box.
- If you bind-mount a host directory, it must be writable by uid 1000.
- To change the port inside the container, set `-e YUANSHU_PORT=…` rather than changing the command line: the image's built-in health check reads `YUANSHU_PORT`.

The image already contains the browser the agents use (Chromium, its libraries, a Chinese font and a color emoji font). Without Docker, emoji in pages need a color emoji font on the host (e.g. `fonts-noto-color-emoji`; without root, put `NotoColorEmoji.ttf` into `browser/home/.local/share/fonts/` under the data directory; the browser tab shows a notice when the font is missing). To make Chromium's sandbox work, add Playwright's seccomp profile and `--shm-size` at run time (Docker's default seccomp profile forbids user namespaces, so the sandbox cannot start); without them it still works, but the sandbox degrades and the browser tab shows a warning. If the browser is compromised only the container is affected, so running it as its own container is recommended; do not use `--privileged`, and do not mount `docker.sock` or host directories other than the data directory. Details in [model/browser.md](model/browser.md) §8 (Chinese).

```bash
docker run -d --name yuanshu -p 7420:7420 -e YUANSHU_TOKEN -v yuanshu-data:/data \
  --security-opt seccomp=config/docker/seccomp_profile.json --shm-size=1g yuanshu
```

To let users reach services running in an environment from their own browser (service forwarding, see [`model/forward.md`](model/forward.md)), publish one more port range: `-p 24100-24199:24100-24199` (the range must match `YUANSHU_FORWARD_PORTS`). Deployments over the public internet behind a reverse proxy or frp tunnel are not supported yet; see that document.

The seccomp profile lives in the repository, not in the image: the path above is relative to the repository root, so on another machine copy `config/docker/seccomp_profile.json` over and change the `--security-opt` path to the absolute path there. If the target machine cannot build the image, build locally, pack it with `docker save yuanshu | gzip`, copy it over and run `gunzip -c <file> | docker load` there; the target needs no internet access. If a host port is taken by another service, change the host side of `-p` (the container port stays); for the forwarding range also change `YUANSHU_FORWARD_PORTS` so that what the container listens on is the range you publish.

On restricted networks, swap the download sources with `--build-arg` when building the image: `DEBIAN_MIRROR` (mirror root, e.g. `https://mirrors.tuna.tsinghua.edu.cn`), `PLAYWRIGHT_DOWNLOAD_HOST` (Playwright browser download mirror) and `npm_config_registry` (npm registry).

## Without Docker: a package plus a systemd user service

Runs as an ordinary user on a Linux machine (an LXD container included); tested on Debian 13 with Node 24.

1. Pack locally: `scripts/pack.sh <output dir>` (cleans, rebuilds web and server, and produces one tarball).
2. Copy it to the target and, in a clean directory, run `npm init -y && npm install <tarball>` (Node ≥ 22.19 is required; npm 11 reports that some install scripts were not approved, which can be ignored: the native modules load and the terminal works).
3. Write an environment file with mode 600 containing at least `YUANSHU_HOST=0.0.0.0`, `YUANSHU_PORT`, `YUANSHU_DATA_DIR` and `YUANSHU_TOKEN` (a token of at least 32 characters, e.g. `head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'`).
4. A user-level systemd service (`~/.config/systemd/user/yuanshu.service`): `EnvironmentFile` points at that file, `ExecStart` uses **absolute paths** to node and to `node_modules/.bin/yuanshu serve` (especially when node lives under nvm), `Restart=on-failure`; then `systemctl --user enable --now yuanshu`. **To keep it running after you log out, run `loginctl enable-linger <user>`.**
5. For other machines to connect, expose `7420` and the forwarding range `24100-24199` (an LXD proxy device, the firewall, and so on).

The first time anyone uses the browser engine it downloads Chromium into `browser/` under the data directory (about a minute directly from Playwright's source; set a mirror on restricted networks, see [browser.md](model/browser.md) §8). System libraries must be installed on the machine; as an ordinary user, Chromium's sandbox is on when the kernel allows unprivileged user namespaces.

Upgrading: repack, copy it over, run `npm install <tarball>` again in the same directory, then `systemctl --user restart yuanshu`. The project is early and does no data migration: when an upgrade changes the schema, delete the database file in the data directory and start over (providers and other settings must be reconfigured), and **keep `browser/`** so Chromium need not be downloaded again.

## Mobile access (`/m/`)

Open `http://<server address>/m/` in the phone's browser (the desktop token gate also has a "mobile" link). Each phone has its own device token: **Settings → Mobile devices → Add a phone** on the desktop shows a QR code (valid for 5 minutes, single use); scanning it logs the phone in, and a lost phone is revoked on the same page. You can also type the access token into `/m/` directly, but then there are no background notifications. The address in the QR code defaults to the one you opened the desktop with; if that is `localhost`, change it to a LAN address the phone can reach.

**Plain HTTP (a LAN IP, `http://`) works too**: login, the session list, chat, approvals and questions, camera and photo attachments, viewing artifacts and a read-only view of the browser are all live while the page is open. **Three things need HTTPS**: background notifications (Web Push), installing as a standalone app (add to home screen) and keeping the screen awake. To get them, have the phone use HTTPS:

- With your own domain: obtain a certificate through DNS validation (works on a LAN too) and put it on a reverse proxy (Caddy, nginx);
- Use the HTTPS certificate from [Tailscale](https://tailscale.com/);
- Caddy's built-in local CA (the root certificate must be installed on the phone). With Caddy, turn HTTP/3 off and make its `/data` volume persistent (the certificates and the root CA live there).

The server itself does no certificate management and does not listen on TLS. Keep `Host` and `Origin` consistent at the reverse proxy (see `YUANSHU_TRUSTED_ORIGINS` above).

Background notifications go through the browser vendor's push service (Chrome uses Google's FCM): they do not arrive if the phone has no Google services or the server cannot reach FCM, which is a known limit. A notification carries only the event type and the session title, never commands or output, and tapping it opens that session. Design details are in [model/mobile.md](model/mobile.md) (Chinese).
