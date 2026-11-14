import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/700.css'
import '@fontsource-variable/jetbrains-mono'
// styles.css is the console's base, tokens included. planner.css adds what the
// mission pages need on top: stage tabs, form rows, the plan bar.
import './styles.css'
import './planner.css'
import App from './App'
import { registerMapCache } from './cache/map-cache'

registerMapCache()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
