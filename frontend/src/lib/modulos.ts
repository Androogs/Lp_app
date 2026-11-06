// Módulos del sistema: única fuente para el menú lateral, la barra inferior del celular y el menú "Más".
// Un módulo nuevo se agrega aquí y en lib/vistas.ts (componente o pantalla que lo pinta).
import { estado } from './estado';
import { esc, icono } from '../legacy/ui.js';

export interface Grupo { clave: string; nombre: string | null; orden: string[] }
export interface Modulo { ruta: string; nombre: string; icono: string; descripcion: string; permiso?: string[]; grupo: string }

export const GRUPOS: Grupo[] = [
  { clave: 'principal', nombre: null, orden: ['inicio', 'graficas', 'vender', 'domicilios', 'inventario', 'compras', 'clientes', 'creditos'] },
  { clave: 'finanzas', nombre: 'Finanzas', orden: ['caja', 'comisiones', 'contabilidad'] },
  { clave: 'gestion', nombre: 'Gestión', orden: ['reportes', 'proveedores', 'marketing', 'configuracion'] },
];

export const MODULOS: Modulo[] = [
  { ruta: 'inicio', nombre: 'Inicio', icono: 'home', descripcion: 'Resumen del día y pendientes', grupo: 'principal' },
  { ruta: 'graficas', nombre: 'Gráficas del negocio', icono: 'analytics', descripcion: 'Rendimiento de la licorera', grupo: 'principal' },
  { ruta: 'vender', nombre: 'Ventas', icono: 'cart', descripcion: 'Registrar y consultar ventas', permiso: ['ventas.crear', 'ventas.ver'], grupo: 'principal' },
  { ruta: 'domicilios', nombre: 'Domicilios', icono: 'moto', descripcion: 'Pedidos, despacho y flota propia', permiso: ['domicilios.ver'], grupo: 'principal' },
  { ruta: 'inventario', nombre: 'Inventario', icono: 'bottle', descripcion: 'Licores, existencias y precios', permiso: ['inventario.ver'], grupo: 'principal' },
  { ruta: 'compras', nombre: 'Compras', icono: 'truck', descripcion: 'Registrar compras a distribuidores', permiso: ['compras.ver', 'compras.crear'], grupo: 'principal' },
  { ruta: 'clientes', nombre: 'Clientes', icono: 'users', descripcion: 'Clientes al detal y mayoristas', permiso: ['clientes.ver'], grupo: 'principal' },
  { ruta: 'creditos', nombre: 'Créditos y cartera', icono: 'card', descripcion: 'Cobrar cuotas y registrar abonos', permiso: ['creditos.ver'], grupo: 'principal' },
  { ruta: 'caja', nombre: 'Caja y gastos', icono: 'cash', descripcion: 'Abrir, cerrar caja y anotar gastos', permiso: ['caja.ver'], grupo: 'finanzas' },
  { ruta: 'proveedores', nombre: 'Proveedores', icono: 'bag', descripcion: 'Consultar proveedores y saldos', permiso: ['proveedores.ver'], grupo: 'gestion' },
  { ruta: 'comisiones', nombre: 'Rentabilidad y comisiones', icono: 'dollar', descripcion: 'Ganancia por venta, salario y comisiones', permiso: ['comisiones.ver_propias', 'comisiones.ver', 'comisiones.administrar'], grupo: 'finanzas' },
  { ruta: 'contabilidad', nombre: 'Contabilidad', icono: 'book', descripcion: 'Información financiera y tasa de cambio', permiso: ['contabilidad.ver'], grupo: 'finanzas' },
  { ruta: 'marketing', nombre: 'Marketing', icono: 'megaphone', descripcion: 'Campañas, clientes potenciales y resultados', permiso: ['marketing.ver', 'marketing.editar', 'marketing.leads'], grupo: 'gestion' },
  { ruta: 'reportes', nombre: 'Reportes', icono: 'file', descripcion: 'Descargar informes en Excel y PDF', permiso: ['reportes.ver'], grupo: 'gestion' },
  { ruta: 'configuracion', nombre: 'Configuración', icono: 'settings', descripcion: 'Negocio, usuarios y preferencias', permiso: ['config.ver', 'usuarios.administrar'], grupo: 'gestion' },
];

// Secciones que pertenecen a un módulo sin llevar su nombre en la ruta (#/ventas → "vender", #/documentos → compras).
const ALIAS: Record<string, string> = { ventas: 'vender', documentos: 'compras' };
export const moduloDe = (seccion: string): string => ALIAS[seccion] || seccion;
export const esActivo = (m: Modulo, seccion: string): boolean => moduloDe(seccion) === m.ruta;
export function moduloVisible(m: Modulo | null | undefined): boolean {
  if (!m) return false;
  if (!m.permiso) return true;
  return estado.tieneAlguno(...m.permiso);
}
export const modulosVisibles = (): Modulo[] => MODULOS.filter(moduloVisible);
export const buscarModulo = (seccion: string): Modulo | null => MODULOS.find((m) => esActivo(m, seccion)) || null;

export interface GrupoVisible extends Grupo { items: Modulo[] }
export function modulosPorGrupo({ excluir = [] as string[] } = {}): GrupoVisible[] {
  const visibles = modulosVisibles().filter((m) => !excluir.includes(m.ruta));
  return GRUPOS.map((g) => {
    const items = visibles.filter((m) => (m.grupo || 'principal') === g.clave)
      .sort((a, b) => { const ia = g.orden.indexOf(a.ruta); const ib = g.orden.indexOf(b.ruta); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    return { ...g, items };
  }).filter((g) => g.items.length);
}

// Cuadrícula de módulos en HTML (la usa el menú "Más" del celular, que se abre en un diálogo).
export function cuadriculaApps({ excluir = ['inicio'], seccion = null as string | null, items = null as Modulo[] | null } = {}): string {
  const lista = items || modulosVisibles().filter((m) => !excluir.includes(m.ruta));
  return `<div class="apps">${lista.map((m) => `<a class="app-tile ${seccion && esActivo(m, seccion) ? 'activo' : ''}" href="#/${m.ruta}" aria-label="${esc(m.nombre)}: ${esc(m.descripcion)}"><span class="app-ico">${icono(m.icono)}</span><span class="app-nombre">${esc(m.nombre)}</span>${m.descripcion ? `<span class="app-desc">${esc(m.descripcion)}</span>` : ''}</a>`).join('')}</div>`;
}

export const NOMBRES_ROL: Record<string, string> = { admin: 'Administrador', vendedor: 'Vendedor', inventario: 'Encargado de bodega', cajero: 'Cajero', consulta: 'Consulta' };
export const nombreRol = (r: string): string => NOMBRES_ROL[r] || r;
