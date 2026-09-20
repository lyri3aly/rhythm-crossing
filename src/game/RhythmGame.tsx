import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import type { MotionData } from '../types/motion'
import {
  createSimpleSwingDetector,
  detectSwing,
  createGammaSmoother,
  createStabilityTracker,
  pushStability,
  makeCalibration,
  laneFromGamma,
  SWING_THRESHOLD,
  type LaneCalibration,
} from '../lib/sliceMotion'
import { saveRun } from '../lib/stats'
import { loadSettings } from '../lib/settings'
import type { GameSettings } from '../lib/settings'
import { GlbCube, FlatBlock } from './GlbBlocksLayer'
import './RhythmGame.css'

// --- Song catalogue -----------------------------------------------------------
const SONGS: Record<string, { beatmapUrl: string; audioUrl: string }> = {
  'beauty-and-a-beat': {
    beatmapUrl: '/songs/beauty-and-a-beat.json',
    audioUrl:   '/songs/beauty-and-a-beat.mp3',
  },
  'animals': {
    beatmapUrl: '/songs/animals.json',
    audioUrl:   '/songs/animals.mp3',
  },
}
const DEFAULT_MAP = 'beauty-and-a-beat'

// --- Tunable defaults (runtime-adjustable via settings sliders) ---------------
const LEAD_TIME_DEFAULT   = 2.6   // seconds a block is visible before its hit time
const HIT_WINDOW_DEFAULT  = 0.35  // +/- seconds that count as a hit
const PERFECT_WINDOW      = 0.09  // tighter perfect window
const BASE_POINTS         = 100

const SABER_LERP_SPEED = 0.15
const SWING_FLASH_MS   = 200
const HIT_DEFER_MS     = 0

// 3 lanes: 0 = LEFT, 1 = CENTER, 2 = RIGHT
const LANE_X     = [28, 50, 72]
const LANE_LABEL = ['LEFT', 'CENTER', 'RIGHT']

// Block depth path (true CSS 3D perspective, per lane).
const Z_SPAWN = -1400
const Z_HIT   =  120

interface BeatmapNote {
  time: number
  lane?: number
  direction?: string
}
interface Beatmap {
  song: string
  laneCount: number
  notes: BeatmapNote[]
}
interface ActiveNote {
  time: number
  lane: number
  id: number
  hit: boolean
  missed: boolean
  exploding: boolean
}

let noteIdCounter = 0

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

interface SaberState {
  tiltX: number
  tiltY: number
  speed: number
}

// --- Calibration screen -------------------------------------------------------
interface SaberOffset { tiltX: number; tiltY: number }

interface CalibrationProps {
  motionRef: React.RefObject<MotionData | null>
  onComplete: (cal: LaneCalibration, saberOffset: SaberOffset) => void
}

const LANE_STEPS = [
  { key: 'left',   label: 'LEFT lane',   instruction: 'Tilt your phone to the LEFT and hold still',  arrow: '⟵' },
  { key: 'center', label: 'CENTER lane', instruction: 'Hold your phone straight ahead (center)',      arrow: '•'  },
  { key: 'right',  label: 'RIGHT lane',  instruction: 'Tilt your phone to the RIGHT and hold still', arrow: '⟶' },
] as const

