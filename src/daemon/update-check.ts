/**
 * Tells the UIs whether a newer clawdbox is available. For a git checkout this
 * compares the local HEAD with origin/main (one `git ls-remote` every interval,
 * no fetch). Opt out with --no-update-check.
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

  async check(): Promise<UpdateInfo> {
    try {
      const commit = await run('git', ['rev-parse', 'HEAD'], this.repoRoot);
      const remote = await run('git', ['ls-remote', 'origin', 'refs/heads/main'], this.repoRoot);
      const latest = remote.split(/\s+/)[0] || null;
      const available = !!latest && latest !== commit;
      if (available && !this.info.updateAvailable)
        this.log(`update available: ${commit.slice(0, 7)} -> ${latest!.slice(0, 7)} (run: clawdbox update)`);
      this.info = { ...this.info, commit, latestCommit: latest, updateAvailable: available, checkedAt: Date.now(), error: null };
    } catch (e) {
      this.info = { ...this.info, checkedAt: Date.now(), error: (e as Error).message.split('\n')[0] };
    }
    return this.info;
  }
}
