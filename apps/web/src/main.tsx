import '@fontsource-variable/bricolage-grotesque/wdth.css';
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
