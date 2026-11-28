import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// PWA: регистрируем service worker — без него Chrome/Edge/Android
// не считают сайт устанавливаемым и не присылают beforeinstallprompt.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('Service worker не зарегистрирован', e);
    });
  });
}

// Перехватываем приглашение к установке как можно раньше: событие может
// прийти до монтирования React, тогда App терял бы его.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  (window as any).__deferredPrompt = e;
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
