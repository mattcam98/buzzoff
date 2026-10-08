import '@fontsource-variable/bricolage-grotesque/wdth.css';
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The content security policy forbids eval. Zod probes for it as each schema is built, which the browser
// logs as a violation, unless the config object it looks for at startup already says not to.
(globalThis as { __zod_globalConfig?: object }).__zod_globalConfig = { jitless: true };

// A page left open across a redeploy asks for chunks that no longer exist; a reload picks up the new build.
// Only once in a while, though: if the reload did not help, the error boundary takes over instead of a loop.
window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem('buzzoff.reloaded'));
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem('buzzoff.reloaded', String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
