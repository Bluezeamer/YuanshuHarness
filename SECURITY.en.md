# Security Policy

English | [中文](SECURITY.md)

## Reporting a vulnerability

**Please do not describe security issues in public issues, PRs or discussions.** Use GitHub's private reporting: the **Security** tab of this repository → **Report a vulnerability**. Please include:

- the affected version or commit;
- steps to reproduce, or a minimal proof of concept;
- what you think the impact is.

This is an early, individually maintained project with no committed response time, but I will try to acknowledge a report within a few days and tell you how it will be handled after assessment. Please keep details private until a fix is out; you will be credited afterwards unless you ask not to be.

## Supported versions

The project is early (0.0.x). Only the latest code on `main` is maintained; fixes are not backported.

## Threat model: what Yuanshu is and is not

Yuanshu is a **single-user agent server meant for trusted networks**:

- Agents run commands, read and write files, and drive terminals and a browser with the privileges of the user running the server. Approvals and permission tiers are a **confirmation gate, not a sandbox**; real isolation comes from deployment: run it in a container or as a dedicated low-privilege user, and keep anything the agent must not touch out of its reach.
- The server does **no TLS itself**, so the access token travels in clear text over HTTP. Use it directly only on trusted networks (loopback, LAN, VPN); to reach it across the internet or an untrusted network, put it behind a reverse proxy that terminates TLS.
- A single token is the whole credential: holding it means holding the entire server, including everything the agent can reach.

### Protections in place

- Listening on a non-loopback address requires an access token or the server refuses to start; tokens must be at least 32 characters; ten wrong attempts from one source lock it out for 60 seconds.
- Browser requests (WebSocket included) that carry an `Origin` must match the `Host` in host and port, otherwise they are rejected (so pages on other ports of the same host cannot ride the session cookie). A source network allow-list (`--allow-cidr`) can further restrict who may connect.
- The mobile app uses its own device tokens, stored only as hashes; pairing codes are single-use and valid for 5 minutes; revoking a device cuts its connections.
- Agent-browser traffic goes only through the server's built-in proxy, which by default refuses loopback, private-network, link-local and cloud-metadata addresses, and visiting a site needs authorization.
- A private variable's value appears only once, on the executing side; it never enters the model context and is masked in output.

### Out of scope (known boundaries, not vulnerabilities)

- an authenticated user making the agent do something destructive;
- token sniffing by others on the same network over plain HTTP;
- exposing the server directly to the internet without a reverse proxy and network restrictions;
- attacks that first require the privileges of the user running the server (or access to its data directory).

## Deployment advice

- Pass the token through the environment (`YUANSHU_TOKEN`), not as a command-line argument (arguments show up in the process list).
- Prefer running in Docker on its own; do not use `--privileged`, and do not mount `docker.sock` or host directories other than the data directory. Use the seccomp profile from the repository so the browser sandbox works. See [Deployment](docs/deployment.en.md).
- For phone notifications or installing the PWA, use HTTPS (a reverse proxy or Tailscale) and put the public address into `YUANSHU_TRUSTED_ORIGINS`.
