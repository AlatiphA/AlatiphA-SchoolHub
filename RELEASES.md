# SchoolHub releases

The first unified release is 40.1.0. `release.json` is the canonical metadata;
`public/release.json`, APP_VERSION, the About fallback and worker RELEASE_VERSION
are generated together by `node scripts/prepare-release.cjs`.

The Hosting predeploy hook runs this preparation automatically. Changed hosted
app assets, Functions source or security rules advance the patch number once.
Redeploying unchanged files keeps the same version. The content fingerprint
excludes generated version fields so repeated preparation is stable.

Before local release checks, run `node scripts/prepare-release.cjs`.
`node scripts/final-regression.cjs` rejects stale release metadata. Root/public
app, worker and index must match before preparing. Deploy from the main repo,
then commit the generated metadata and changed files to GitHub.

The in-app update flow shows the loaded page version. Check for updates fetches
uncached release metadata, checks the worker, and distinguishes downloading,
ready, current, offline and failed checks. Install update activates the complete
waiting worker and reloads this window after controller change. Other open
windows are offered a reload rather than forced to abandon unsaved forms.

Initial installation may activate immediately. Subsequent updates wait for the
Install update action, or for all old app windows to close. Save unsubmitted form
entries before installing; saved records, image storage, account sessions and
pending queues are not cleared. Activation removes only old app-shell caches;
existing notification and push-binding caches remain separate.

After the first deployment of this patch, reload once while online to load the
new About controls. No browser-data reset or uninstall is required.
