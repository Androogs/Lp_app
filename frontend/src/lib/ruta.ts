// Navegación por hash (#/seccion/sub?clave=valor). Se conserva el formato de direcciones de la versión anterior, así los
// enlaces guardados, los accesos del manifiesto (PWA) y los botones del asistente siguen funcionando.
import { useSyncExternalStore } from 'react';
import type { Ruta } from './tipos';

export function leerRuta(hash: string = location.hash || '#/inicio'): Ruta {
  const limpio = hash.replace(/^#\/?/, '');
  const [camino, consulta = ''] = limpio.split('?');
  const partes = camino.split('/').filter(Boolean);
  return { seccion: partes[0] || 'inicio', partes, query: Object.fromEntries(new URLSearchParams(consulta)), hash: hash || '#/inicio' };
}

const suscribir = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
const instantanea = () => location.hash || '#/inicio';

export function useRuta(): Ruta {
  const hash = useSyncExternalStore(suscribir, instantanea, instantanea);
  return leerRuta(hash);
}
