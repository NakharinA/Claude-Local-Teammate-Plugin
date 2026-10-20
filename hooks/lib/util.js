// Small helpers shared by the mod and its backends.

export const TEAM_DIR = '.opencode-team'

export function errText(err) {
  return String(err && err.message ? err.message : err)
}

export function isWindowsPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

export function psQuote(s) {
  return String(s).replace(/'/g, "''")
}

/** Waits in an OS sleep, not $.clock.sleep: a hook's own budget counts clock sleeps. */
export async function pause($, ms, windows) {
  const argv = windows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds ' + ms]
    : ['sleep', String(ms / 1000)]
  try {
    await $.process.run(argv, { timeoutMs: ms + 15000 })
  } catch {
    // A failed sleep only shortens the wait.
  }
}

/** Starts a long-running process that outlives the hook, with stdout and stderr in logFile. */
export async function startDetached($, dir, command, args, logFile) {
  const argv = isWindowsPath(dir)
    ? [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // ArgumentList as one pre-quoted string: PowerShell 5 does not quote array items with spaces.
        "Start-Process -WindowStyle Hidden -FilePath '" + psQuote(command) + "'" +
          (args.length ? " -ArgumentList '" + psQuote(args.map(winArg).join(' ')) + "'" : '') +
          " -WorkingDirectory '" + psQuote(dir) + "' -RedirectStandardOutput '" + psQuote(logFile) +
          "' -RedirectStandardError '" + psQuote(logFile + '.err') + "'",
      ]
    : ['sh', '-c', 'nohup ' + [command, ...args].map(shQuote).join(' ') + ' >' + shQuote(logFile) + ' 2>&1 &']
  const started = await $.process.run(argv, { cwd: dir, timeoutMs: 20000 })
  if (started.exitCode !== 0) {
    throw new Error('could not start ' + command + ' (' + (started.stderr || started.stdout || 'exit ' + started.exitCode).trim().slice(0, 300) + ')')
  }
}

/** Quotes one argument for a Windows command line (CommandLineToArgvW rules). */
function winArg(a) {
  a = String(a)
  if (a && !/[\s"]/.test(a)) return a
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}
