import { describe, expect, it } from 'vitest'
import { splitSections } from '@shared/modules'
import {
  downsample,
  isCountedInterface,
  isWholeDisk,
  parseDf,
  parseDiskstats,
  parseMeminfo,
  parseNetDev,
  parseSadf,
  parseSample,
  pointFromSamples,
  summarize,
  type PerfSample
} from '@shared/performance'
import { parseCollecting } from '../src/main/performance'
import { nearestIndex, xTicks, yTicks } from '@shared/chart-scale'

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 286832847  335712    0    0    0     0          0         0 286832847  335712    0    0    0     0       0          0
  eth0:1000 20 0 0 0 0 0 0 500 10 0 0 0 0 0 0
 wlan0: 2000  30    0  302    0     0          0         0 300  822198    0  572    0     0       0          0
docker0: 99999 1 0 0 0 0 0 0 99999 1 0 0 0 0 0 0
vethab12: 99999 1 0 0 0 0 0 0 99999 1 0 0 0 0 0 0`

const DISKSTATS = ` 259       0 nvme0n1 588415 55055 1000 250203 1984007 39346 3000 1780004 0 310830 2068114 10980 0 43594680 4727 73094 33178
 259       2 nvme0n1p2 587121 47790 1000 249442 1983905 39346 3000 1779900 0 296264 2034070 10980 0 43594680 4727 0 0
   8       0 sda 10 0 10 0 10 0 20 0 0 0 0
   8       1 sda1 10 0 10 0 10 0 20 0 0 0 0
   7       0 loop0 10 0 999 0 10 0 999 0 0 0 0
 253       0 dm-0 10 0 999 0 10 0 999 0 0 0 0`

const MEMINFO = `MemTotal:        2000000 kB
MemFree:          200000 kB
MemAvailable:     500000 kB
Buffers:           10000 kB
Cached:           300000 kB
SwapTotal:       1000000 kB
SwapFree:         750000 kB`

const DF = `Filesystem     Type     1024-blocks     Used Available Capacity Mounted on
/dev/vda1      ext4        20000000 15000000   4000000       79% /
devtmpfs       devtmpfs      8002652        0     8002652        0% /dev
tmpfs          tmpfs         8073120    47708     8025412        1% /dev/shm
/dev/vda1      ext4        20000000 15000000   4000000       79% /var/lib/docker/bind
/dev/vdb       xfs         10000000  9800000    200000       98% /srv/datos con espacio
efivarfs       efivarfs          184      161          19       90% /sys/firmware/efi/efivars
/dev/loop3     squashfs        56320    56320         0      100% /snap/core/123`

function sampleOutput(cpu: string, uptime: string, rx: number, sectors: number, withDf = false): string {
  return [
    '@@stat',
    `cpu  ${cpu}`,
    '@@cpus',
    '2',
    '@@uptime',
    `${uptime} 100.00`,
    '@@load',
    '0.52 0.62 0.69 1/120 4242',
    '@@mem',
    MEMINFO,
    '@@net',
    `Inter-| x\n face |x\n  eth0: ${rx} 1 0 0 0 0 0 0 ${rx / 2} 1 0 0 0 0 0 0`,
    '@@disk',
    `   8       0 sda 1 0 ${sectors} 0 1 0 ${sectors * 2} 0 0 0 0`,
    ...(withDf ? ['@@df', DF] : []),
    ''
  ].join('\n')
}

describe('rendimiento: /proc', () => {
  it('suma solo las interfaces reales', () => {
    expect(parseNetDev(NET_DEV)).toEqual({ rx: 3000, tx: 800 })
    expect(isCountedInterface('ens3')).toBe(true)
    expect(isCountedInterface('br-1a2b')).toBe(false)
  })

  it('suma solo los discos enteros (sin particiones, loop ni device-mapper)', () => {
    expect(parseDiskstats(DISKSTATS)).toEqual({ read: (1000 + 10) * 512, write: (3000 + 20) * 512 })
    expect(['sda', 'vdb', 'xvda', 'nvme0n1', 'mmcblk0'].every(isWholeDisk)).toBe(true)
    expect(['sda1', 'nvme0n1p2', 'loop0', 'dm-0', 'mmcblk0p1', 'zram0'].some(isWholeDisk)).toBe(false)
  })

  it('lee meminfo en kB', () => {
    expect(parseMeminfo(MEMINFO)).toMatchObject({ MemTotal: 2000000, MemAvailable: 500000, SwapFree: 750000 })
  })

  it('df: sin pseudo-sistemas, snaps ni montajes repetidos; rutas con espacios', () => {
    const disks = parseDf(DF)
    expect(disks.map((d) => d.mount)).toEqual(['/', '/srv/datos con espacio'])
    expect(disks[0]).toMatchObject({ filesystem: '/dev/vda1', type: 'ext4', size: 20000000 * 1024, used: 15000000 * 1024, available: 4000000 * 1024 })
  })

  it('calcula CPU, memoria, red y disco entre dos lecturas', () => {
    // user nice system idle iowait irq softirq steal
    const first = parseSample(splitSections(sampleOutput('100 0 50 800 50 0 0 0', '1000.00', 10_000, 100, true)), 1_000)
    const second = parseSample(splitSections(sampleOutput('160 0 70 900 70 0 0 0', '1002.00', 30_000, 300)), 3_000)
    expect(first).toMatchObject({ cpus: 2, load: [0.52, 0.62, 0.69], memTotal: 2000000 * 1024, memAvailable: 500000 * 1024 })
    expect(first.disks?.map((d) => d.mount)).toEqual(['/', '/srv/datos con espacio'])
    expect(second.disks).toBeNull()

    const alone = pointFromSamples(null, first)
    expect(alone).toMatchObject({ t: 1_000, cpu: null, netRx: null, mem: 75, swap: 25, load1: 0.52 })

    const point = pointFromSamples(first, second)
    // Δtotal = 60 + 20 + 100 + 20 = 200; ocupado = 200 - (100 + 20) = 80 → 40 %; iowait 20/200 = 10 %.
    expect(point).toMatchObject({ t: 3_000, cpu: 40, iowait: 10, netRx: 10_000, netTx: 5_000, diskRead: 200 * 512 / 2, diskWrite: 400 * 512 / 2 })
  })

  it('sin tasas si el servidor se reinició o un contador volvió atrás', () => {
    const before = parseSample(splitSections(sampleOutput('100 0 50 800 50 0 0 0', '1000.00', 10_000, 100)), 1_000)
    const rebooted = parseSample(splitSections(sampleOutput('10 0 5 80 5 0 0 0', '30.00', 50, 1)), 2_000)
    expect(pointFromSamples(before, rebooted)).toMatchObject({ cpu: null, netRx: null, diskRead: null })
    const wrapped: PerfSample = { ...before, uptime: 1005, netRx: 5 }
    expect(pointFromSamples(before, wrapped)).toMatchObject({ netRx: null, netTx: 0 })
  })

  it('núcleos antiguos sin MemAvailable', () => {
    const sections = splitSections(sampleOutput('1 0 0 1 0 0 0 0', '1', 0, 0).replace(/MemAvailable:.*\n/, ''))
    expect(parseSample(sections, 0).memAvailable).toBe((200000 + 10000 + 300000) * 1024)
  })
})

// Formato de `sadf -d fichero -- -u -q -r -S -n DEV -b` (sysstat 12): un bloque por actividad.
const SADF = `# hostname;interval;timestamp;CPU;%user;%nice;%system;%iowait;%steal;%idle
web1;600;2026-11-13 04:10:01 UTC;-1;10.50;0.00;4.50;5.00;0.00;80.00
web1;600;2026-11-13 04:20:01 UTC;-1;2.00;0.00;1.00;0.00;0.00;97.00
web1;-1;2026-11-13 04:25:00 UTC;LINUX-RESTART	(2 CPU)
web1;600;2026-11-13 04:40:01 UTC;-1;1.00;0.00;1.00;0.00;0.00;98.00
# hostname;interval;timestamp;runq-sz;plist-sz;ldavg-1;ldavg-5;ldavg-15;blocked
web1;600;2026-11-13 04:10:01 UTC;1;300;1.52;0.80;0.40;0
web1;600;2026-11-13 04:20:01 UTC;0;290;0.10;0.30;0.35;0
# hostname;interval;timestamp;kbmemfree;kbavail;kbmemused;%memused;kbbuffers;kbcached;kbcommit;%commit;kbactive;kbinact;kbdirty
web1;600;2026-11-13 04:10:01 UTC;100000;500000;400000;20.00;10000;900000;800000;30.00;600000;500000;100
# hostname;interval;timestamp;kbswpfree;kbswpused;%swpused;kbswpcad;%swpcad
web1;600;2026-11-13 04:10:01 UTC;750000;250000;25.00;1000;0.40
# hostname;interval;timestamp;IFACE;rxpck/s;txpck/s;rxkB/s;txkB/s;rxcmp/s;txcmp/s;rxmcst/s;%ifutil
web1;600;2026-11-13 04:10:01 UTC;lo;5.00;5.00;100.00;100.00;0.00;0.00;0.00;0.00
web1;600;2026-11-13 04:10:01 UTC;eth0;10.00;8.00;2.00;1.00;0.00;0.00;0.00;0.00
web1;600;2026-11-13 04:10:01 UTC;eth1;10.00;8.00;0.50;0.25;0.00;0.00;0.00;0.00
web1;600;2026-11-13 04:10:01 UTC;docker0;10.00;8.00;50.00;50.00;0.00;0.00;0.00;0.00
# hostname;interval;timestamp;tps;rtps;wtps;dtps;bread/s;bwrtn/s;bdscd/s
web1;600;2026-11-13 04:10:01 UTC;3.00;1.00;2.00;0.00;8.00;16.00;0.00
`

describe('rendimiento: sysstat', () => {
  it('junta las actividades de cada momento', () => {
    const { points, interval } = parseSadf(SADF)
    expect(interval).toBe(600)
    expect(points.map((p) => new Date(p.t).toISOString())).toEqual(['2026-11-13T04:10:01.000Z', '2026-11-13T04:20:01.000Z', '2026-11-13T04:40:01.000Z'])
    // memoria: total = 400000 / 20 % = 2000000 kB; no disponible = 2000000 - 500000 → 75 %.
    expect(points[0]).toEqual({
      t: Date.parse('2026-11-13T04:10:01Z'),
      cpu: 15,
      iowait: 5,
      load1: 1.52,
      load5: 0.8,
      load15: 0.4,
      mem: 75,
      swap: 25,
      netRx: 2.5 * 1024,
      netTx: 1.25 * 1024,
      diskRead: 8 * 512,
      diskWrite: 16 * 512
    })
    expect(points[1]).toMatchObject({ cpu: 3, load1: 0.1, mem: null, netRx: null })
  })

  it('versiones sin kbavail usan %memused; ignora cabeceras desconocidas y líneas rotas', () => {
    const { points } = parseSadf(`# hostname;interval;timestamp;kbmemfree;kbmemused;%memused;kbbuffers;kbcached
