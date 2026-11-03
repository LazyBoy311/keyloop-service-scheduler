// Starts the real server (src/server.ts) as a child process on a free port.
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

export interface RunningServer { url: string; proc: ChildProcess }

export function startServer(dbPath: string): Promise<RunningServer> {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: '0', DB_PATH: dbPath, LOG_LEVEL: 'info' },
  });
  return new Promise((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (chunk) => {
      out += chunk;
      const port = out.match(/Server listening at http:\/\/[^"\s]+:(\d+)/)?.[1];
      if (port) resolve({ url: `http://127.0.0.1:${port}`, proc });
    });
    proc.stderr!.on('data', (chunk) => { out += chunk; });
    proc.once('exit', (code) => reject(new Error(`server exited with ${code}: ${out}`)));
  });
}

export const stopServer = (proc: ChildProcess) => new Promise<void>((resolve) => {
  if (proc.exitCode !== null) return resolve();
  proc.once('exit', () => resolve());
  proc.kill();
});
