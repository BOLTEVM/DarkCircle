import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyVerifiedLocalDeployments } from 'quai-service/bootstrap'
import { AppErrorBoundary, CrashScreen } from './CrashScreen'
import './index.css'
import './mobile.css'

const container = document.getElementById('root')!

// A blank page tells nobody anything, least of all on a phone with no console. Whatever goes wrong while the app starts
// is shown on screen, with enough detail to report, and a failed lazy chunk after a fresh deploy gets one automatic reload.
function showCrash(error: unknown, where: string) {
  const e = error instanceof Error ? error : new Error(String(error))
  ReactDOM.createRoot(container).render(
    <CrashScreen error={{ message: e.message || String(error), stack: e.stack ?? '', where }} title="Circleswap could not start" />,
  )
}

const isStaleChunk = (e: unknown) =>
  /dynamically imported module|Importing a module script failed|Loading chunk|Unable to preload/i.test(String((e as any)?.message ?? e))

// Contract addresses decide where swaps, stakes and deposits are sent, so anything remembered from a deployment
// made in this browser is checked against the chain BEFORE the app (and the registries that read those
// addresses at load) is imported. A failed check only drops that address; it never blocks the app.
async function start() {
  try {
    await applyVerifiedLocalDeployments()
  } catch {
    /* an unreachable node must not stop the app from starting */
  }
  let App: React.ComponentType
  try {
    App = (await import('./App.tsx')).default
  } catch (e) {
    // The entry file is cached but the chunk it names was replaced by a newer deploy: reload once to pick up the new entry.
    let reloaded = false
    try {
      reloaded = sessionStorage.getItem('circleswap.chunk-reload') === '1'
      if (isStaleChunk(e) && !reloaded) {
        sessionStorage.setItem('circleswap.chunk-reload', '1')
        location.reload()
        return
      }
    } catch {
      /* storage blocked: show the error instead of looping */
    }
    showCrash(e, 'Startup error')
    return
  }
  try {
    sessionStorage.removeItem('circleswap.chunk-reload')
  } catch {
    /* nothing to clear */
  }
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  )
}

start().catch(e => showCrash(e, 'Startup error'))