h;600;2016-01-01 00:10:01;1;2;42.50;3;4
# hostname;interval;timestamp;foo;bar
h;600;2016-01-01 00:10:01;1;2
basura
h;600;2016-01-01 00:20:01;1;2;43.00`)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ t: Date.parse('2016-01-01T00:10:01Z'), mem: 42.5 })
  })

  it('sabe si la recogida está activa', () => {
    expect(parseCollecting('active\nactive\n')).toBe(true)
    expect(parseCollecting('inactive\nactive\nENABLED="false"\n')).toBe(false)
    expect(parseCollecting('inactive\ninactive\n')).toBe(false)
    expect(parseCollecting('')).toBeNull()
  })

  it('resume y reduce series', () => {
    const { points } = parseSadf(SADF)
    expect(summarize(points, 'cpu')).toEqual({ avg: 6.67, max: 15, maxAt: Date.parse('2026-11-13T04:10:01Z'), last: 2 })
    expect(summarize(points, 'swap')).toMatchObject({ avg: 25, max: 25, last: 25 })
    expect(summarize([], 'cpu')).toEqual({ avg: null, max: null, maxAt: null, last: null })
    const reduced = downsample(points, 2)
    expect(reduced).toHaveLength(2)
    expect(reduced[0]!.cpu).toBe(9)
    expect(reduced[1]!.cpu).toBe(2)
  })
})

describe('rendimiento: ejes de las gráficas', () => {
  it('divisiones redondas, en potencias de 1024 para bytes', () => {
    expect(yTicks(100, false, true).ticks).toEqual([0, 25, 50, 75, 100])
    expect(yTicks(3.7, false, false)).toEqual({ top: 4, ticks: [0, 1, 2, 3, 4] })
    const bytes = yTicks(3.4 * 1024 * 1024, true, false)
    expect(bytes.top).toBe(4 * 1024 * 1024)
    expect(bytes.ticks).toEqual([0, 1, 2, 3, 4].map((n) => n * 1024 * 1024))
  })

  it('horas redondas y el día a medianoche', () => {
    const start = new Date(2026, 10, 12, 7, 20).getTime()
    const ticks = xTicks([start, start + 24 * 3_600_000], 900)
    expect(ticks.length).toBeGreaterThanOrEqual(6)
    expect(ticks.every(({ t }) => new Date(t).getMinutes() === 0)).toBe(true)
    expect(ticks.find(({ t }) => new Date(t).getHours() === 0)?.label).toBe('13 nov')
    const week = xTicks([start, start + 7 * 24 * 3_600_000], 900)
    expect(week.every(({ label }) => /^\d+ \w+$/.test(label))).toBe(true)
  })

  it('punto más cercano', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1)
    expect(nearestIndex([10, 20, 30], 26)).toBe(2)
    expect(nearestIndex([10, 20, 30], -5)).toBe(0)
    expect(nearestIndex([], 5)).toBe(-1)
  })
})
