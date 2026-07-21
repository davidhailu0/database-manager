import { describe, it, expect } from 'vitest'
import { isLocalHost, isRemoteConnection, getSshHost, buildStanzaEntries } from '../app/api/[[...route]]/route'

describe('isLocalHost', () => {
  it('returns true for localhost', () => {
    expect(isLocalHost('localhost')).toBe(true)
  })

  it('returns true for 127.0.0.1', () => {
    expect(isLocalHost('127.0.0.1')).toBe(true)
  })

  it('returns true for ::1', () => {
    expect(isLocalHost('::1')).toBe(true)
  })

  it('returns true for 0.0.0.0', () => {
    expect(isLocalHost('0.0.0.0')).toBe(true)
  })

  it('returns true for empty string (Unix socket)', () => {
    expect(isLocalHost('')).toBe(true)
  })

  it('returns true for subdomains of localhost', () => {
    expect(isLocalHost('pg.localhost')).toBe(true)
    expect(isLocalHost('db.localhost')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isLocalHost('LOCALHOST')).toBe(true)
    expect(isLocalHost('LocalHost')).toBe(true)
  })

  it('returns false for remote IPs', () => {
    expect(isLocalHost('192.168.1.100')).toBe(false)
    expect(isLocalHost('10.0.0.1')).toBe(false)
    expect(isLocalHost('172.16.0.1')).toBe(false)
    expect(isLocalHost('8.8.8.8')).toBe(false)
  })

  it('returns false for remote hostnames', () => {
    expect(isLocalHost('db.example.com')).toBe(false)
    expect(isLocalHost('postgres-server')).toBe(false)
    expect(isLocalHost('mydb.internal')).toBe(false)
  })

  it('returns false for lookalike hostnames', () => {
    expect(isLocalHost('localhost.example.com')).toBe(false)
    expect(isLocalHost('127.0.0.2')).toBe(false)
    expect(isLocalHost('notlocalhost')).toBe(false)
  })
})

describe('isRemoteConnection', () => {
  it('returns false for localhost URLs', () => {
    expect(isRemoteConnection('postgresql://user:pass@localhost:5432/mydb')).toBe(false)
    expect(isRemoteConnection('postgresql://user:pass@127.0.0.1:5432/mydb')).toBe(false)
    expect(isRemoteConnection('postgresql://user:pass@::1:5432/mydb')).toBe(false)
  })

  it('returns false for empty host (Unix socket)', () => {
    expect(isRemoteConnection('postgresql:///mydb')).toBe(false)
    expect(isRemoteConnection('postgresql://user:pass@:5432/mydb')).toBe(false)
  })

  it('returns true for remote IP URLs', () => {
    expect(isRemoteConnection('postgresql://user:pass@192.168.1.100:5432/mydb')).toBe(true)
    expect(isRemoteConnection('postgresql://user:pass@10.0.0.1:5432/mydb')).toBe(true)
    expect(isRemoteConnection('postgresql://user:pass@8.8.8.8:5432/mydb')).toBe(true)
  })

  it('returns true for remote hostname URLs', () => {
    expect(isRemoteConnection('postgresql://user:pass@db.example.com:5432/mydb')).toBe(true)
    expect(isRemoteConnection('postgresql://user:pass@postgres-server:5432/mydb')).toBe(true)
  })

  it('returns false for invalid URLs', () => {
    expect(isRemoteConnection('not-a-url')).toBe(false)
    expect(isRemoteConnection('')).toBe(false)
  })
})

describe('getSshHost', () => {
  it('returns null for local connections', () => {
    expect(getSshHost('postgresql://user:pass@localhost:5432/mydb')).toBeNull()
    expect(getSshHost('postgresql://user:pass@127.0.0.1:5432/mydb')).toBeNull()
    expect(getSshHost('postgresql:///mydb')).toBeNull()
  })

  it('returns the hostname for remote connections', () => {
    expect(getSshHost('postgresql://user:pass@192.168.1.100:5432/mydb')).toBe('192.168.1.100')
    expect(getSshHost('postgresql://user:pass@db.example.com:5432/mydb')).toBe('db.example.com')
    expect(getSshHost('postgresql://user:pass@postgres-server:5432/mydb')).toBe('postgres-server')
  })

  it('returns null for invalid URLs', () => {
    expect(getSshHost('not-a-url')).toBeNull()
    expect(getSshHost('')).toBeNull()
  })
})

describe('buildStanzaEntries', () => {
  const pgDataDir = '/var/lib/postgresql/15/main'

  it('returns only pg1-path for local connections', () => {
    const entries = buildStanzaEntries(pgDataDir, 'postgresql://user:pass@localhost:5432/mydb')
    expect(entries).toEqual([{ key: 'pg1-path', value: pgDataDir }])
  })

  it('returns only pg1-path for 127.0.0.1', () => {
    const entries = buildStanzaEntries(pgDataDir, 'postgresql://user:pass@127.0.0.1:5432/mydb')
    expect(entries).toEqual([{ key: 'pg1-path', value: pgDataDir }])
  })

  it('returns only pg1-path for Unix socket', () => {
    const entries = buildStanzaEntries(pgDataDir, 'postgresql:///mydb')
    expect(entries).toEqual([{ key: 'pg1-path', value: pgDataDir }])
  })

  it('includes pg1-host, pg1-user, pg1-port for remote connections', () => {
    const entries = buildStanzaEntries(pgDataDir, 'postgresql://user:pass@db.example.com:5432/mydb')
    expect(entries).toEqual([
      { key: 'pg1-host', value: 'db.example.com' },
      { key: 'pg1-user', value: 'postgres' },
      { key: 'pg1-port', value: '5432' },
      { key: 'pg1-path', value: pgDataDir },
    ])
  })

  it('uses custom port for remote connections', () => {
    const entries = buildStanzaEntries(pgDataDir, 'postgresql://user:pass@192.168.1.100:6543/mydb')
    expect(entries).toEqual([
      { key: 'pg1-host', value: '192.168.1.100' },
      { key: 'pg1-user', value: 'postgres' },
      { key: 'pg1-port', value: '6543' },
      { key: 'pg1-path', value: pgDataDir },
    ])
  })

  it('defaults port to 5432 when not specified', () => {
    const entries = buildStanzaEntries(pgDataDir, 'postgresql://user:pass@db.example.com/mydb')
    expect(entries.find(e => e.key === 'pg1-port')?.value).toBe('5432')
  })

  it('falls back to local-only config for invalid URLs', () => {
    const entries = buildStanzaEntries(pgDataDir, 'not-a-url')
    expect(entries).toEqual([{ key: 'pg1-path', value: pgDataDir }])
  })
})
