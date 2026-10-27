import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { STORAGE_DIR } from './config';

/**
 * Absolute path to services/reconstruction (override with WL_WORKER_DIR).
 * Resolved at runtime from the working directory — never a statically
 * analyzable import, so the bundler leaves it alone.
 */
export function workerDir(): string {
  if (process.env.WL_WORKER_DIR) return process.env.WL_WORKER_DIR;
  const cwd = process.cwd();
  if (cwd.endsWith(join('apps', 'web'))) return resolve(cwd, '..', '..', 'services', 'reconstruction');
  return resolve(cwd, 'services', 'reconstruction');
}

/**
 * Launch the Python worker detached so the request returns immediately while
 * reconstruction runs. Progress is polled via GET /api/jobs/:jobId, which
 * reads the same STORAGE_DIR job records (jobs survive refresh).
 */
export function spawnWorker(args: string[]): void {
  const child = spawn('python3', ['-m', 'worker', ...args], {
    cwd: workerDir(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, STORAGE_DIR },
  });
  child.unref();
}
