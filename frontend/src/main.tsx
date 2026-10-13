import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Корневой элемент гарантированно существует (index.html содержит <div id="root">),
// но добавляем явный гард: без него приложение не может быть смонтировано.
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Корневой элемент #root не найден в DOM')

// Ошибки рендера — в консоль с компонентным стеком (и пойманные границей ErrorBoundary,
// и долетевшие до корня): так они видны в журнале браузера на стенде, а не теряются.
createRoot(rootEl, {
  onUncaughtError: (error, info) => {
    console.error('[archmap] ошибка рендера без границы:', error, info.componentStack)
  },
  onCaughtError: (error, info) => {
    console.error('[archmap] ошибка рендера, поймана границей:', error, info.componentStack)
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
