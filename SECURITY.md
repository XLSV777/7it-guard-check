# Security

## Reporting a vulnerability

Please report security issues privately, not in a public issue:

- GitHub: the **Report a vulnerability** button on the Security tab of this repository (private vulnerability reporting), or
- Email: support@7it.co.il

We reply within 3 business days and credit reporters who want it.

## What this Action can reach

- `https://7it.co.il/guard/check`: exactly the fields listed under "What is sent to 7IT" in the README (the site address, a one-way hash of the repository, the event, a short commit id, the Action version and, with `id-token: write`, the GitHub identity token of the run). Never source code, secrets or file names.
- `https://api.github.com`: only with the workflow's `GITHUB_TOKEN`, only to keep one pull request comment and to open the one-time ownership pull request. The token is never sent anywhere else.
- The runner's own identity token endpoint, to request the token above.

The Action has no dependencies: everything it runs is in `src/index.mjs`.

## Pinning

`@v1` follows fixes. For the strictest setup, pin the full commit SHA of a release, for example `XLSV777/7it-guard-check@<40-character SHA> # v1.1.0`, and update it when you choose. Releases of this repository are immutable.
