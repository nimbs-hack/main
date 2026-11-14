import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/700.css'
import '@fontsource-variable/jetbrains-mono'
// The map app's stylesheet is the base, tokens included. The planner's own
// file only adds what an editor needs on top: form fields, steps, the plan bar.
import '../../../src/styles.css'
import './styles.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
