// Solstice versions itself separately from Horizon.
//
// SOLSTICE_VERSION is Solstice's own release version (CalVer, e.g. 2026.6.0), the single source for
// which is package.json. HORIZON_BASE_VERSION is the upstream F-Chat Horizon release the shared code
// is synced to; it is independent of the Solstice release cadence and is bumped by hand whenever a
// new Horizon release is merged in.
export const SOLSTICE_VERSION = (<{ version: string }>(
  require('../package.json') //tslint:disable-line:no-require-imports
)).version;

export const HORIZON_BASE_VERSION = '2.4.0-beta.0';
