// Configuración de Vite.
//  - Desarrollo: http://localhost:5173 con proxy de /api, /comprobante y /marketing hacia el backend (puerto 3400).
//  - Producción: build optimizado en dist/ (lo sirve el backend). Se genera además sw.js con la lista de archivos del
//    build y una caché por versión, para que la aplicación se instale como PWA y se actualice sola.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BACKEND = process.env.PALMIRA_BACKEND_URL || 'http://localhost:3400';

// Vite rechaza peticiones cuyo Host no sea localhost. Se permiten los túneles rápidos de Cloudflare
// (*.trycloudflare.com) y, para túneles con dominio propio, los hosts de PALMIRA_ALLOWED_HOSTS="a.com,b.com".
const HOSTS_PERMITIDOS = ['.trycloudflare.com', ...(process.env.PALMIRA_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)];

function serviceWorker(): Plugin {
  let salida = 'dist';
  return {
    name: 'palmira-service-worker',
    apply: 'build',
    configResolved(c) { salida = c.build.outDir; },
    closeBundle() {
      const archivos: string[] = [];
      const recorrer = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) recorrer(p); else archivos.push(relative(salida, p).split(sep).join('/')); } };
      recorrer(salida);
      const fijos = ['index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo-palmira.webp', 'icons/isotipo.svg', 'icons/tino.svg', 'img/bodega-md.webp', 'vendor/zxing.min.js'];
      const precache = ['/', ...archivos.filter((f) => /^assets\/.+\.(js|css)$/.test(f) || fijos.includes(f)).map((f) => `/${f}`)];
      const version = createHash('sha256').update(archivos.join('|') + readFileSync(join(salida, 'index.html'))).digest('hex').slice(0, 10);
      const sw = readFileSync(new URL('./sw.plantilla.js', import.meta.url), 'utf8')
        .replace(/const CACHE = '[^']*';/, `const CACHE = 'palmira-${version}';`)
        .replace(/const ESTATICOS = \[[^\]]*\];/, `const ESTATICOS = ${JSON.stringify([...new Set(precache)])};`);
      writeFileSync(join(salida, 'sw.js'), sw);
      writeFileSync(join(salida, 'build.json'), JSON.stringify({ version, fecha: new Date().toISOString() }));
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: HOSTS_PERMITIDOS,
    // Con un túnel HTTPS la página vive en el puerto 443: PALMIRA_TUNNEL=1 hace que la recarga en vivo
    // (HMR) se conecte por wss://<dominio-del-túnel>:443 en lugar del puerto local.
    hmr: process.env.PALMIRA_TUNNEL ? { clientPort: 443 } : true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/comprobante': { target: BACKEND, changeOrigin: false },
      '/marketing': { target: BACKEND, changeOrigin: false },
    },
  },
  preview: { port: 4173, allowedHosts: HOSTS_PERMITIDOS },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});
