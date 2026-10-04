// Backend local SIN jobs en segundo plano (sync de torneos / scheduler diario).
// Útil cuando .env apunta a la BD de producción:  node scripts/dev-nojobs.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DISABLE_BACKGROUND_JOBS: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
