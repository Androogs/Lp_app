// Registro de pantallas. Las nativas en React se declaran como 'react'; las demás se cargan bajo demanda desde
// src/legacy/views (JavaScript existente, montado por <PantallaHeredada>) mientras se migran a componentes React.
import type { ModuloVista } from './tipos';

type Cargador = () => Promise<ModuloVista>;
export type Vista = { tipo: 'react'; componente: 'inicio' } | { tipo: 'heredada'; cargar: Cargador };

const h = (cargar: Cargador): Vista => ({ tipo: 'heredada', cargar });

export const VISTAS: Record<string, Vista> = {
  inicio: { tipo: 'react', componente: 'inicio' },
  graficas: h(() => import('../legacy/views/graficas.js')),
  domicilios: h(() => import('../legacy/views/domicilios.js')),
  comisiones: h(() => import('../legacy/views/comisiones.js')),
  inventario: h(() => import('../legacy/views/inventario.js')),
  compras: h(() => import('../legacy/views/compras.js')),
  documentos: h(() => import('../legacy/views/compras.js')),
  vender: h(() => import('../legacy/views/ventas.js')),
  ventas: h(() => import('../legacy/views/ventas.js')),
  clientes: h(() => import('../legacy/views/clientes.js')),
  proveedores: h(() => import('../legacy/views/proveedores.js')),
  creditos: h(() => import('../legacy/views/creditos.js')),
  caja: h(() => import('../legacy/views/caja.js')),
  reportes: h(() => import('../legacy/views/reportes.js')),
  contabilidad: h(() => import('../legacy/views/contabilidad.js')),
  marketing: h(() => import('../legacy/views/marketing.js')),
  configuracion: h(() => import('../legacy/views/configuracion.js')),
};

// "Mi cuenta" (#/configuracion/cuenta) es de todo usuario autenticado aunque no vea Configuración.
export const esRutaMiCuenta = (seccion: string, partes: string[]): boolean => seccion === 'configuracion' && partes[1] === 'cuenta';
