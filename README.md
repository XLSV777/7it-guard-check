# 7IT Guard check

A GitHub Action from 7IT that checks your live site, or your deploy preview, from the outside on every push or pull request. You get a short result in the job summary, a warning next to each finding, and a fix you can paste into your AI coding tool.

The Action is a thin client. All checks run on the 7IT service, from the outside, the same way any visitor or scanner would see your site. Nothing from your code is read or sent.

## What it checks

7IT Guard looks at what your site shows the world: the pages and headers it serves, the files it exposes by mistake, and the basics that keep a launch safe. It never reads your repository, your secrets, or your build output. If a check finds something, you get:

- what was found and why it matters,
- how to fix it,
- a ready prompt you can paste into your AI coding tool.

## Quick start

### (a) Vercel or Netlify, with deploy previews

Vercel and Netlify report each deployment to GitHub. This workflow runs when a deployment succeeds. Previews are detected automatically, so `site` is only used for production deployments.

```yaml
# .github/workflows/7it-guard.yml
name: 7IT Guard
on: deployment_status
permissions:
  id-token: write       # lets 7IT Guard confirm the repository (GitHub OIDC token)
  contents: write       # lets 7IT Guard open the one-time ownership pull request
  pull-requests: write   # lets 7IT Guard keep one comment on the PR up to date
jobs:
  guard:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: XLSV777/7it-guard-check@v1
        with:
          site: https://example.com
```

### (b) Any host

```yaml
# .github/workflows/7it-guard.yml
name: 7IT Guard
on:
  push:
    branches: [main]
  pull_request:
permissions:
  id-token: write       # lets 7IT Guard confirm the repository (GitHub OIDC token)
  contents: write       # lets 7IT Guard open the one-time ownership pull request
  pull-requests: write
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: XLSV777/7it-guard-check@v1
        with:
          site: https://example.com
```

More examples are in [`examples/`](examples/).

## Permissions

| Permission | Why |
| --- | --- |
| `id-token: write` | Lets 7IT Guard ask GitHub for a short-lived identity token (OIDC, audience `7it-guard-check`) and send it to 7IT, so the service confirms from GitHub's signed claims that the run really comes from your repository. Required to prove the site is yours. |
| `contents: write` | Lets 7IT Guard open the one-time ownership pull request. |
| `pull-requests: write` | Lets 7IT Guard keep one comment on the pull request up to date. |

**Without `id-token: write`** (or on a pull request from a fork, which never gets the token) the Action still runs in a reduced mode: the outside checks run and the job summary shows the result, but the site cannot be proven yours, so the ownership pull request is not opened and the checks that need ownership stay held back. The run shows a notice saying so. If 7IT ever requires the token for every run, a run without it is skipped with that same message and the job still passes.

## Two modes

| `on-problem` | What happens |
| --- | --- |
| `warn` (default) | The job never fails. Each finding shows as a warning, and the full result is in the job summary. |
| `block` | The job fails only when the result is `fail`. A `warn` result still passes. |

Whatever the mode, a busy or paused 7IT service, a network problem, or a check limit never fails your job. You get a notice in the summary and the job continues.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `site` | | URL to check. Required unless the run is a successful deploy preview. |
| `on-problem` | `warn` | `warn` or `block`, see above. |
| `comment` | `auto` | `auto` keeps one comment on the pull request, updated in place, when the token has `pull-requests: write`. Without that permission it skips quietly. `off` never comments. |
| `ownership-pr` | `auto` | `auto` opens one pull request that adds the ownership file, when the site is not proven yet. Needs `contents: write` and `pull-requests: write`; without them it skips quietly and the job summary shows the one manual step. `off` never opens it. |
| `github-token` | `${{ github.token }}` | Used only for the PR comment and the ownership pull request. |

## Outputs

| Output | Description |
| --- | --- |
| `status` | `pass`, `warn`, `fail`, or `skipped` when no check ran. |
| `result-url` | Link to the full result. |
| `findings-count` | Number of findings. |
| `ownership-pr` | Link to the ownership pull request, when one was opened or is open. |

## Prove you own the site (one merge)

Until 7IT knows the site is yours, a check shows a short result. To unlock the full results and the 14-day 7IT Guard Pro trial, 7IT Guard opens one pull request on branch `7it-guard/verify` that adds a single small file to your static folder (`public/`, or `static/` for SvelteKit and similar). Merge it, let the site deploy, and the next check confirms it.

- The file holds a public token only. No secret, nothing about your code.
- It happens at most once per repository. If you close the pull request, 7IT Guard does not open another one; the job summary shows the manual step instead.
- It never runs on forks or on pull requests from forks.
- It needs `id-token: write`: the file proves the site only on a run whose repository GitHub's identity token confirms.
- Without `contents: write` and `pull-requests: write`, nothing is opened; the job summary shows the file path and content so you can add it yourself.
- To remove it later, delete the file. To turn the pull request off, set `ownership-pr: off`.

## What is sent to 7IT

Exactly this, and nothing else:

- `site`: the URL you asked us to check (or the deploy preview URL),
- `repo`: a one-way SHA-256 hash of your repository name and id, so results can be grouped without us knowing which repository it is,
- `event`: the GitHub event name, for example `push`,
- `sha`: the first 7 characters of the commit,
- `preview`: whether this is a deploy preview,
- `version`: the version of this Action,
- `id_token`: the GitHub Actions identity token of the run (only with `id-token: write`). It is signed by GitHub, lives a few minutes, is made for 7IT only (audience `7it-guard-check`), and carries the repository name and id, the workflow, the branch and the run. 7IT checks the signature and the repository and keeps only the same one-way hash as `repo`. It grants no access to your repository.

No source code, no secrets, no file names. The `GITHUB_TOKEN` never leaves the runner except to call the GitHub API for the PR comment and the ownership pull request. Read the [7IT privacy policy](https://7it.co.il/privacy/).

## Badge

When a check runs, the job summary includes a badge you can add to your README. It shows the latest result for your site.

## Watch it all the time

This Action is included at no cost and checks when you push. The site can change between pushes: a setting, a DNS record, a certificate. 7IT Guard Pro keeps watching on its own, with no workflow needed. [Watch it all the time](https://7it.co.il/plans/).

## Versions

Use `@v1` to get fixes and new checks automatically. Pin an exact tag like `@v1.1.0` if you prefer, or, for the strictest setup, the full commit SHA of a release. Releases are immutable. See [CHANGELOG.md](CHANGELOG.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
