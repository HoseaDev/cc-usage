import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let timer: NodeJS.Timeout | undefined;
let refreshing = false;

// Last full `/usage` text per account, for the showDetail command and tooltip.
let lastDetail = '';
let lastAccountLabel = '';

interface UsageResult {
  label: string; // short status-bar label, e.g. "75% ↺2h3m"
  detail: string; // full raw `/usage` output
}

// Cache `/usage` results per config dir so we don't spawn a heavyweight
// `claude` process on every refresh / terminal switch. TTL = refreshInterval.
// Stored on disk (not just in-memory) so multiple VSCode windows share one
// cache per account — without this, N windows each query the same account once
// per interval, multiplying the request rate by N.
interface CacheEntry {
  result: UsageResult;
  fetchedAt: number;
}

function cacheDir(): string {
  return path.join(os.tmpdir(), 'cc-usage-cache');
}

function cacheFileFor(configDir: string): string {
  const hash = crypto.createHash('sha1').update(configDir).digest('hex').slice(0, 16);
  return path.join(cacheDir(), `${hash}.json`);
}

function readDiskCache(configDir: string): CacheEntry | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(cacheFileFor(configDir), 'utf8'));
    if (typeof obj?.fetchedAt === 'number' && obj?.result?.detail !== undefined) return obj as CacheEntry;
  } catch {
    // missing / corrupt cache — treat as a miss
  }
  return undefined;
}

function writeDiskCache(configDir: string, entry: CacheEntry): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const file = cacheFileFor(configDir);
    // Write-then-rename so a concurrent reader in another window never sees a
    // half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // best-effort — a failed write just means the next refresh re-fetches
  }
}

function getRefreshIntervalMs(): number {
  const sec = vscode.workspace.getConfiguration('cc-usage').get<number>('refreshInterval', 60);
  return Math.max(5, sec) * 1000; // guard against absurd values
}

function defaultConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

function semverDesc(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}

function findClaudeBin(): string {
  const candidates: string[] = [];
  const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) {
    const versions = fs.readdirSync(nvmDir).sort(semverDesc);
    for (const v of versions) candidates.push(path.join(nvmDir, v, 'bin/claude'));
  }
  if (isWin) {
    const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming');
    candidates.push(path.join(appdata, 'npm/claude.cmd'), 'claude.cmd');
  } else {
    candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude');
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return isWin ? 'claude.cmd' : 'claude'; // fall back to PATH
}

// ---- Process-tree resolution: which account is the active terminal using? ----

interface ProcInfo {
  ppid: number;
  comm: string; // executable / process name
  cmd?: string; // full command line (Windows; used to spot node-wrapped claude)
}

async function getProcessSnapshot(): Promise<Map<number, ProcInfo>> {
  return isWin ? getProcessSnapshotWin() : getProcessSnapshotUnix();
}

async function getProcessSnapshotUnix(): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>();
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      map.set(parseInt(m[1], 10), { ppid: parseInt(m[2], 10), comm: m[3].trim() });
    }
  } catch {
    // ignore — caller handles empty snapshot
  }
  return map;
}

async function getProcessSnapshotWin(): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>();
  const psCmd =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.CommandLine }";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      if (isNaN(pid) || isNaN(ppid)) continue;
      map.set(pid, { ppid, comm: parts[2].trim(), cmd: parts.slice(3).join('|') });
    }
  } catch {
    // ignore
  }
  return map;
}

function looksLikeClaude(info: ProcInfo): boolean {
  const comm = info.comm.toLowerCase();
  if (/(^|[\\/])claude(\.exe|\.cmd|\.bat)?$/.test(comm)) return true;
  // Windows: claude is usually launched as `node ... claude` → match by cmdline.
  if (isWin && /claude/i.test(info.cmd ?? '')) return true;
  return false;
}

// Walk the whole descendant tree of shellPid (not just direct children) and
// return the first process that looks like a `claude` CLI. claude is often a
// grandchild (tmux, npx, wrappers, node shims), so a direct ppid==shellPid
// check is too fragile.
function findClaudePidUnder(shellPid: number, snapshot: Map<number, ProcInfo>): number | undefined {
  const childrenOf = new Map<number, number[]>();
  for (const [pid, info] of snapshot) {
    const arr = childrenOf.get(info.ppid) ?? [];
    arr.push(pid);
    childrenOf.set(info.ppid, arr);
  }

  const queue = [shellPid];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = snapshot.get(pid);
    if (info && pid !== shellPid && looksLikeClaude(info)) return pid;
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return undefined;
}

