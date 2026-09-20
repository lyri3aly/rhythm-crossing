import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { useSocket } from '../hooks/useSocket'
import { createSessionId } from '../lib/session'
import type { NetworkInfo } from '../types/motion'
import { RhythmGame } from '../game/RhythmGame'
import './HostPage.css'

interface HostPageProps {
  onExit?: () => void
}

export function HostPage({ onExit }: HostPageProps) {
  const location = useLocation()
  const mapKey = (location.state as { map?: string } | null)?.map ?? 'beauty-and-a-beat'

  const [sessionId] = useState(createSessionId)
  const [network, setNetwork] = useState<NetworkInfo | null>(null)
  const [selectedIp, setSelectedIp] = useState('')
  const [copied, setCopied] = useState(false)
  const [controllerConnected, setControllerConnected] = useState(false)
  const { socketRef, connected: socketConnected } = useSocket(sessionId, 'host')

  const usableAddresses = useMemo(
    () => network?.addresses?.filter((a) => !a.virtual) ?? [],
    [network],
  )

  useEffect(() => {
    const root = document.documentElement
    if (controllerConnected) {
      root.classList.add('sabersync-playing')
      document.body.classList.add('sabersync-playing')
    } else {
      root.classList.remove('sabersync-playing')
      document.body.classList.remove('sabersync-playing')
    }
    return () => {
      root.classList.remove('sabersync-playing')
      document.body.classList.remove('sabersync-playing')
    }
  }, [controllerConnected])

  useEffect(() => {
    let interval: number | undefined

    const refreshNetwork = () =>
      fetch('/api/network')
        .then((r) => r.json())
        .then((data: NetworkInfo) => {
          setNetwork(data)
          setSelectedIp((current) => {
            const stillValid = data.addresses?.some((a) => a.ip === current && !a.virtual)
            return stillValid ? current : data.ip
          })
          if (data.tunnelUrl && interval) {
            window.clearInterval(interval)
            interval = undefined
          } else if (!data.tunnelUrl && data.tunnelPending && !interval) {
            interval = window.setInterval(refreshNetwork, 1000)
          }
        })
        .catch(() => {
          setNetwork((current) =>
            current ?? { ip: window.location.hostname, port: 5173, tunnelPending: true },
          )
          setSelectedIp((current) => current || window.location.hostname)
        })

    refreshNetwork()
    interval = window.setInterval(refreshNetwork, 1000)

    return () => {
      if (interval) window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket || !socketConnected) return

    const onConnected = () => setControllerConnected(true)
    const onDisconnected = () => {
      setControllerConnected(false)
    }
    const onTunnelReady = ({ tunnelUrl: url }: { tunnelUrl: string }) => {
      setNetwork((current) =>
        current ? { ...current, tunnelUrl: url, tunnelPending: false } : current,
      )
    }
    const onTunnelLost = () => {
      setNetwork((current) =>
        current ? { ...current, tunnelUrl: null, tunnelPending: true } : current,
      )
    }

    socket.on('controller-connected', onConnected)
    socket.on('controller-disconnected', onDisconnected)
    socket.on('tunnel-ready', onTunnelReady)
    socket.on('tunnel-lost', onTunnelLost)

    return () => {
      socket.off('controller-connected', onConnected)
      socket.off('controller-disconnected', onDisconnected)
      socket.off('tunnel-ready', onTunnelReady)
      socket.off('tunnel-lost', onTunnelLost)
    }
  }, [socketRef, socketConnected, sessionId])

  const localUrl = network && selectedIp && sessionId
    ? `http://${selectedIp}:${network.port}/controller/${sessionId}`
    : ''

  const qrUrl =
    sessionId
      ? import.meta.env.PROD
        ? `${window.location.origin}/controller/${sessionId}`
        : network?.tunnelUrl
          ? `${network.tunnelUrl}/controller/${sessionId}`
          : ''
      : ''

  const copyUrl = async () => {
    if (!qrUrl) return
    await navigator.clipboard.writeText(qrUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`host-page ${controllerConnected ? 'host-page--playing' : ''}`}>
      {controllerConnected && (
        <div className="playing-hud">
          <div className="status-pill online">
            <span className="status-dot" />
            phone connected
          </div>
          <button
            type="button"
            className="disconnect-btn"
            onClick={() => {
              socketRef.current?.emit('disconnect-controller')
              setControllerConnected(false)
            }}
          >
            Disconnect phone
          </button>
        </div>
      )}

      {!controllerConnected && (
        <div className="connect-screen">
          {onExit && (
            <button type="button" className="back-btn" onClick={onExit}>
              {'<- back'}
            </button>
          )}

          <h1 className="connect-title">scan to play</h1>
          <p className="connect-sub">open on your phone to use it as the controller</p>

          <div className="qr-card">
            {qrUrl ? (
              <QRCodeSVG value={qrUrl} size={200} level="M" includeMargin />
            ) : (
              <div className="qr-placeholder">
                {network ? 'getting link...' : 'loading...'}
              </div>
            )}
          </div>

          <p className="session-label">session</p>
          <p className="session-id">{sessionId}</p>

          {qrUrl ? (
            <div className="url-row">
              <code className="controller-link">{qrUrl}</code>
              <button type="button" className="copy-btn" onClick={copyUrl}>
                {copied ? 'copied!' : 'copy'}
              </button>
            </div>
          ) : (
            <p className="network-note warn">
              {network?.tunnelPending
                ? 'tunnel expired - fetching new link...'
                : 'starting link... takes ~10 seconds'}
            </p>
          )}

          {localUrl && !qrUrl && (
            <p className="local-url-note">
              same wifi only: <code>{localUrl}</code>
            </p>
          )}

          {usableAddresses.length > 1 && !qrUrl && (
            <label className="ip-picker">
              <span>network ip</span>
              <select value={selectedIp} onChange={(e) => setSelectedIp(e.target.value)}>
                {usableAddresses.map((a) => (
                  <option key={a.ip} value={a.ip}>
                    {a.ip} ({a.name})
                  </option>
                ))}
              </select>
            </label>
          )}

          <ul className="tips">
            <li>don't refresh this page - it'll reset the session</li>
            <li>on your phone, tap <strong>allow motion</strong> when it pops up</li>
            <li>swing your phone to move the saber!</li>
          </ul>
        </div>
      )}

      {controllerConnected && (
        <main className="arena">
          <RhythmGame socketRef={socketRef} connected={socketConnected} mapKey={mapKey} />
        </main>
      )}
    </div>
  )
}
