// Cross-platform dispatcher for the native engine build: the npm pre-hooks (preserver, prebatch,
// prescenarios, prebuild) used to invoke the PowerShell script directly, which aborts every one of
// those npm scripts on Linux/macOS with "powershell: command not found" before build-native.sh
// could ever run. Pick the right toolchain script for the platform instead.
import { spawnSync } from 'node:child_process';
const win = process.platform === 'win32';
const r = win
  ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-native.ps1'], { stdio: 'inherit' })
  : spawnSync('bash', ['scripts/build-native.sh'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
