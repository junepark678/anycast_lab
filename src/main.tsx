import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let reloadForUpdate = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadForUpdate) return;
      reloadForUpdate = false;
      window.location.reload();
    });

    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    }).then((registration) => {
      // A worker discovered during a previous session can safely take over at
      // page-load time. Updates found while the lab is open wait, avoiding an
      // interruption while somebody is editing or running a topology.
      if (registration.waiting && navigator.serviceWorker.controller) {
        reloadForUpdate = true;
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      let lastUpdateCheck = Date.now();
      const checkForUpdate = () => {
        if (document.visibilityState !== 'visible' || !navigator.onLine) return;
        if (Date.now() - lastUpdateCheck < 60 * 60 * 1_000) return;
        lastUpdateCheck = Date.now();
        void registration.update().catch(() => {
          // Connectivity can disappear after the online check; the browser
          // will retry during a later visibility or navigation update check.
        });
      };

      document.addEventListener('visibilitychange', checkForUpdate);
      window.addEventListener('online', checkForUpdate);
    }).catch((error: unknown) => {
      console.warn('Anycast Lab could not enable offline mode', error);
    });
  }, { once: true });
}
