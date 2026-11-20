# Contributing

English | [中文](CONTRIBUTING.md)

Thanks for helping with Yuanshu. This guide covers how to get a change into the repository. For what the project is, see the [README](README.en.md); for coding conventions, see [AGENTS.md](AGENTS.md); for design rationale, see [docs/README.md](docs/README.md). Most of the in-repo documentation (design docs, skills) is written in Chinese.

## Talk first, then build

- Bug fixes, tests and docs: just open a PR.
- New features, interaction changes, or changes to data structures or APIs: please open an issue first. The project is early and many design trade-offs are already settled (see `docs/model/`); aligning first saves a round trip.
- Found a security problem? Do **not** open a public issue; report it privately as described in [SECURITY.en.md](SECURITY.en.md).

## Development environment

- Node ≥ 22.19 (CI pins 22.19.0; if you develop on a newer Node, a test can pass locally and fail in CI, e.g. the class `Response.blob()` returns under jsdom depends on the Node version) and pnpm. The exact pnpm version is pinned by `packageManager` in the root `package.json`; any pnpm ≥ 10 will switch to it automatically.
- Install dependencies with `pnpm install --frozen-lockfile`.
- The real-browser verification scripts need Chromium: `pnpm --filter yuanshu-harness-server exec playwright-core install chromium` (set `PLAYWRIGHT_DOWNLOAD_HOST` to a mirror first if your network needs one).
- The image smoke test needs Docker.

## Day-to-day

```bash
pnpm typecheck && pnpm lint && pnpm test    # types, lint, unit tests
pnpm build                                  # build web and server
scripts/preview.sh                          # build and (re)start a local preview server to look at your change
```

- Run a single test inside its package: `pnpm --filter yuanshu-harness-web exec vitest run <path>` (same for the server, package `yuanshu-harness-server`). Don't run `npx vitest` from the repo root; it picks up third-party tests inside `node_modules`.
- Layout, scrolling, IME input, terminals and wiring between parts can't be tested in jsdom. Verify such changes with the real-browser scripts `scripts/verify-*.mjs`. Each script's header comment says what it checks; how to choose and write them is in [`.agents/skills/ys-delivery/references/verify-scripts.md`](.agents/skills/ys-delivery/references/verify-scripts.md).
- Run `scripts/check.sh` before opening a PR. It is the same script CI runs (it needs Docker and Chromium and has no skip switch). To run one part, pass a stage name: `core` (types, lint, unit tests, build, package smoke), `ui-settings`, `ui-chat`, `ui-workspace`, `ui-canvas`, `ui-mobile`, `browser` (real-browser verification), or `image` (image smoke); CI runs the stages in parallel. A new `scripts/verify-*.mjs` must be assigned to a stage, or the self-check fails.

## Code and docs conventions

- Read [AGENTS.md](AGENTS.md) first, then the skill under `.agents/skills/` for the part you touch: front-end visuals (`ys-ui-design`), front-end structure (`ys-ui-build`), back end (`ys-server`), mobile (`ys-mobile`), wrap-up and verification (`ys-delivery`). They describe the layering, standard components, hard rules and known pitfalls of this project.
- Match the existing style. No drive-by refactors, no unrequested flexibility; delete any orphaned code your change creates.
- The project is early: no data migration and no API compatibility layers. Remove the old thing instead of keeping two.
- When behavior or design changes, update the matching document under `docs/model/`; when a change makes a skill stale, update it too. State each fact in one place.
- The repository is public: never commit credentials, tokens, internal addresses or personal information (details in AGENTS.md).

## Commits and PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`.
  - type: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build`.
  - scope: the part you touched; common ones are `web`, `server`, `mobile`, `browser`, `forward`, `chat`, `canvas`, `scripts`, `skills`, `docs`.
  - description: an English imperative sentence, at most 72 characters. Mark breaking changes with `type!:` or a `BREAKING CHANGE:` footer.
- Put a cohesive set of files in one commit (typically: code with its tests, verification scripts, docs). Don't mix unrelated changes, and don't over-split either.
- Branch names are lower-case and hyphenated, prefixed `feat/` `fix/` `chore/` `refactor/` `test/` or `docs/`.
- In the PR description say what changed, why, how you verified it (commands or scripts run and their results), and what you did not verify. Include screenshots for UI changes.

## License

Contributions are licensed under [MIT](LICENSE); no CLA is required. Some code is adapted from third-party projects; see [NOTICE](NOTICE).
