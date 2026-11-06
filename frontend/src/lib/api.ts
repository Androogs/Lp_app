// Cliente HTTP: JSON, cookie de sesión y protección CSRF (cabecera de la aplicación + token de la sesión).
// Los errores llegan como ErrorApi con mensaje legible.

export interface DatosError {
  error?: string;
  codigo?: string;
  [clave: string]: unknown;
}

export class ErrorApi extends Error {
  status: number;
  datos: DatosError;
  codigo?: string;
  constructor(status: number, datos: DatosError | null) {
    super((datos && typeof datos.error === 'string' && datos.error) || `Error ${status}`);
    this.status = status;
    this.datos = datos || {};
    this.codigo = this.datos.codigo;
  }
}

interface Opciones { silencioso?: boolean; blob?: boolean }
type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let alNoAutenticado: ((datos: DatosError | null) => void) | null = null;
export function cuandoNoAutenticado(fn: (datos: DatosError | null) => void): void { alNoAutenticado = fn; }

// Token anti-CSRF de la sesión: llega en /api/auth/login y /api/auth/yo y se envía en cada escritura.
let tokenCsrf = '';
export function fijarCsrf(t: unknown): void { tokenCsrf = typeof t === 'string' ? t : ''; }
const ESCRITURA = new Set<Metodo>(['POST', 'PUT', 'PATCH', 'DELETE']);
const CABECERA_APP = 'PalmiraGestion';

async function pedir<T = any>(metodo: Metodo, ruta: string, cuerpo?: unknown, opciones: Opciones = {}, reintento = false): Promise<T> {
  const cab: Record<string, string> = { 'X-Requested-With': CABECERA_APP };
  if (ESCRITURA.has(metodo) && tokenCsrf) cab['X-CSRF-Token'] = tokenCsrf;
  if (cuerpo !== undefined) cab['Content-Type'] = 'application/json';
  let resp: Response;
  try {
    resp = await fetch(ruta, { method: metodo, headers: cab, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo), credentials: 'same-origin' });
  } catch {
    throw new ErrorApi(0, { error: 'Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.', codigo: 'sin_conexion' });
  }
  if (opciones.blob) {
    if (!resp.ok) throw new ErrorApi(resp.status, await resp.json().catch(() => ({})));
    return (await resp.blob()) as unknown as T;
  }
  const texto = await resp.text();
  let datos: any = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = { error: resp.ok ? texto : `Error ${resp.status}` }; }
  if (datos && typeof datos.csrf === 'string') fijarCsrf(datos.csrf);
  // Token CSRF vencido (p. ej. otra pestaña inició sesión de nuevo): se renueva una vez y se repite la petición.
  if (resp.status === 403 && datos && datos.codigo === 'csrf_invalido' && !reintento) {
    try {
      const r = await fetch('/api/auth/yo', { headers: { 'X-Requested-With': CABECERA_APP }, credentials: 'same-origin' });
      const d = await r.json().catch(() => null);
      if (r.ok && d && d.csrf) { fijarCsrf(d.csrf); return pedir<T>(metodo, ruta, cuerpo, opciones, true); }
    } catch { /* sin conexión: se informa el error original */ }
  }
  if (resp.status === 401 && !opciones.silencioso) {
    if (alNoAutenticado) alNoAutenticado(datos);
    throw new ErrorApi(401, datos);
  }
  if (!resp.ok) throw new ErrorApi(resp.status, datos);
  return datos as T;
}

export const api = {
  get: <T = any>(ruta: string, opciones?: Opciones) => pedir<T>('GET', ruta, undefined, opciones),
  post: <T = any>(ruta: string, cuerpo?: unknown, opciones?: Opciones) => pedir<T>('POST', ruta, cuerpo ?? {}, opciones),
  put: <T = any>(ruta: string, cuerpo?: unknown, opciones?: Opciones) => pedir<T>('PUT', ruta, cuerpo ?? {}, opciones),
  del: <T = any>(ruta: string, opciones?: Opciones) => pedir<T>('DELETE', ruta, undefined, opciones),
  qs: (obj: Record<string, unknown> | null | undefined): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
    const s = p.toString();
    return s ? '?' + s : '';
  },
};
