/**
 * Runs the sync-core unit + integration tests with Node's built-in test runner
 * (zero test dependencies). The tests are TypeScript run via Node's type
 * stripping: that is on by default from Node 23.6, but needs the
 * `--experimental-strip-types` flag on older Node (the repo's local toolchain can
 * be either), so this shim adds the flag only when required. Invoked by the root
 * `pnpm test` script.
 */

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
const needsFlag = major < 23 || (major === 23 && minor < 6);
const flags = needsFlag ? ['--experimental-strip-types'] : [];

// Run from the sync directory and let the test runner auto-discover the
// `*.test.ts` files there (a bare directory argument is not portable across the
// Node versions this repo targets).
const dir = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
    process.execPath,
    [...flags, '--test'],
    {stdio: 'inherit', cwd: dir}
);
process.exit(result.status ?? 1);
