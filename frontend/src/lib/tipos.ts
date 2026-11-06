// Tipos compartidos del frontend. Reflejan lo que devuelve la API del backend.

export type Rol = 'admin' | 'vendedor' | 'inventario' | 'cajero' | 'consulta' | string;

export interface Usuario {
  id: number;
  nombre: string;
  usuario: string;
  email: string | null;
  telefono: string | null;
  rol: Rol;
  debe_cambiar_clave: boolean;
  permisos: string[];
  tipo_comercial: 'vendedor' | 'empleador' | 'otro' | string;
  salario_mensual: number | null;
  comision_pct: number | null;
}

export interface ConfigPublica {
  negocio_nombre?: string;
  negocio_nit?: string;
  negocio_direccion?: string;
  negocio_telefono?: string;
  negocio_ciudad?: string;
  metodos_pago?: string[];
  categorias_gasto?: string[];
  descuento_maximo_pct?: number;
  permitir_stock_negativo?: boolean;
  dias_alerta_vencimiento?: number;
  ocr_disponible?: boolean;
  metodo_valoracion?: string;
  clave_min?: number;
  demo?: boolean;
  [clave: string]: unknown;
}

export interface CajaSesion {
  id: number;
  abierta_en: string;
  base_inicial: number;
  estado: string;
  [clave: string]: unknown;
}

export interface RespuestaSesion {
  usuario: Usuario;
  config: ConfigPublica;
  caja: CajaSesion | null;
  csrf?: string;
}

export interface AccionTopbar {
  icono?: string;
  texto?: string;
  titulo?: string;
  clase?: string;
  href?: string;
  alHacerClic?: (e: MouseEvent) => void;
}

export interface Topbar {
  titulo: string;
  atras?: string | boolean | null;
  acciones?: AccionTopbar[];
}

export interface Ruta {
  seccion: string;
  partes: string[];
  query: Record<string, string>;
  hash: string;
}

// Contexto que recibe cada pantalla (también las pantallas heredadas en JavaScript).
export interface ContextoVista {
  seccion: string;
  partes: string[];
  query: Record<string, string>;
  setTopbar: (t: Topbar) => void;
}

export interface ModuloVista {
  render: (root: HTMLElement, ctx: ContextoVista) => Promise<{ destruir?: () => void } | null | void> | { destruir?: () => void } | null | void;
}
