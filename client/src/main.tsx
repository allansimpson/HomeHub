import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import './components/ledger.css'
import { App } from './app/App'
import { SessionProvider } from './app/SessionProvider'
import { SensorsProvider } from './app/SensorsProvider'
import { WeatherProvider } from './app/WeatherProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <SensorsProvider>
          <WeatherProvider>
            <App />
          </WeatherProvider>
        </SensorsProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
