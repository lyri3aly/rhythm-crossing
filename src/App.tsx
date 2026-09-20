import { useState } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { HostPage } from './pages/HostPage'
import { ControllerPage } from './pages/ControllerPage'
import { StatsPage } from './pages/StatsPage'
import { SettingsPage } from './pages/SettingsPage'
import { ChooseBlocksPage } from './pages/ChooseBlocksPage'
import { ChooseMapPage } from './pages/ChooseMapPage'
import Menu from './pages/Menu'

function AppRoutes() {
  const [selectedMap, setSelectedMap] = useState('beauty-and-a-beat')
  const navigate = useNavigate()

  return (
    <Routes>
      <Route path="/" element={
        <Menu
          selectedMap={selectedMap}
          onPlay={() => navigate('/game', { state: { map: selectedMap } })}
          onStats={() => navigate('/stats')}
          onSettings={() => navigate('/settings')}
          onChooseBlocks={() => navigate('/choose-blocks')}
          onChooseMap={() => navigate('/choose-map')}
        />
      } />
      <Route path="/game"           element={<HostPage onExit={() => navigate('/')} />} />
      <Route path="/controller/:sessionId" element={<ControllerPage />} />
      <Route path="/stats"          element={<StatsPage />} />
      <Route path="/settings"       element={<SettingsPage />} />
      <Route path="/choose-blocks"  element={<ChooseBlocksPage />} />
      <Route path="/choose-map"     element={<ChooseMapPage currentMap={selectedMap} onSelect={setSelectedMap} />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
