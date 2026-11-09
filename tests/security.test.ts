import { describe, expect, it } from 'vitest'
import {
  isJailName,
  isListening,
  isLoopback,
  isMulticast,
  isPrivate,
  isWildcard,
  parseJail,
  parseJailList,
  parseSs,
  parseSshLog,
  parseWho,
  splitHostPort,
  summarizeFailures
} from '@shared/security'

const SS = `udp ESTAB     0      0                    192.168.0.173:57227  172.217.20.234:443 users:(("brave",pid=295461,fd=136))
udp UNCONN    0      0                       127.0.0.53:53            0.0.0.0:*
tcp LISTEN    0      128                        0.0.0.0:22            0.0.0.0:*     users:(("sshd",pid=812,fd=3))
tcp LISTEN    0      80                       127.0.0.1:3306          0.0.0.0:*
tcp LISTEN    0      511                              *:80                  *:*     users:(("httpd",pid=900,fd=4),("httpd",pid=901,fd=4))
tcp ESTAB     0      0                     10.0.0.5:22       [::ffff:203.0.113.9]:51234 users:(("sshd",pid=4242,fd=4))
tcp ESTAB     0      0               [2001:db8::1]:443       [2001:db8::99]:60000
tcp TIME-WAIT 0      0                     10.0.0.5:80           198.51.100.7:40000
udp UNCONN    0      0                0.0.0.0%eth0:68              0.0.0.0:*`

describe('seguridad: direcciones', () => {
  it('separa dirección y puerto', () => {
    expect(splitHostPort('1.2.3.4:22')).toEqual({ address: '1.2.3.4', port: '22' })
    expect(splitHostPort('[::1]:631')).toEqual({ address: '::1', port: '631' })
    expect(splitHostPort('[::ffff:203.0.113.9]:51234')).toEqual({ address: '203.0.113.9', port: '51234' })
    expect(splitHostPort('*:80')).toEqual({ address: '*', port: '80' })
    expect(splitHostPort('0.0.0.0%eth0:68')).toEqual({ address: '0.0.0.0', port: '68' })
  })
  it('clasifica direcciones', () => {
    expect(isLoopback('127.0.0.53')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isWildcard('*')).toBe(true)
    expect(isWildcard('::')).toBe(true)
    expect(isWildcard('10.0.0.5')).toBe(false)
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', 'fd00::1', 'fe80::1']) expect(isPrivate(ip)).toBe(true)
    for (const ip of ['172.32.0.1', '8.8.8.8', '203.0.113.9', '2001:db8::1']) expect(isPrivate(ip)).toBe(false)
    expect(isMulticast('224.0.0.251')).toBe(true)
    expect(isMulticast('239.255.255.250')).toBe(true)
    expect(isMulticast('ff02::fb')).toBe(true)
    expect(isMulticast('223.1.1.1')).toBe(false)
  })
})

describe('seguridad: ss', () => {
  it('interpreta sockets con y sin proceso', () => {
    const sockets = parseSs(SS)
    expect(sockets).toHaveLength(9)
    expect(sockets[0]).toEqual({
      proto: 'udp',
      state: 'ESTAB',
      localAddress: '192.168.0.173',
      localPort: '57227',
      peerAddress: '172.217.20.234',
      peerPort: '443',
      process: 'brave',
      pid: 295461
    })
    expect(sockets[3]).toMatchObject({ proto: 'tcp', state: 'LISTEN', localAddress: '127.0.0.1', localPort: '3306', process: null, pid: null })
    expect(sockets[4]).toMatchObject({ localAddress: '*', localPort: '80', process: 'httpd', pid: 900 })
    expect(sockets[5]).toMatchObject({ peerAddress: '203.0.113.9', process: 'sshd' })
    expect(sockets.filter(isListening).map((s) => `${s.proto}/${s.localPort}`)).toEqual(['udp/53', 'tcp/22', 'tcp/3306', 'tcp/80', 'udp/68'])
  })
})

