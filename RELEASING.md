# Releasing dpdp-kit

Releases are published by GitHub Actions (`.github/workflows/release.yml`), with npm provenance.

1. Open a release PR that sets the new `version` in `package.json` and adds its section to `CHANGELOG.md`. Turn auto-merge off for it: merging publishes.
2. Merge it. The workflow checks out the commit that set the version, runs the checks, publishes to npm, creates the GitHub Release `vX.Y.Z` from the changelog and moves the `v0` tag.
3. On the new release's page, choose **Edit**, tick **Publish this Action to the GitHub Marketplace** and save. GitHub has no API for this step.

## One-time setup: trusted publishing

npm must trust this workflow before it can publish without a token:

1. Sign in at npmjs.com and open the **dpdp-kit** package.
2. **Settings** → **Trusted Publisher** → **GitHub Actions**.
3. Organization or user: `yogesh2902`. Repository: `dpdp-kit`. Workflow filename: `release.yml`. Environment: leave empty.
4. Save.

Until this is set, the publish job fails with a note explaining what to do, and a version published by hand (`npm publish`) still gets its GitHub Release from the scheduled run.
