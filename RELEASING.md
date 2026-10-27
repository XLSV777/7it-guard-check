# Releasing

The version lives in two places that must match: `package.json` and the `VERSION` constant in `src/index.mjs` (sent to the server and in the User-Agent). A test fails if they differ. `scripts/release.mjs` keeps them in sync.

## Steps

1. Add the changes under `## [Unreleased]` in `CHANGELOG.md` and commit.
2. Run `node --test`. All tests must pass.
3. Run one of:

   ```sh
   node scripts/release.mjs patch      # 1.0.0 -> 1.0.1, fixes
   node scripts/release.mjs minor      # 1.0.0 -> 1.1.0, new checks or inputs
   node scripts/release.mjs major      # 1.0.0 -> 2.0.0, breaking changes
   node scripts/release.mjs 1.4.0      # exact version
   ```

   Add `--dry-run` to see what would happen. The script:
   - refuses to run on a dirty working tree,
   - bumps `package.json` and `VERSION`,
   - moves `Unreleased` under the new version heading with today's date,
   - commits `Release vX.Y.Z`,
   - creates the annotated tag `vX.Y.Z`,
   - force-moves the major tag `vX` to the same commit.

4. Push (or rerun with `--push`):

   ```sh
   git push origin HEAD
   git push origin vX.Y.Z
   git push -f origin vX
   ```

5. On GitHub, draft a release from tag `vX.Y.Z`, keep "Publish this Action to the GitHub Marketplace" checked, paste the changelog section, publish.

## Retiring a version

If a version must stop running, the server answers `410` for it. The Action then writes a notice with the upgrade line and exits 0, so no user's job breaks. Users on `@v1` move automatically once `v1` is moved.

## Major versions

Only bump the major for breaking changes (renamed inputs, changed outputs, a new required input). Keep the old major tag in place so existing workflows keep running.
