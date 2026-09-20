import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { createServer as createViteServer } from 'vite'
import { Tunnel } from 'cloudflared'
import localtunnel from 'localtunnel'
import os from 'os'
import fs from 'fs'
import path from 'path'

const PORT = Number(process.env.PORT || 5173)
let tunnelUrl = null

// --- Collective motion aggregate ----------------------------------------------
// Stores the last MAX_SESSIONS sessions from different players.
// Each entry: { avgHitSpeed, threshold, hitCount, submittedAt }
// The global recommendation is the hit-count-weighted average threshold.

const AGGREGATE_FILE = path.resolve('./data/motion-aggregate.json')
const MAX_SESSIONS   = 200   // rolling window - oldest dropped when full
const MIN_HITS_TO_SUBMIT = 8 // sessions with fewer hits are too noisy to trust

let motionSessions = loadAggregate()

function loadAggregate() {
  try {
    fs.mkdirSync(path.dirname(AGGREGATE_FILE), { recursive: true })
    const raw = fs.readFileSync(AGGREGATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function saveAggregate() {
  try {
    fs.writeFileSync(AGGREGATE_FILE, JSON.stringify(motionSessions), 'utf8')
  } catch {
    // non-fatal
  }
}

function computeGlobalProfile() {
  if (motionSessions.length === 0) return null

  // Weighted average: sessions with more confirmed hits count more
  let weightedThresholdSum = 0
  let weightedSpeedSum = 0
  let totalWeight = 0

  for (const s of motionSessions) {
    const w = s.hitCount
    weightedThresholdSum += s.threshold * w
    weightedSpeedSum     += s.avgHitSpeed * w
    totalWeight          += w
  }

  return {
    recommendedThreshold: weightedThresholdSum / totalWeight,
    avgHitSpeed:          weightedSpeedSum / totalWeight,
    dataPoints:           motionSessions.length,
    totalSwings:          totalWeight,
  }
}
let tunnelProcess = null
let tunnelPending = true
let tunnelRestarting = false
let io = null

const VIRTUAL_ADAPTER = /vmware|vmnet|virtualbox|vboxnet|wsl|hyper-v|vethernet|docker|npcap|tailscale|bluetooth|loopback/i

function getNetworkAddresses() {
  const nets = os.networkInterfaces()
  const addresses = []

  for (const [name, addrs] of Object.entries(nets)) {
    for (const net of addrs ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      addresses.push({
        name,
        ip: net.address,
        virtual: VIRTUAL_ADAPTER.test(name) || net.address.startsWith('169.254.'),
      })
    }
  }

  return addresses
}

function getLocalIp() {
  const addresses = getNetworkAddresses()
  const physical = addresses.filter((a) => !a.virtual)
  const preferred = physical.find((a) => /wi-fi|wifi|wlan|ethernet|eth/i.test(a.name))
  if (preferred) return preferred.ip
  if (physical[0]) return physical[0].ip
  return addresses[0]?.ip ?? 'localhost'
}

function startCloudflaredTunnel(port) {
  return new Promise((resolve, reject) => {
    const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`, { '--no-autoupdate': true })
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      fn(value)
    }

    const timeout = setTimeout(() => {
      tunnel.stop()
      finish(reject, new Error('Cloudflare tunnel timed out'))
    }, 45000)

    tunnel.once('url', (url) => {
      finish(resolve, { url, proc: tunnel, kind: 'cloudflared' })
    })

    tunnel.once('error', (err) => {
      tunnel.stop()
      finish(reject, err)
    })

    tunnel.once('exit', (code) => {
      if (code && code !== 0) {
        finish(reject, new Error(`cloudflared exited (${code})`))
      }
    })
  })
}

function startLocaltunnel(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Localtunnel timed out'))
    }, 20000)

    localtunnel({ port })
      .then((tunnel) => {
        clearTimeout(timeout)
        resolve({ url: tunnel.url, proc: tunnel, kind: 'localtunnel' })
      })
      .catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })
  })
}

function closeTunnel(tunnel) {
  if (!tunnel) return
  if (tunnel.kind === 'localtunnel') {
    tunnel.proc?.close?.()
    return
  }
  tunnel.proc?.stop?.()
}

function announceTunnel(tunnel) {
  tunnelUrl = tunnel.url
  tunnelProcess = tunnel
  tunnelPending = false
  tunnelRestarting = false
  io?.emit('tunnel-ready', { tunnelUrl })
  console.log(`  Tunnel:  ${tunnelUrl}  <- scan from any phone (${tunnel.kind})`)

  const onLost = () => {
    if (tunnelProcess !== tunnel) return
    tunnelUrl = null
    tunnelPending = true
    tunnelProcess = null
    io?.emit('tunnel-lost')
    console.log('  Tunnel lost - reconnecting...')
    queueTunnelRestart(PORT)
  }

  if (tunnel.kind === 'localtunnel') {
    tunnel.proc.on('close', onLost)
    tunnel.proc.on('error', onLost)
    return
  }

  tunnel.proc.on('exit', onLost)
  tunnel.proc.on('error', onLost)
}

async function startReliableTunnel(port) {
  const tryStart = async (label, startFn) => {
    let tunnel = null
    try {
      tunnel = await startFn()
      return tunnel
    } catch (err) {
      closeTunnel(tunnel)
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  ${label} failed (${message})`)
    }
    return null
  }

  // Cloudflare first — localtunnel often shows "tunnel unavailable" on phones.
  const first = await tryStart('Cloudflare tunnel', () => startCloudflaredTunnel(port))
  if (first) return first

  const retry = await tryStart('Cloudflare tunnel retry', () => startCloudflaredTunnel(port))
  if (retry) return retry

  const backup = await tryStart('Localtunnel backup', () => startLocaltunnel(port))
  if (backup) return backup

  throw new Error('Tunnel unavailable')
}

function queueTunnelRestart(port) {
  if (tunnelRestarting) return
  tunnelRestarting = true
  tunnelPending = true

  startReliableTunnel(port)
    .then((tunnel) => announceTunnel(tunnel))
    .catch((err) => {
      tunnelPending = false
      tunnelRestarting = false
      console.log(`  Tunnel reconnect failed (${err.message})`)
    })
}

async function start() {
  const app = express()
  app.set('trust proxy', true)

  app.use((_req, res, next) => {
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(self), gyroscope=(self), magnetometer=(self)',
    )
    next()
  })

  app.use((req, _res, next) => {
    if (req.headers.host?.includes('trycloudflare.com') || req.headers.host?.includes('loca.lt')) {
      req.headers['x-forwarded-host'] ??= req.headers.host
      req.headers['x-forwarded-proto'] ??= 'https'
    }
    next()
  })

  const httpServer = createServer(app)
  io = new Server(httpServer, {
    cors: { origin: true },
    transports: ['polling', 'websocket'],
  })

  const sessions = new Map()

  io.on('connection', (socket) => {
    socket.on('join', ({ sessionId, role }) => {
      if (!sessionId || !role) return

      socket.join(sessionId)
      socket.data.sessionId = sessionId
      socket.data.role = role

      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { host: null, controller: null })
      }
      const session = sessions.get(sessionId)

      if (role === 'host') {
        session.host = socket.id
        if (session.controller) {
          socket.emit('controller-connected')
        }
      }

      if (role === 'controller') {
        session.controller = socket.id
        if (session.host) {
          io.to(session.host).emit('controller-connected')
        }
      }
    })

    socket.on('motion', (data) => {
      const { sessionId, role } = socket.data
      if (sessionId && role === 'controller') {
        const session = sessions.get(sessionId)
        if (session?.host) {
          io.to(session.host).emit('motion', data)
        }
      }
    })

    socket.on('haptic', (data) => {
      const { sessionId, role } = socket.data
      if (sessionId && role === 'host') {
        const session = sessions.get(sessionId)
        if (session?.controller) {
          io.to(session.controller).emit('haptic', data)
        }
      }
    })

    socket.on('pause-game', () => {
      const { sessionId, role } = socket.data
      if (sessionId && role === 'controller') {
        const session = sessions.get(sessionId)
        if (session?.host) {
          io.to(session.host).emit('pause-game')
        }
      }
    })

    socket.on('disconnect-controller', () => {
      const { sessionId, role } = socket.data
      if (sessionId && role === 'host') {
        const session = sessions.get(sessionId)
        if (session?.controller) {
          io.to(session.controller).emit('disconnect-controller')
        }
      }
    })

    socket.on('disconnect', () => {
      const { sessionId, role } = socket.data
      if (!sessionId) return

      const session = sessions.get(sessionId)
      if (!session) return

      if (role === 'host' && session.host === socket.id) {
        session.host = null
      }
      if (role === 'controller' && session.controller === socket.id) {
        session.controller = null
        if (session.host) {
          io.to(session.host).emit('controller-disconnected')
        }
      }
    })
  })

  app.get('/api/network', (_req, res) => {
    res.json({
      ip: getLocalIp(),
      port: PORT,
      addresses: getNetworkAddresses(),
      tunnelUrl,
      tunnelPending,
    })
  })

  // Returns the crowd-sourced global motion profile
  app.get('/api/motion-profile', (_req, res) => {
    const global = computeGlobalProfile()
    res.json(global ?? { recommendedThreshold: null, dataPoints: 0, totalSwings: 0 })
  })

  // Receives a session's calibration data after gameplay
  app.use(express.json({ limit: '4kb' }))
  app.post('/api/motion-profile', (req, res) => {
    const { avgHitSpeed, threshold, hitCount } = req.body ?? {}

    // Validate - reject junk or low-confidence sessions
    if (
      typeof avgHitSpeed !== 'number' ||
      typeof threshold   !== 'number' ||
      typeof hitCount    !== 'number' ||
      hitCount < MIN_HITS_TO_SUBMIT   ||
      threshold < 30 || threshold > 200 ||
      avgHitSpeed < 50 || avgHitSpeed > 600
    ) {
      return res.status(400).json({ error: 'invalid or insufficient data' })
    }

    motionSessions.push({ avgHitSpeed, threshold, hitCount, submittedAt: Date.now() })

    // Keep rolling window
    if (motionSessions.length > MAX_SESSIONS) {
      motionSessions = motionSessions.slice(-MAX_SESSIONS)
    }

    saveAggregate()
    console.log(`  Motion profile updated - ${motionSessions.length} sessions, threshold ${threshold.toFixed(1)} deg/s from ${hitCount} hits`)
    res.json({ ok: true, dataPoints: motionSessions.length })
  })
