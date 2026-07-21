import { describe, it, expect } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const SCRIPT = process.cwd() + '/scripts/install.sh'

async function runScript(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync('bash', [SCRIPT, ...args, '--dry-run', '--skip-postgres'], {
      timeout: 10_000,
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 }
  }
}

async function runScriptRaw(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync('bash', [SCRIPT, ...args], { timeout: 10_000 })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 }
  }
}

describe('install.sh argument parsing', () => {
  it('shows usage with --help', async () => {
    const { stdout, exitCode } = await runScript(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
    expect(stdout).toContain('LOCAL app server only')
  })

  it('errors on unknown option', async () => {
    const { stderr, exitCode } = await runScriptRaw(['--bogus'])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('Unknown option')
  })

  it('errors when --pg-version has no value', async () => {
    const { stderr, exitCode } = await runScriptRaw(['--pg-version'])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('--pg-version requires a value')
  })

  it('mentions remote server guidance in next steps', async () => {
    const { stdout, exitCode } = await runScript([])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('remote PostgreSQL server')
    expect(stdout).toContain('SSH username')
  })
})
