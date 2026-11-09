/**
 * Tells the UIs whether a newer clawdbox release is available. For a git checkout
 * this looks up the newest v* tag on origin (one `git ls-remote` per interval) and
 * reports "update available" when that commit is not already part of HEAD. The
 * only network egress of the daemon. Opt out with --no-update-check.
 */
import { execFile } from 'node:child_process';

export interface UpdateInfo {
  version: string;
  commit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  error: string | null;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

/** Commit of the newest v* tag on origin (what `clawdbox update` installs), or null when there is none. */
export async function latestReleaseCommit(repoRoot: string): Promise<string | null> {
  const out = await run('git', ['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*'], repoRoot);
  const tags = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return { sha, version: ref.replace('refs/tags/v', '') };
    })
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t.version))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!tags.length) return null;
  // annotated tags point at a tag object; resolve to the commit with ^{}
  const peeled = await run('git', ['ls-remote', 'origin', `refs/tags/v${tags[0].version}^{}`], repoRoot).catch(() => '');
  return (peeled.split(/\s+/)[0] || tags[0].sha) ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  try {
    await run('git', ['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

export class UpdateChecker {
  info: UpdateInfo;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repoRoot: string,
    version: string,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.info = { version, commit: null, latestCommit: null, updateAvailable: false, checkedAt: null, error: null };
  }

  start(intervalMs: number): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private running = false;

  /**
   * An update is available when the newest release tag on origin is not an ancestor
   * of HEAD. Local commits or a feature branch therefore do not count as "behind".
   */
  async check(): Promise<UpdateInfo> {
    if (this.running) return this.info;
    this.running = true;
    try {
      const commit = await run('git', ['rev-parse', 'HEAD'], this.repoRoot);
      const latest = await latestReleaseCommit(this.repoRoot);
      let available = false;
      if (latest && latest !== commit) {
        // fetch just that commit so ancestry can be tested without moving anything
        await run('git', ['fetch', '--quiet', '--depth=1', 'origin', latest], this.repoRoot, 60_000).catch(() => undefined);
        available = !(await isAncestor(latest, 'HEAD', this.repoRoot));
      }
      if (available && !this.info.updateAvailable && latest) {
        this.log(`update available: ${commit.slice(0, 7)} -> ${latest.slice(0, 7)} (run: clawdbox update)`);
      }
      this.info = { ...this.info, commit, latestCommit: latest, updateAvailable: available, checkedAt: Date.now(), error: null };
    } catch (e) {
      this.info = { ...this.info, checkedAt: Date.now(), error: (e as Error).message.split('\n')[0] };
    } finally {
      this.running = false;
    }
    return this.info;
  }
}
