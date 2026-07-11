import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/lab/',
  server: {
    // Buildroot expands hundreds of thousands of files beside the app. They
    // are runtime artifacts, never Vite inputs, and watching them can exhaust
    // the host's inotify limit while an appliance image is compiling.
    watch: { ignored: ['**/appliances/v86/.work/**', '**/appliances/v86/dist/**'] },
  },
  worker: { format: 'es' },
});
