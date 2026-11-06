// Punto de entrada del frontend (React + TypeScript, servido por Vite).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/jost';
import '@fontsource-variable/dm-sans';
import './styles/app.css';
import './styles/marketing.css';
import './styles/asistente.css';
import './styles/inicio.css';

createRoot(document.getElementById('raiz')!).render(<StrictMode><App /></StrictMode>);

// PWA: el service worker solo se registra en producción (en desarrollo Vite recarga los cambios al instante).
if (import.meta.env.PROD && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* sin PWA */ }); });
}
