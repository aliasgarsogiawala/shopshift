import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs/atomic.js';
import { isProcessAlive } from './fs/lock.js';
import type { ShopShiftPaths } from './paths.js';

/** A development server ShopShift started and is still waiting on. */
export interface DevSession {
  pid: number;
  workspace: string;
  store: string;
  port: number;
  directory: string;
  /** Set when the session targets a specific theme instead of the store's development theme. */
  themeId?: string;
  startedAt: string;
}

export class SessionRegistry {
  constructor(private readonly paths: ShopShiftPaths) {}

  /** Returns live sessions and clears out records left behind by crashed ones. */
  list(): DevSession[] {
    let files: string[];
    try {
      files = readdirSync(this.paths.sessionsDir);
    } catch {
      return [];
    }
    const sessions: DevSession[] = [];
    for (const file of files.filter((name) => /^\d+\.json$/.test(name))) {
      const full = path.join(this.paths.sessionsDir, file);
      const session = readSession(full);
      if (session === undefined || !isProcessAlive(session.pid)) rmSync(full, { force: true });
      else sessions.push(session);
    }
    return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async register(session: DevSession): Promise<() => void> {
    mkdirSync(this.paths.sessionsDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.paths.sessionsDir, `${session.pid}.json`);
    await writeFileAtomic(file, JSON.stringify(session));
    const remove = () => {
      process.off('exit', remove);
      rmSync(file, { force: true });
    };
    process.on('exit', remove);
    return remove;
  }
}

function readSession(file: string): DevSession | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<DevSession>;
    const valid =
      typeof value.pid === 'number' &&
      typeof value.workspace === 'string' &&
      typeof value.store === 'string' &&
      typeof value.port === 'number' &&
      typeof value.startedAt === 'string';
    return valid ? (value as DevSession) : undefined;
  } catch {
    return undefined;
  }
}
