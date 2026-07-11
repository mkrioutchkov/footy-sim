// The ONE place that knows what the native engine binary is called. build-native.ps1 emits
// build/live.exe (Windows), scripts/build-native.sh emits build/live (Linux/macOS); a checkout can
// have both. Prefer the platform-native name, fall back to the other — and keep every spawner
// (backend match runner, live coordinator, dev cpp-server, batch/scenario tools) on this helper so
// the resolution can never diverge between entry points.
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveEngine(buildDir: string): string {
  const names = process.platform === 'win32' ? ['live.exe', 'live'] : ['live', 'live.exe'];
  for (const n of names) {
    const p = path.join(buildDir, n);
    if (existsSync(p)) return p;
  }
  return path.join(buildDir, names[0]);   // not built yet: report the platform-native name
}
