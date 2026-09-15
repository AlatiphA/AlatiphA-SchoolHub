$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root "app-4.js"

if (-not (Test-Path $app)) {
    throw "app-4.js was not found in $root"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $root "app-4.js.v40.1-prepatch-$stamp.bak"
Copy-Item $app $backup -Force

$text = Get-Content $app -Raw

function Replace-Exact {
    param(
        [string]$Old,
        [string]$New,
        [string]$Name
    )

    $count = ([regex]::Matches($script:text, [regex]::Escape($Old))).Count
    if ($count -ne 1) {
        throw "Patch anchor '$Name' expected exactly 1 match, found $count. No changes were written."
    }

    $script:text = $script:text.Replace($Old, $New)
}

Replace-Exact `
'const APP_VERSION = ''v39'';' `
'const APP_VERSION = ''v40.1'';' `
'APP_VERSION'

Replace-Exact `
'    if (typeof scheduleCloudPush === ''function'') scheduleCloudPush(key);' `
'    if (!cloudHydrationInProgress && typeof scheduleCloudPush === ''function'') scheduleCloudPush(key);' `
'DB.set hydration guard'

Replace-Exact `
'let sessionGeneration = 0;' `
'let cloudHydrationInProgress = false;

let sessionGeneration = 0;' `
'hydration flag'

Replace-Exact `
'  return migrateLegacyImageLocalStorage()
    .then(() => migrateInlineImagesFromLocalRecords())' `
'  cancelScheduledCloudPushes();
  cloudHydrationInProgress = true;

  return migrateLegacyImageLocalStorage()
    .then(() => migrateInlineImagesFromLocalRecords())' `
'pull hydration start'

Replace-Exact `
'      setLastSyncedNow();
    });
  });
}' `
'      setLastSyncedNow();
    });
  })
  .finally(() => {
    cloudHydrationInProgress = false;
  });
}' `
'pull hydration finally'

Replace-Exact `
'const pushTimers = {};
function scheduleCloudPush(rawKey) {' `
'const pushTimers = {};

function cancelScheduledCloudPushes() {
  Object.keys(pushTimers).forEach(key => {
    clearTimeout(pushTimers[key]);
    delete pushTimers[key];
  });
}

function scheduleCloudPush(rawKey) {' `
'push timer cancellation'

Replace-Exact `
function scheduleCloudPush(rawKey) {
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== ''active'') return;` `
function scheduleCloudPush(rawKey) {
  if (cloudHydrationInProgress) return;
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== ''active'') return;` `
'schedule hydration barrier'

Replace-Exact `
function syncCollectionArray(ref, items, cleanFn) {
  const currentIds = new Set(items.map(item => item.id));
  return ref.get().then(snapshot => {
    const ops = [];` `
function syncCollectionArray(ref, items, cleanFn) {
  const currentIds = new Set(items.map(item => item.id));

  // Never allow an empty local collection to mass-delete cloud data.
  // Intentional record-level deletions remain supported.
  if (!Array.isArray(items) || items.length === 0) {
    return ref.get().then(snapshot => {
      if (snapshot.empty) return commitChunks([]);
      console.warn('Cloud sync skipped destructive empty-collection operation.');
      return Promise.resolve();
    });
  }

  return ref.get().then(snapshot => {
    const ops = [];` `
'array empty protection'

Replace-Exact `
function syncKeyedCollection(ref, entries, makeData, allowedClassIds) {
  // Compare encoded Firestore IDs, not the raw local keys.` `
function syncKeyedCollection(ref, entries, makeData, allowedClassIds) {
  // Compare encoded Firestore IDs, not the raw local keys.` `
'keyed anchor validation'

# Replace only the deletion block inside syncKeyedCollection.
Replace-Exact `
    snapshot.forEach(doc => {
      if (!currentIds.has(doc.id)) ops.push(batch => batch.delete(ref.doc(doc.id)));
    });
    return commitChunks(ops);
  });
}` `
    if (Object.keys(entries || {}).length === 0 && !snapshot.empty) {
      console.warn('Cloud sync skipped destructive empty-keyed-collection operation.');
      return Promise.resolve();
    }

    snapshot.forEach(doc => {
      if (!currentIds.has(doc.id)) ops.push(batch => batch.delete(ref.doc(doc.id)));
    });
    return commitChunks(ops);
  });
}` `
'keyed empty protection'

# The student branch has a special scoped snapshot object. Protect its empty local state
# before constructing destructive operations.
Replace-Exact `
    return existingPromise.then(snapshot => {
      const currentIds = new Set(filtered.map(s => s.id));
      const ops = [];` `
    return existingPromise.then(snapshot => {
      if (filtered.length === 0) {
        console.warn('Cloud sync skipped destructive empty-student-collection operation.');
        return Promise.resolve();
      }

      const currentIds = new Set(filtered.map(s => s.id));
      const ops = [];` `
'student empty protection'

# Verify key protections exist before writing.
$required = @(
    "const APP_VERSION = 'v40.1';",
    "let cloudHydrationInProgress = false;",
    "if (!cloudHydrationInProgress && typeof scheduleCloudPush === 'function')",
    "function cancelScheduledCloudPushes()",
    "cloudHydrationInProgress = true;",
    ".finally(() => {",
    "Cloud sync skipped destructive empty-collection operation.",
    "Cloud sync skipped destructive empty-keyed-collection operation.",
    "Cloud sync skipped destructive empty-student-collection operation."
)

foreach ($needle in $required) {
    if ($text.IndexOf($needle, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Post-patch verification failed: missing '$needle'. No patched file was written."
    }
}

# Syntax-only validation is performed by a separate command after this script.
Set-Content -Path $app -Value $text -Encoding UTF8

Write-Host ""
Write-Host "v40.1 patch applied successfully." -ForegroundColor Green
Write-Host "Backup: $backup"
Write-Host "Patched: $app"
Write-Host ""
Write-Host "IMPORTANT: Firebase was NOT deployed."
Write-Host "Next step: run the syntax and patch verification commands."
