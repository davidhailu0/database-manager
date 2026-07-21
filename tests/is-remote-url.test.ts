import { describe, it, expect } from 'vitest'
import { isRemoteUrl } from '../lib/api'

describe('isRemoteUrl (client-side)', () => {
  it('returns false for localhost', () => {
    expect(isRemoteUrl('postgresql://user:pass@localhost:5432/mydb')).toBe(false)
  })

  it('returns false for 127.0.0.1', () => {
    expect(isRemoteUrl('postgresql://user:pass@127.0.0.1:5432/mydb')).toBe(false)
  })

  it('returns false for 0.0.0.0', () => {
    expect(isRemoteUrl('postgresql://user:pass@0.0.0.0:5432/mydb')).toBe(false)
  })

  it('returns false for ::1', () => {
    expect(isRemoteUrl('postgresql://user:pass@::1:5432/mydb')).toBe(false)
  })

  it('returns false for empty host (Unix socket)', () => {
    expect(isRemoteUrl('postgresql:///mydb')).toBe(false)
    expect(isRemoteUrl('postgresql://user:pass@:5432/mydb')).toBe(false)
  })

  it('returns false for *.localhost', () => {
    expect(isRemoteUrl('postgresql://user:pass@pg.localhost:5432/mydb')).toBe(false)
  })

  it('returns true for remote IPs', () => {
    expect(isRemoteUrl('postgresql://user:pass@192.168.1.100:5432/mydb')).toBe(true)
    expect(isRemoteUrl('postgresql://user:pass@10.0.0.5:5432/mydb')).toBe(true)
  })

  it('returns true for remote hostnames', () => {
    expect(isRemoteUrl('postgresql://user:pass@db.example.com:5432/mydb')).toBe(true)
    expect(isRemoteUrl('postgresql://user:pass@postgres-server:5432/mydb')).toBe(true)
  })

  it('returns false for invalid URLs', () => {
    expect(isRemoteUrl('not-a-url')).toBe(false)
    expect(isRemoteUrl('')).toBe(false)
  })

  it('returns false while typing (partial URL)', () => {
    expect(isRemoteUrl('postgresql://')).toBe(false)
    expect(isRemoteUrl('postgresql://user:pass@')).toBe(false)
  })
})
