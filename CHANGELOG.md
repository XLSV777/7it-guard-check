# Changelog

All notable changes to 7IT Guard check. Versions follow [Semantic Versioning](https://semver.org/). The `v1` tag always points at the newest `v1.x.y` release.

## [Unreleased]

Planned as 1.1.0.

### Added

- One-merge ownership proof. When the server answer includes `verify`, 7IT Guard opens one pull request (branch `7it-guard/verify`) that adds the ownership file to `public/` or `static/`. At most once per repository, never on forks, skipped when the file is already in place.
- New input `ownership-pr` (`auto` default, or `off`) and output `ownership-pr`.
- Without `contents: write` and `pull-requests: write`, the job summary shows the manual step instead.
- Example workflows now grant `contents: write`.
- GitHub OIDC identity token. With `permissions: id-token: write` the Action asks the runner for a token with audience `7it-guard-check` and sends it as `id_token`; the server verifies it against GitHub's keys and confirms the repository from its claims. The token is never logged.
- Reduced mode without the token (missing permission, fork pull requests): the outside checks still run, a notice explains how to add the permission, and no ownership pull request is opened (the server answers `repo_verified: false`).
- A `401` from the server (token required, or a token that does not match the repository) is a skip with the server's message; the job never fails because of it.
- Example workflows and the README now grant `id-token: write`.

## [1.0.0] - 2026-10-19

### Added

- First release of 7IT Guard check.
- Checks a site from the outside on `push`, `pull_request` and `deployment_status`.
- Deploy preview detection for Vercel and Netlify (`deployment_status.environment_url`).
- Two modes: `warn` (default, never fails the job) and `block` (fails only on `fail`).
- Job summary on every run, a warning annotation per finding, outputs `status`, `result-url`, `findings-count`.
- One pull request comment, updated in place, when the token has `pull-requests: write`.
- Service limits, pauses, retired versions and network errors never fail the job.