// PowerShell script that reads a target process's environment block via
// NtQueryInformationProcess + ReadProcessMemory (x64). Best-effort: prints
// "OK" then the CLAUDE_CONFIG_DIR value (blank if unset), or "ERR" on failure.
// Written to a temp file so we avoid shell-escaping a multi-line script.
const WIN_ENV_PS1 = [
  'param([int]$TargetPid)',
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  Add-Type -Namespace CcUsage -Name Peb -MemberDefinition @'",
  '[DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h,int c,byte[] info,int len,ref int ret);',
  '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a,bool i,int p);',
  '[DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h,IntPtr b,byte[] buf,int sz,ref int read);',
  '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
  "'@",
  '  $h = [CcUsage.Peb]::OpenProcess(0x0410, $false, $TargetPid)',
  "  if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR'; return }",
  '  $pbi = New-Object byte[] 48; $ret = 0',
  '  if ([CcUsage.Peb]::NtQueryInformationProcess($h,0,$pbi,48,[ref]$ret) -ne 0) { Write-Output \'ERR\'; return }',
  '  $pebAddr = [BitConverter]::ToInt64($pbi,8)',
  '  function R64($addr){ $b=New-Object byte[] 8; $n=0; [void][CcUsage.Peb]::ReadProcessMemory($h,[IntPtr]$addr,$b,8,[ref]$n); [BitConverter]::ToInt64($b,0) }',
  '  $procParams = R64 ($pebAddr + 0x20)',
  '  $envAddr = R64 ($procParams + 0x80)',
  '  $size = 65536; $buf = New-Object byte[] $size; $n = 0',
  '  [void][CcUsage.Peb]::ReadProcessMemory($h,[IntPtr]$envAddr,$buf,$size,[ref]$n)',
  '  [void][CcUsage.Peb]::CloseHandle($h)',
  '  $s = [System.Text.Encoding]::Unicode.GetString($buf,0,$n)',
  "  Write-Output 'OK'",
  "  foreach($line in ($s -split [char]0)){ if($line -like 'CLAUDE_CONFIG_DIR=*'){ Write-Output $line.Substring(18); break } }",
  "} catch { Write-Output 'ERR' }",
].join('\n');

let winScriptPath: string | undefined;
function ensureWinEnvScript(): string {
  if (!winScriptPath) {
    const p = path.join(os.tmpdir(), 'cc-usage-readenv.ps1');
    fs.writeFileSync(p, WIN_ENV_PS1, 'utf8');
    winScriptPath = p;
  }
  return winScriptPath;
}

// Read CLAUDE_CONFIG_DIR from a process's launch-time environment.
// Returns the config dir, or the default ~/.claude when the var isn't set
// (unset genuinely means claude uses its default account — not a guess).
// Returns undefined only when the environment can't be read at all.
async function readConfigDir(pid: number): Promise<string | undefined> {
  try {
    if (isWin) {
      const script = ensureWinEnvScript();
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid)],
        { timeout: 8000 }
      );
      const lines = stdout.replace(/\r/g, '').split('\n');
      if ((lines[0] ?? '').trim() !== 'OK') return undefined;
      const val = (lines[1] ?? '').trim();
      return val.length ? val : defaultConfigDir();
    }

    if (isLinux) {
      const raw = await fs.promises.readFile(`/proc/${pid}/environ`, 'utf8');
      const entry = raw.split('\0').find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
      return entry ? entry.slice('CLAUDE_CONFIG_DIR='.length) : defaultConfigDir();
    }

    // macOS
    const { stdout } = await execFileAsync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const m = stdout.match(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/);
    return m ? m[1] : defaultConfigDir();
  } catch {
    return undefined;
  }
}

function accountLabel(configDir: string): string {
  const base = path.basename(configDir);
  if (base === '.claude') return 'default';
  return base.replace(/^\.claude[-_]?/, '') || base;
}

// ---- Usage fetching ----

