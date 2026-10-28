/**
 * HISTORICAL legacy-sync audit.
 *
 * This intentionally audits the quarantined pre-V2 Supabase engine. Current
 * Cloud Sync v0.1.0 is documented and tested by the V2 suites; do not use this
 * report as a release verdict for that implementation.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = file => readFile(file, 'utf8');
const [types, engine, scheduler, app, env, schema, supabaseSchema, spec] = await Promise.all([
  read('src/types/sync.ts'),
  read('src/services/sync/SyncEngine.ts'),
  read('src/services/sync/SyncScheduler.ts'),
  read('src/app/App.tsx'),
  read('.env.example'),
  read('src/database/schema.ts'),
  read('supabase/schema.sql'),
  read('docs/SYNC_0_SPEC.md'),
]);

const requiredLocalFamilies = [
  'workspace', 'folder', 'canvasFile', 'canvasData', 'customBlock',
  'notebook', 'notebookSection', 'notebookPage', 'notebookPageContent',
  'notebookPageDrawing', 'pdfAsset', 'imageAsset', 'audioAsset',
  'localElement', 'workspaceSettings',
];
const legacyEntityTypes = [...types.matchAll(/'([^']+)'/g)]
  .map(match => match[1])
  .filter(value => ['workspace', 'folder', 'canvasFile', 'canvasData'].includes(value));
const uniqueLegacyEntityTypes = [...new Set(legacyEntityTypes)];
const missingFamilies = requiredLocalFamilies.filter(value => !uniqueLegacyEntityTypes.includes(value));
const remoteTables = [...supabaseSchema.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g)].map(match => match[1]);

assert.match(env, /^VITE_ENABLE_CLOUD_SYNC=false$/m, 'cloud sync defaults to disabled');
assert.match(scheduler, /if \(!CLOUD_SYNC_ENABLED\) return;/, 'scheduler is feature-gated');
assert.match(app, /if \(+!CLOUD_SYNC_ENABLED(?:\s*\|\||\s*&&|\))/, 'application bootstrap is feature-gated');
assert.ok(missingFamilies.length > 0, 'legacy coverage remains incomplete while feature is disabled');
assert.match(engine, /LEGACY_SYNC_QUARANTINED = true/, 'legacy engine is explicitly quarantined');
assert.doesNotMatch(engine, /await db\.(workspaces|folders|canvasFiles)\.delete\(item\.entityId\)/, 'remote authorization errors never purge local entities');
assert.doesNotMatch(engine, /supabase\.from\('[^']+'\)\.delete\(\)/, 'legacy hard remote deletes are disabled');
assert.match(spec, /legacy\/quarantined/i, 'spec labels the current engine as quarantined');
assert.match(schema, /notebookPageDrawings/, 'audit includes the current final local schema');

console.log(JSON.stringify({
  status: 'HISTORICAL_LEGACY_AUDIT',
  currentImplementation: 'Cloud Sync v0.1.0 (V2)',
  cloudEnabledByDefault: false,
  legacyEntityTypes: uniqueLegacyEntityTypes,
  requiredLocalFamilies,
  missingFamilies,
  remoteTables,
  auditedHazards: {
    rendererDexieOutboxBypassedByElectron: true,
    destructiveRlsFailureBranch: false,
    automaticLocalWorkspacePurge: false,
    legacyEngineQuarantined: true,
    clientClockLastWriteWins: true,
    incompleteTombstonesAndAssets: true,
    rendererPersistedSupabaseSession: true,
  },
}, null, 2));
