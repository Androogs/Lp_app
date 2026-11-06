// Estado global de la sesión (usuario, configuración, caja) y navegación por hash.
// Lo comparten los componentes React y las pantallas heredadas. React se entera de los cambios con suscribirSesion().
import type { CajaSesion, ConfigPublica, Usuario } from './tipos';

interface Estado {
  usuario: Usuario | null;
  config: ConfigPublica;
  caja: CajaSesion | null;
  tiene(permiso: string): boolean;
  tieneAlguno(...permisos: string[]): boolean;
}

export const estado: Estado = {
  usuario: null,
  config: {},
  caja: null,
  tiene(permiso: string) {
    const p = this.usuario && this.usuario.permisos;
    if (!p) return false;
    return p.includes('*') || p.includes(permiso);
  },
  tieneAlguno(...permisos: string[]) { return permisos.some((p) => this.tiene(p)); },
};

export function navegar(hash: string, reemplazar = false): void {
  if (!hash.startsWith('#')) hash = '#' + hash;
  if (reemplazar) location.replace(hash); else location.hash = hash;
}
export function volver(fallback = '#/inicio'): void {
  if (history.length > 1 && document.referrer !== '') history.back();
  else navegar(fallback);
}

type Oyente = (datos?: unknown) => void;
const oyentes = new Map<string, Oyente[]>();
export function emitir(evento: string, datos?: unknown): void { (oyentes.get(evento) || []).forEach((fn) => fn(datos)); }
export function escuchar(evento: string, fn: Oyente): () => void {
  if (!oyentes.has(evento)) oyentes.set(evento, []);
  oyentes.get(evento)!.push(fn);
  return () => oyentes.set(evento, (oyentes.get(evento) || []).filter((f) => f !== fn));
}