function parseUsageLabel(output: string): string {
  const sessionLine = output.split('\n').find((l) => l.toLowerCase().includes('current session'));
  if (!sessionLine) return '?';

  const pctMatch = sessionLine.match(/(\d+)%/);
  const pct = pctMatch ? pctMatch[1] + '%' : '?';

  // "resets Jun 16 at 1am" or "resets Jun 10 at 12:39am"
  const resetMatch = sessionLine.match(/resets\s+(\w+)\s+(\d+)\s+at\s+(\d+)(?::(\d+))?\s*(am|pm)/i);
  if (resetMatch) {
    const [, month, day, hourStr, minStr, ampm] = resetMatch;
    let hour = parseInt(hourStr, 10);
    const min = parseInt(minStr ?? '0', 10);
    if (/pm/i.test(ampm) && hour !== 12) hour += 12;
    if (/am/i.test(ampm) && hour === 12) hour = 0;
    const reset = new Date(`${month} ${day}, ${new Date().getFullYear()} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`);
    if (!isNaN(reset.getTime())) {
      const ms = reset.getTime() - Date.now();
      if (ms > 0) {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return `${pct} ↺${h > 0 ? `${h}h${m}m` : `${m}m`}`;
      }
    }
  }
  return pct;
}

async function fetchUsage(configDir: string): Promise<UsageResult> {
  const cached = readDiskCache(configDir);
  if (cached && Date.now() - cached.fetchedAt < getRefreshIntervalMs()) {
    return cached.result;
  }
  const bin = findClaudeBin();
  const { stdout } = await execFileAsync(bin, ['/usage'], {
    timeout: 10000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    shell: isWin, // .cmd shim needs a shell on Windows
  });
  const detail = stdout.trim();
  const result: UsageResult = { label: parseUsageLabel(detail), detail };
  writeDiskCache(configDir, { result, fetchedAt: Date.now() });
  return result;
}

// ---- Status bar rendering ----

function setStatus(text: string, tooltip: string | vscode.MarkdownString) {
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      setStatus('$(robot) Claude: 无活动终端', '没有活动的集成终端,无法确定当前账号。点击刷新。');
      return;
    }

    const shellPid = await terminal.processId;
    if (!shellPid) {
      setStatus('$(robot) Claude: 终端未就绪', '终端进程尚未启动完成,稍后重试。');
      return;
    }

    const snapshot = await getProcessSnapshot();
    const claudePid = findClaudePidUnder(shellPid, snapshot);
    if (!claudePid) {
      setStatus('$(robot) Claude: 无会话', '当前活动终端里没有正在运行的 claude 进程。切到运行 claude 的终端,或点击刷新。');
      return;
    }

    const configDir = await readConfigDir(claudePid);
    if (!configDir) {
      setStatus(
        '$(robot) Claude: 账号未知',
        `找到 claude 进程 (pid ${claudePid}) 但读不到它的账号配置 (CLAUDE_CONFIG_DIR)。${isWin ? 'Windows 上读取进程环境是尽力而为,可能受权限限制。' : ''}`
      );
      return;
    }

    const label = accountLabel(configDir);
    lastAccountLabel = label;
    try {
      const usage = await fetchUsage(configDir);
      lastDetail = usage.detail;
      const tooltip = new vscode.MarkdownString(`**账号: ${label}**\n\n\`\`\`\n${usage.detail}\n\`\`\`\n\n*点击查看详情*`);
      tooltip.isTrusted = true;
      setStatus(`$(robot) ${label}: ${usage.label}`, tooltip);
    } catch (err) {
      setStatus(`$(robot) ${label}: 查询失败`, `运行 \`claude /usage\` 失败 (账号 ${label}):\n${String(err)}`);
    }
  } finally {
    refreshing = false;
  }
}

function restartTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, getRefreshIntervalMs());
}

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'cc-usage.showDetail';
  statusBarItem.text = '$(robot) Claude...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  outputChannel = vscode.window.createOutputChannel('Claude Code Usage');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-usage.refresh', () => refresh()),
    vscode.commands.registerCommand('cc-usage.showDetail', () => {
      outputChannel.clear();
      outputChannel.appendLine(`账号: ${lastAccountLabel || '(未知)'}`);
      outputChannel.appendLine('');
      outputChannel.appendLine(lastDetail || '(暂无数据,正在刷新…)');
      outputChannel.show(true);
      refresh();
    })
  );

  // Re-resolve immediately when the user switches the active terminal, so the
  // status bar follows whichever account that terminal's claude is using.
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(() => refresh()));

  // Honor refreshInterval changes without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cc-usage.refreshInterval')) restartTimer();
    })
  );

  refresh();
  restartTimer();
}

export function deactivate() {
  if (timer) clearInterval(timer);
}