const JOURNAL = `2026-11-09T03:12:01+0100 web sshd[1001]: Invalid user admin from 203.0.113.9 port 51000
2026-11-09T03:12:03+0100 web sshd[1001]: Failed password for invalid user admin from 203.0.113.9 port 51000 ssh2
2026-11-09T03:12:06+0100 web sshd[1001]: Failed password for invalid user admin from 203.0.113.9 port 51000 ssh2
2026-11-09T03:13:00+0100 web sshd-session[1002]: Invalid user oracle from 203.0.113.9 port 51010
2026-11-09T04:00:00+0100 web sshd[1003]: Failed password for root from 198.51.100.7 port 40000 ssh2
2026-11-09T08:30:12+0100 web sshd[2000]: Accepted publickey for deploy from 192.168.1.20 port 55555 ssh2: ED25519 SHA256:abc
2026-11-09T08:31:00+0100 web sshd[2001]: Connection closed by 192.168.1.20 port 55556`

const SYSLOG = `Nov  9 03:12:01 web sshd[1001]: Failed publickey for git from 198.51.100.7 port 40000 ssh2: RSA SHA256:x
Nov  9 08:30:12 web sshd[2000]: Accepted password for ana from 10.0.0.9 port 55555 ssh2
Nov  9 08:30:12 web CRON[2000]: pam_unix(cron:session): session opened`

describe('seguridad: registro de sshd', () => {
  it('reconoce fallidos, usuarios inexistentes y accesos (journal y syslog)', () => {
    const events = parseSshLog(JOURNAL)
    expect(events.map((e) => e.kind)).toEqual(['invalid', 'failed', 'failed', 'invalid', 'failed', 'accepted'])
    expect(events[5]).toMatchObject({ user: 'deploy', ip: '192.168.1.20', method: 'publickey', time: '2026-11-09T08:30:12+0100' })
    const syslog = parseSshLog(SYSLOG)
    expect(syslog).toEqual([
      { time: 'Nov  9 03:12:01', kind: 'failed', method: 'publickey', user: 'git', ip: '198.51.100.7', pid: 1001 },
      { time: 'Nov  9 08:30:12', kind: 'accepted', method: 'password', user: 'ana', ip: '10.0.0.9', pid: 2000 }
    ])
  })

  it('cuenta los intentos por IP sin duplicar «Invalid user» + «Failed» de la misma conexión', () => {
    const summary = summarizeFailures(parseSshLog(JOURNAL))
    expect(summary).toEqual([
      { ip: '203.0.113.9', attempts: 3, users: ['admin', 'oracle'], first: '2026-11-09T03:12:03+0100', last: '2026-11-09T03:13:00+0100' },
      { ip: '198.51.100.7', attempts: 1, users: ['root'], first: '2026-11-09T04:00:00+0100', last: '2026-11-09T04:00:00+0100' }
    ])
  })
})

describe('seguridad: who y fail2ban', () => {
  it('who', () => {
    expect(parseWho('jesusliz pts/0        2026-11-09 08:23 (:0)\nroot     pts/1        2026-11-09 09:32 (203.0.113.9)\nana      tty1         2026-11-09 07:00\n')).toEqual([
      { user: 'jesusliz', tty: 'pts/0', since: '2026-11-09 08:23', from: ':0' },
      { user: 'root', tty: 'pts/1', since: '2026-11-09 09:32', from: '203.0.113.9' },
      { user: 'ana', tty: 'tty1', since: '2026-11-09 07:00', from: '' }
    ])
  })

  it('fail2ban-client status', () => {
    expect(parseJailList('Status\n|- Number of jail:\t2\n`- Jail list:\tnginx-http-auth, sshd\n')).toEqual(['nginx-http-auth', 'sshd'])
    expect(parseJailList('Status\n|- Number of jail:\t0\n`- Jail list:\t\n')).toEqual([])
    const jail = parseJail(
      'sshd',
      'Status for the jail: sshd\n|- Filter\n|  |- Currently failed:\t3\n|  |- Total failed:\t120\n|  `- Journal matches:\t_SYSTEMD_UNIT=sshd.service + _COMM=sshd\n`- Actions\n   |- Currently banned:\t2\n   |- Total banned:\t15\n   `- Banned IP list:\t203.0.113.9 198.51.100.7\n'
    )
    expect(jail).toEqual({ name: 'sshd', currentlyFailed: 3, totalFailed: 120, currentlyBanned: 2, totalBanned: 15, bannedIps: ['203.0.113.9', '198.51.100.7'] })
    expect(parseJail('x', '`- Banned IP list:\t\n').bannedIps).toEqual([])
    expect(isJailName('nginx-http-auth')).toBe(true)
    expect(isJailName('sshd; rm')).toBe(false)
  })
})