const isProduction = process.env.NODE_ENV === 'production'

if (isProduction) {
  const distPath = path.resolve('./dist')

  app.use(express.static(distPath))

  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(path.join(distPath, 'index.html'))
    } else {
      next()
    }
  })
} else {
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: false,
      allowedHosts: true,
    },
    appType: 'spa',
  })

  app.use(vite.middlewares)
}

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use.`)
      console.error('  Close the other server (Ctrl+C) or run:')
      console.error(`    npx --yes kill-port ${PORT}\n`)
    } else {
      console.error(err)
    }
    process.exit(1)
  })

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Rhythm Crossing running:`)
    console.log(`  Local:   http://localhost:${PORT}`)
    console.log('  Tunnel:  starting public https link...')

    if (process.env.NODE_ENV === 'production') {
      console.log('  Production mode: no local tunnel needed.')
    } else {
      console.log('  Tunnel:  starting public https link...')
      startReliableTunnel(PORT)
        .then((tunnel) => announceTunnel(tunnel))
        .catch((err) => {
          tunnelPending = false
          console.log(`  Tunnel:  unavailable (${err.message})`)
          console.log('  Restart the dev server to try again.')
        })
    }

    console.log('')
  })

  process.on('SIGINT', () => {
    closeTunnel(tunnelProcess)
    process.exit()
  })
}

start()
