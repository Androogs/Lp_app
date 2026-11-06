// Ciclo de vida de la sesión: cargar la sesión actual, aplicar la respuesta del inicio de sesión y cerrar sesión.
// React se suscribe con useSesion() para volver a pintar cuando cambia el usuario o la configuración.
import { useSyncExternalStore } from 'react';
import { api, fijarCsrf, ErrorApi } from './api';
import { estado, emitir, navegar } from './estado';
import type { RespuestaSesion } from './tipos';

let version = 0;
const oyentes = new Set<() => void>();
export function notificarSesion(): void { version += 1; oyentes.forEach((fn) => fn()); }
const suscribir = (fn: () => void) => { oyentes.add(fn); return () => { oyentes.delete(fn); }; };
export function useSesion(): number { return useSyncExternalStore(suscribir, () => version, () => version); }

export async function recargarSesion(): Promise<RespuestaSesion | null> {
  try {
    const d = await api.get<RespuestaSesion>('/api/auth/yo', { silencioso: true });
    estado.usuario = d.usuario; estado.config = d.config || {}; estado.caja = d.caja || null;
    notificarSesion();
    return d;
  } catch (e) {
    if (e instanceof ErrorApi && e.datos && e.datos.config) estado.config = e.datos.config as RespuestaSesion['config'];
    estado.usuario = null;
    notificarSesion();
    return null;
  }
}

export function aplicarSesion(datos: RespuestaSesion): void {
  estado.usuario = datos.usuario;
  estado.config = datos.config || {};
  estado.caja = datos.caja || null;
  emitir('sesion', datos);
  notificarSesion();
  if (datos.usuario.debe_cambiar_clave) navegar('#/configuracion/cuenta', true);
  else if (location.hash === '#/login' || !location.hash) navegar('#/inicio', true);
}

export function limpiarSesion(): void {
  estado.usuario = null;
  fijarCsrf('');
  notificarSesion();
}

export async function cerrarSesion(): Promise<void> {
  try { await api.post('/api/auth/logout'); } catch { /* igual salimos */ }
  limpiarSesion();
  location.hash = '#/login';
  location.reload();
}