function CalibrationScreen({ motionRef, onComplete }: CalibrationProps) {
  // phase: 'saber' → center the laser, then 'lanes' → 3 lane steps, then 'done'
  const [phase, setPhase]       = useState<'saber' | 'lanes' | 'done'>('saber')
  const [laneStep, setLaneStep] = useState(0)
  const [progress, setProgress] = useState(0)
  const [noSignal, setNoSignal] = useState(true)

  const trackerRef    = useRef(createStabilityTracker())
  const capturedRef   = useRef<number[]>([])
  const calRef        = useRef<LaneCalibration | null>(null)
  const saberOffRef   = useRef<SaberOffset>({ tiltX: 0, tiltY: 0 })
  const doneRef       = useRef(false)

  // Saber centering: button-based — user taps when the phone is in their playing position
  const confirmSaberCenter = () => {
    const m = motionRef.current
    saberOffRef.current = { tiltX: m?.tiltX ?? 0, tiltY: m?.tiltY ?? 0 }
    trackerRef.current = createStabilityTracker()
    capturedRef.current = []
    setProgress(0)
    setPhase('lanes')
  }

  // Lane calibration: stability-based (same as before)
  useEffect(() => {
    if (phase !== 'lanes') return
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (doneRef.current) return

      const m = motionRef.current
      if (!m || m.gamma == null) { setNoSignal(true); return }
      setNoSignal(false)

      const now = m.timestamp || Date.now()
      const { angle, progress: p } = pushStability(trackerRef.current, m.gamma, now)
      setProgress(p)
      if (angle == null) return

      capturedRef.current = [...capturedRef.current, angle]
      trackerRef.current = createStabilityTracker()
      setProgress(0)

      if (capturedRef.current.length >= 3) {
        const [l, c, r] = capturedRef.current
        calRef.current = makeCalibration(l, c, r)
        doneRef.current = true
        setPhase('done')
      } else {
        setLaneStep(capturedRef.current.length)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase, motionRef])

  // Saber phase: just show signal status in realtime
  useEffect(() => {
    if (phase !== 'saber') return
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const m = motionRef.current
      setNoSignal(!m || m.gamma == null)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase, motionRef])

  const cur = LANE_STEPS[laneStep]

  return (
    <div className="rg-overlay">
      <div className="rg-grid-floor" />

      {phase === 'saber' && (
        <>
          <p className="rg-cal-step">Step 1 of 4 — Laser center</p>
          <div className="rg-cal-arrow">⊕</div>
          <h2 className="rg-cal-instruction">Hold your phone how you'll hold it while playing, then tap Set Center</h2>
          <button
            className="rg-start-btn"
            disabled={noSignal}
            onClick={confirmSaberCenter}
          >
            {noSignal ? 'waiting for phone…' : 'Set Center'}
          </button>
          <p className="rg-hint">This fixes the laser if it drifts left or right</p>
        </>
      )}

      {phase === 'lanes' && (
        <>
          <p className="rg-cal-step">Step {laneStep + 2} of 4 — {cur.label}</p>
          <div className="rg-cal-arrow">{cur.arrow}</div>
          <h2 className="rg-cal-instruction">{cur.instruction}</h2>
          <div className="rg-cal-bar">
            <div className="rg-cal-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="rg-hint">
            {noSignal ? 'waiting for phone motion…' : 'hold steady to lock it in'}
          </p>
        </>
      )}

      {phase === 'done' && (
        <>
          <h2 className="rg-title">Calibration done!</h2>
          <p className="rg-sub">You're ready. Tilt to move between lanes, swing to hit.</p>
          <button
            className="rg-start-btn"
            onClick={() => calRef.current && onComplete(calRef.current, saberOffRef.current)}
          >
            {'> Start Game'}
          </button>
        </>
      )}
    </div>
  )
}

// --- Main game component ------------------------------------------------------
interface Props {
  socketRef: React.RefObject<Socket | null>
  connected: boolean
  mapKey?: string
}

export function RhythmGame({ socketRef, connected, mapKey = DEFAULT_MAP }: Props) {
  const navigate = useNavigate()
  const [phase, setPhase]             = useState<'idle' | 'calibrating' | 'playing' | 'done'>('idle')
  const [beatmap, setBeatmap]         = useState<Beatmap | null>(null)
  const [activeNotes, setActiveNotes] = useState<ActiveNote[]>([])
  const [score, setScore]             = useState(0)
  const [combo, setCombo]             = useState(0)
  const [hits, setHits]               = useState(0)
  const [misses, setMisses]           = useState(0)
  const [multiplier, setMultiplier]   = useState(1)
  const [feedback, setFeedback]       = useState<{ text: string; ok: boolean } | null>(null)
  const [currentLane, setCurrentLane] = useState(1)

  // Settings — refs so changes take effect immediately every frame
  const [leadTime, setLeadTime]     = useState(LEAD_TIME_DEFAULT)
  const [hitWindow, setHitWindow]   = useState(HIT_WINDOW_DEFAULT)
  const leadTimeRef  = useRef(LEAD_TIME_DEFAULT)
  const hitWindowRef = useRef(HIT_WINDOW_DEFAULT)

  // Pause state
  const [paused, setPaused]         = useState(false)
  const [pausePanel, setPausePanel] = useState<'menu' | 'settings'>('menu')
  const pausedRef     = useRef(false)
  const pausePanelRef = useRef<'menu' | 'settings'>('menu')

  const [blockStyle, setBlockStyle] = useState<GameSettings['chosenBlock']>(() => loadSettings().chosenBlock)
  const [blockMode,  setBlockMode]  = useState<GameSettings['blockMode']>(() => loadSettings().blockMode)

  const audioRef          = useRef<HTMLAudioElement | null>(null)
  const nextNoteIndexRef  = useRef(0)
  const rafRef            = useRef<number>(0)
  const gameStartRef      = useRef<number>(0)
  const swingDetectorRef  = useRef(createSimpleSwingDetector())
  const swingSensRef      = useRef(loadSettings().swingSensitivity)
  const gammaSmootherRef  = useRef(createGammaSmoother())
  const comboRef          = useRef(0)
  const multRef           = useRef(1)
  const activeNotesRef    = useRef<ActiveNote[]>([])
  const calibrationRef    = useRef<LaneCalibration | null>(null)
  const currentLaneRef    = useRef(1)
  const phaseRef          = useRef(phase)
  const audioTimeRef      = useRef(0)

  const latestMotionRef    = useRef<MotionData | null>(null)
  const saberOffsetRef     = useRef<{ tiltX: number; tiltY: number }>({ tiltX: 0, tiltY: 0 })
  const saberStateRef      = useRef<SaberState>({ tiltX: 0, tiltY: 0, speed: 0 })
  const swingFlashUntilRef = useRef(0)
  const saberAnchorRef     = useRef<HTMLDivElement | null>(null)
  const saberRigRef        = useRef<HTMLDivElement | null>(null)
  const saberCoreRef       = useRef<HTMLDivElement | null>(null)
  const blockRefs          = useRef<Map<number, HTMLDivElement>>(new Map())

  // Keep refs in sync with state (read by event handlers / RAF without re-subscribing)
  comboRef.current      = combo
  multRef.current       = multiplier
  activeNotesRef.current = activeNotes
  phaseRef.current      = phase
  pausedRef.current     = paused
  pausePanelRef.current = pausePanel

  // Stop audio when the component unmounts (e.g. controller disconnects mid-game)
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    const { beatmapUrl } = SONGS[mapKey] ?? SONGS[DEFAULT_MAP]
    fetch(beatmapUrl)
      .then((r) => r.json())
      .then((data: Beatmap) => setBeatmap(data))
      .catch(() => console.error(`Could not load ${beatmapUrl}`))
  }, [mapKey])

  const showFeedback = useCallback((text: string, ok: boolean) => {
    setFeedback({ text, ok })
    setTimeout(() => setFeedback(null), 600)
  }, [])

  // -- Hit decision: runs IMMEDIATELY on swing ----------------------------------
  const processSwing = useCallback(() => {
    const audio = audioRef.current
    if (!audio || phaseRef.current !== 'playing') return

    swingFlashUntilRef.current = performance.now() + SWING_FLASH_MS

    const now = audio.currentTime
    const playerLane = currentLaneRef.current

    let bestIdx = -1
    let bestDist = Infinity
    const notes = activeNotesRef.current
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (n.hit || n.missed) continue
      if (n.lane !== playerLane) continue
      const dist = Math.abs(n.time - now)
      if (dist <= hitWindowRef.current && dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }

    if (bestIdx === -1) {
      setCombo(0); setMisses((m) => m + 1); setMultiplier(1)
      showFeedback('Miss', false)
      return
    }

    const perfect = bestDist <= PERFECT_WINDOW
    const newCombo = comboRef.current + 1
    const newMult  = newCombo >= 8 ? 4 : newCombo >= 4 ? 2 : 1
    comboRef.current = newCombo
    multRef.current = newMult
    const hitId = notes[bestIdx].id
    notes[bestIdx].hit = true

    setCombo(newCombo); setMultiplier(newMult)
    setScore((s) => s + BASE_POINTS * newMult)
    setHits((h) => h + 1)

    // Haptic feedback to controller
    try {
      socketRef.current?.emit('haptic', { type: perfect ? 'perfect' : 'hit' })
    } catch {}

    setTimeout(() => {
      showFeedback(perfect ? 'Perfect!' : 'Hit!', true)
      setActiveNotes((cur) =>
        cur.map((n) => (n.id === hitId ? { ...n, hit: true, exploding: true } : n)),
      )
      setTimeout(() => setActiveNotes((cur) => cur.filter((n) => n.id !== hitId)), 350)
    }, HIT_DEFER_MS)
  }, [showFeedback, socketRef])

  // -- Socket motion: store + immediate swing detection ------------------------
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return

    const onMotion = (data: MotionData) => {
      latestMotionRef.current = data
      if (phaseRef.current !== 'playing' || pausedRef.current) return
      const { swing } = detectSwing(data, swingDetectorRef.current, SWING_THRESHOLD / swingSensRef.current)
      if (swing) processSwing()
    }

    const onPause = () => {
      if (phaseRef.current !== 'playing') return
      if (pausedRef.current) {
        // resume
        audioRef.current?.play()
        setPaused(false)
      } else {
        audioRef.current?.pause()
        setPaused(true)
        setPausePanel('menu')
      }
    }

    socket.on('motion', onMotion)
    socket.on('pause-game', onPause)
    return () => {
      socket.off('motion', onMotion)
      socket.off('pause-game', onPause)
    }
  }, [socketRef, connected, processSwing])

  // -- Settings updaters -------------------------------------------------------
  const updateLeadTime = useCallback((val: number) => {
    leadTimeRef.current = val
    setLeadTime(val)
  }, [])

  const updateHitWindow = useCallback((val: number) => {
    hitWindowRef.current = val
    setHitWindow(val)
  }, [])

  // -- Pause / resume ----------------------------------------------------------
  const resumeGame = useCallback(() => {
    setPaused(false)
    audioRef.current?.play()
  }, [])

  const handleMenu = useCallback(() => {
    const acc = hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0
    try {
      localStorage.setItem('lastRunStats', JSON.stringify({ score, combo, hits, misses, accuracy: acc }))
      if (hits + misses > 0) {
        saveRun({ score, accuracy: acc, hits, misses, durationMs: Date.now() - gameStartRef.current, timestamp: Date.now() })
      }
    } catch {}
    cancelAnimationFrame(rafRef.current)
    audioRef.current?.pause()
    if (audioRef.current) audioRef.current.currentTime = 0
    saberOffsetRef.current = { tiltX: 0, tiltY: 0 }
    setPaused(false)
    setPhase('idle')
    setActiveNotes([])
    setScore(0); setCombo(0); setHits(0); setMisses(0); setMultiplier(1)
    nextNoteIndexRef.current = 0
  }, [score, combo, hits, misses])

  const handleExit = useCallback(() => {
    try { window.close() } catch {}
    // Fallback if browser blocks window.close()
    handleMenu()
  }, [handleMenu])

  // -- Keyboard: 1/2/3 lanes, space swings, ESC pauses -------------------------
  useEffect(() => {
    if (phase !== 'playing') return
    const setLane = (lane: number) => {
      currentLaneRef.current = lane
      setCurrentLane(lane)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!pausedRef.current) {
          // Pause the game
          audioRef.current?.pause()
          setPaused(true)
          setPausePanel('menu')
        } else if (pausePanelRef.current === 'settings') {
          // ESC from settings → back to menu options
          setPausePanel('menu')
        } else {
          // ESC from menu → resume
          resumeGame()
        }
        return
      }
      if (pausedRef.current) return // block all other keys while paused
      if (e.key === '1' || e.key === 'a' || e.key === 'A') { e.preventDefault(); setLane(0) }
      else if (e.key === '2' || e.key === 's' || e.key === 'S') { e.preventDefault(); setLane(1) }
      else if (e.key === '3' || e.key === 'd' || e.key === 'D') { e.preventDefault(); setLane(2) }
      else if ([' ', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        e.preventDefault(); processSwing()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); setLane(Math.max(0, currentLaneRef.current - 1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault(); setLane(Math.min(2, currentLaneRef.current + 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, processSwing, resumeGame])

  // -- Block depth: calc from audio time + leadTime ----------------------------
  const blockZ = (note: ActiveNote, at: number) => {
    const lt = leadTimeRef.current
    const progress = Math.min((at - (note.time - lt)) / lt, 1)
    return Z_SPAWN + progress * (Z_HIT - Z_SPAWN)
  }

  // -- Game loop: pauses when `paused` is true (effect re-runs on change) ------
  useEffect(() => {
    if (phase !== 'playing' || !beatmap || paused) return
    const audio = audioRef.current
    if (!audio) return

    const tick = () => {
      const now = audio.currentTime
      audioTimeRef.current = now

      // Spawn notes
      const notes = beatmap.notes
      while (
        nextNoteIndexRef.current < notes.length &&
        notes[nextNoteIndexRef.current].time - leadTimeRef.current <= now
      ) {
        const note = notes[nextNoteIndexRef.current]
        const lane = note.lane == null ? 1 : Math.max(0, Math.min(2, note.lane))
        setActiveNotes((prev) => [
          ...prev,
          { time: note.time, lane, id: ++noteIdCounter, hit: false, missed: false, exploding: false },
        ])
        nextNoteIndexRef.current++
      }

      // Expire missed notes
      let anyMissed = false
      for (const n of activeNotesRef.current) {
        if (!n.hit && !n.missed && now > n.time + hitWindowRef.current) { anyMissed = true; break }
      }
      if (anyMissed) {
        setActiveNotes((prev) => {
          const updated = prev.map((n) =>
            !n.hit && !n.missed && now > n.time + hitWindowRef.current ? { ...n, missed: true } : n,
          )
          return updated
        })
        setCombo(0); setMultiplier(1); setMisses((m) => m + 1)
        showFeedback('Miss', false)
        setTimeout(() => setActiveNotes((cur) => cur.filter((n) => !n.missed)), 300)
      }

      // Lane detection from latest motion
      const m = latestMotionRef.current
      const cal = calibrationRef.current
      if (m && cal && m.gamma != null) {
        const smoothed = gammaSmootherRef.current.push(m.gamma)
        const lane = laneFromGamma(smoothed, cal)
        if (lane !== currentLaneRef.current) {
          currentLaneRef.current = lane
          setCurrentLane(lane)
        }
      }

      // Move blocks imperatively
      const at = audioTimeRef.current
      for (const n of activeNotesRef.current) {
        if (n.hit || n.exploding || n.missed) continue
        const el = blockRefs.current.get(n.id)
        if (el) el.style.transform = `translate(-50%, -50%) translateZ(${blockZ(n, at)}px)`
      }

      updateSaber()

      if (
        audio.ended ||
        (nextNoteIndexRef.current >= notes.length &&
          activeNotesRef.current.length === 0 &&
          now > (notes[notes.length - 1]?.time ?? 0) + 2)
      ) {
        setPhase('done')
        return
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, beatmap, paused, showFeedback])

  // -- Saber renderer ----------------------------------------------------------
  const updateSaber = () => {
    const anchor = saberAnchorRef.current
    const rig = saberRigRef.current
    const core = saberCoreRef.current
    if (!anchor || !rig || !core) return

    const s = saberStateRef.current
    const m = latestMotionRef.current

    const off = saberOffsetRef.current
    const targetTiltX = (m?.tiltX ?? s.tiltX) - off.tiltX
    const targetTiltY = (m?.tiltY ?? s.tiltY) - off.tiltY
    const targetSpeed = m?.swingSpeed ?? 0
    s.tiltX += (targetTiltX - s.tiltX) * SABER_LERP_SPEED
    s.tiltY += (targetTiltY - s.tiltY) * SABER_LERP_SPEED
    s.speed += (targetSpeed - s.speed) * SABER_LERP_SPEED

    const swinging = performance.now() < swingFlashUntilRef.current

    const screenLeft = clamp(50 + s.tiltX * 0.5, 14, 86)
    const screenTop  = clamp(70 - s.tiltY * 0.45, 30, 78)

    const rotZ = clamp(s.tiltX, -75, 75)
    const glow = 24 + Math.min(s.speed * 8, 50) + (swinging ? 30 : 0)

    anchor.style.left = `${screenLeft}%`
    anchor.style.top = `${screenTop}%`
    rig.style.transform = `rotateZ(${rotZ}deg)`
    core.style.boxShadow = `0 0 ${glow}px #f5d060`
    rig.classList.toggle('rg-saber-rig--swinging', swinging)
  }

  // -- Flow: Idle -> Calibration -> Game ---------------------------------------
  const goToCalibration = useCallback(() => {
    setPhase('calibrating')
  }, [])

  const startGame = useCallback(async (cal?: LaneCalibration, saberOffset?: { tiltX: number; tiltY: number }) => {
    if (!beatmap) return
    if (cal) calibrationRef.current = cal
    if (saberOffset) saberOffsetRef.current = saberOffset
    const { audioUrl } = SONGS[mapKey] ?? SONGS[DEFAULT_MAP]
    const audio = new Audio(audioUrl)
    audioRef.current = audio
    nextNoteIndexRef.current = 0
    gammaSmootherRef.current.reset()
    swingDetectorRef.current = createSimpleSwingDetector()
    currentLaneRef.current = 1
    setCurrentLane(1)
    setActiveNotes([]); setScore(0); setCombo(0)
    setHits(0); setMisses(0); setMultiplier(1)
    setPaused(false)
    audioTimeRef.current = 0
    gameStartRef.current = Date.now()
    const s = loadSettings()
    swingSensRef.current = s.swingSensitivity
    setBlockStyle(s.chosenBlock)
    setBlockMode(s.blockMode)
    setPhase('playing')
    await audio.play()
  }, [beatmap])

  // -- Block container (GLB cube inside; transform set imperatively) ------------
  const getBlockStyle = (note: ActiveNote): React.CSSProperties => ({
    position: 'absolute',
    left: `${LANE_X[note.lane]}%`,
    top: '72%',
    transform: `translate(-50%, -50%) translateZ(${blockZ(note, audioTimeRef.current)}px)`,
    width: '88px',
    height: '88px',
    opacity: note.missed ? 0 : 1,
  })

  const accuracy = hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0

  return (
    <div className="rg-root">
      {/* -- HUD -- */}
      {phase === 'playing' && (
        <div className="rg-hud">
          <div className="rg-stat">
            <span className="rg-stat-label">Score</span>
            <span className="rg-stat-val">{score.toLocaleString()}</span>
          </div>
          <div className="rg-stat">
            <span className="rg-stat-label">Combo</span>
            <span className="rg-stat-val rg-combo">{combo}x</span>
          </div>
          <div className="rg-stat">
            <span className="rg-stat-label">Mult</span>
            <span className={`rg-stat-val rg-mult-${multiplier}`}>x{multiplier}</span>
          </div>
          <div className="rg-stat">
            <span className="rg-stat-label">Lane</span>
            <span className="rg-stat-val rg-combo">{LANE_LABEL[currentLane]}</span>
          </div>
          <div className="rg-stat">
            <span className="rg-stat-label">Acc</span>
            <span className="rg-stat-val">{accuracy}%</span>
          </div>
        </div>
      )}

      {/* -- Feedback -- */}
      {feedback && (
        <div className={`rg-feedback ${feedback.ok ? 'rg-feedback--hit' : 'rg-feedback--miss'}`}>
          {feedback.text}
        </div>
      )}

      {/* -- Pause menu -- */}
      {phase === 'playing' && paused && (
        <div className="rg-pause-overlay">
          <div className="rg-pause-popup">
            {pausePanel === 'menu' ? (
              <>
                <p className="rg-pause-title">paused</p>
                <button className="rg-pause-btn" onClick={resumeGame}>Resume</button>
                <button className="rg-pause-btn" onClick={() => setPausePanel('settings')}>Settings</button>
                <button className="rg-pause-btn" onClick={handleMenu}>Menu</button>
                <button className="rg-pause-btn rg-pause-btn--danger" onClick={handleExit}>Exit</button>
              </>
            ) : (
              <>
                <button className="rg-pause-back" onClick={() => setPausePanel('menu')}>
                  ← back
                </button>
                <p className="rg-pause-title">settings</p>

                <div className="rg-slider-group">
                  <div className="rg-slider-row">
                    <span className="rg-slider-label">Block Speed</span>
                    <span className="rg-slider-val">{leadTime.toFixed(1)}s</span>
                  </div>
                  <div className="rg-slider-hints">
                    <span>Fast</span><span>Slow</span>
                  </div>
                  <input
                    type="range"
                    className="rg-slider"
                    min={1.5}
                    max={3.5}
                    step={0.1}
                    value={leadTime}
                    onChange={(e) => updateLeadTime(Number(e.target.value))}
                  />
                </div>

                <div className="rg-slider-group">
                  <div className="rg-slider-row">
                    <span className="rg-slider-label">Hit Window</span>
                    <span className="rg-slider-val">{hitWindow.toFixed(2)}s</span>
                  </div>
                  <div className="rg-slider-hints">
                    <span>Strict</span><span>Forgiving</span>
                  </div>
                  <input
                    type="range"
                    className="rg-slider"
                    min={0.15}
                    max={0.55}
                    step={0.05}
                    value={hitWindow}
                    onChange={(e) => updateHitWindow(Number(e.target.value))}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* -- Idle screen -- */}
      {phase === 'idle' && (
        <div className="rg-overlay">
          <div className="rg-grid-floor" />
          <h2 className="rg-title">Rhythm Crossing</h2>
          <p className="rg-sub">
            {beatmap ? `${beatmap.notes.length} notes - ${beatmap.song}` : 'loading beatmap...'}
          </p>
          <p className="rg-hint">tilt your phone to switch lanes, swing to hit</p>
          <button className="rg-start-btn" onClick={goToCalibration} disabled={!beatmap}>
            {'> play'}
          </button>
          <button className="rg-start-btn rg-start-btn--secondary" onClick={() => navigate('/')}>
            {'<- back to menu'}
          </button>
        </div>
      )}

      {/* -- Calibration screen -- */}
      {phase === 'calibrating' && (
        <CalibrationScreen motionRef={latestMotionRef} onComplete={(cal, off) => startGame(cal, off)} />
      )}

      {/* -- Done screen -- */}
      {phase === 'done' && (
        <div className="rg-overlay">
          <h2 className="rg-title">Complete!</h2>
          <div className="rg-results">
            <div><span>Score</span>     <strong>{score.toLocaleString()}</strong></div>
            <div><span>Accuracy</span>  <strong>{accuracy}%</strong></div>
            <div><span>Hits</span>      <strong>{hits}</strong></div>
            <div><span>Misses</span>    <strong>{misses}</strong></div>
          </div>
          <button className="rg-start-btn" onClick={() => startGame()}>Play Again</button>
          <button className="rg-start-btn rg-start-btn--secondary" onClick={handleMenu}>Return to Home</button>
        </div>
      )}

      {/* -- Arena -- */}
      {phase === 'playing' && (
        <div className="rg-arena">
          <div className="rg-grid-floor" />

          {LANE_X.map((x, i) => (
            <div
              key={i}
              className={`rg-lane-col ${currentLane === i ? 'rg-lane-col--active' : ''}`}
              style={{ left: `${x}%` }}
            />
          ))}

          <div className="rg-hit-zone" />

          {activeNotes.map((note) => (
            <div
              key={note.id}
              ref={(el) => {
                if (el) blockRefs.current.set(note.id, el)
                else blockRefs.current.delete(note.id)
              }}
              className={`rg-block ${note.exploding ? 'rg-block--explode' : ''} ${note.missed ? 'rg-block--missed' : ''}`}
              style={getBlockStyle(note)}
            >
              {blockMode === '3d'
                ? <GlbCube blockStyle={blockStyle} />
                : <FlatBlock blockStyle={blockStyle} />
              }
            </div>
          ))}

          <div className="rg-saber-anchor" ref={saberAnchorRef}>
            <div className="rg-saber-rig" ref={saberRigRef}>
              <div className="rg-saber-blade">
                <div className="rg-blade-core" ref={saberCoreRef} />
                <div className="rg-blade-glow" />
              </div>
              <div className="rg-saber-guard" />
              <div className="rg-saber-handle" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
