import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Корневой элемент гарантированно существует (index.html содержит <div id="root">),
// но добавляем явный гард: без него приложение не может быть смонтировано.
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Корневой элемент #root не найден в DOM')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
