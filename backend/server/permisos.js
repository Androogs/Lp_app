'use strict';
// Roles y permisos. Los permisos por rol se pueden ajustar desde Configuración (se guardan en `configuracion.permisos_roles`).

const PERMISOS = [
  ['ventas.ver', 'Ver ventas'],
  ['ventas.crear', 'Registrar ventas'],
  ['ventas.descuento', 'Aplicar descuentos'],
  ['ventas.cambiar_precio', 'Cambiar precio en la venta'],
  ['ventas.devolver', 'Registrar devoluciones y cambios'],
  ['ventas.anular', 'Anular ventas'],
  ['compras.ver', 'Ver compras'],
  ['compras.crear', 'Registrar compras'],
  ['compras.pagar', 'Registrar pagos a proveedores'],
  ['compras.anular', 'Anular compras'],
  ['inventario.ver', 'Ver inventario y costos'],
  ['inventario.editar', 'Crear y editar productos'],
  ['inventario.cambiar_precio', 'Cambiar precio de venta'],
  ['inventario.cambiar_costo', 'Cambiar costo de referencia'],
  ['inventario.ajustar', 'Ajustes, roturas y pérdidas de inventario'],
  ['inventario.stock_negativo', 'Vender sin stock (autorizar negativo)'],
  ['clientes.ver', 'Ver clientes'],
  ['clientes.editar', 'Crear y editar clientes'],
  ['proveedores.ver', 'Ver proveedores'],
  ['proveedores.editar', 'Crear y editar proveedores'],
  ['creditos.ver', 'Ver créditos y cartera'],
  ['creditos.abonar', 'Registrar abonos'],
  ['creditos.modificar', 'Modificar condiciones de créditos'],
  ['caja.ver', 'Ver caja'],
  ['caja.operar', 'Abrir y cerrar caja, entradas y salidas'],
  ['caja.gastos', 'Registrar gastos'],
  ['documentos.ver', 'Ver bandeja de documentos'],
  ['documentos.procesar', 'Procesar documentos (OCR, proponer compras)'],
  ['reportes.ver', 'Ver y exportar reportes'],
  ['contabilidad.ver', 'Ver contabilidad, rentabilidad y TRM'],
  ['contabilidad.editar', 'Registrar tasas manuales y corregir tasas de operaciones'],
  ['domicilios.ver', 'Ver domicilios y su estado'],
  ['domicilios.crear', 'Tomar pedidos a domicilio'],
  ['domicilios.despachar', 'Preparar, despachar, entregar y cancelar domicilios; administrar repartidores'],
  ['comisiones.ver_propias', 'Ver sus propias ventas y comisiones'],
  ['comisiones.ver', 'Ver rentabilidad y comisiones de todos'],
  ['comisiones.administrar', 'Salarios, porcentajes, reasignar responsables y cerrar liquidaciones'],
  ['marketing.ver', 'Ver marketing: campañas, inversión, embudo y resultados'],
  ['marketing.editar', 'Crear y editar campañas, métricas y atribuciones'],
  ['marketing.leads', 'Registrar y atender clientes potenciales'],
  ['marketing.configurar', 'Conectar plataformas publicitarias y el seguimiento web'],
  ['asistente.usar', 'Usar el asistente Tino (consultas y avisos sobre lo que el usuario puede ver)'],
  ['config.ver', 'Ver configuración'],
  ['config.editar', 'Editar configuración del negocio'],
  ['usuarios.administrar', 'Administrar usuarios y permisos'],
  ['auditoria.ver', 'Ver historial de auditoría'],
  ['eliminar', 'Eliminar información (desactivar registros)'],
];

const ROLES = {
  admin: { nombre: 'Administrador', permisos: ['*'] },
  vendedor: {
    nombre: 'Vendedor',
    permisos: ['ventas.ver', 'ventas.crear', 'ventas.descuento', 'inventario.ver', 'clientes.ver', 'clientes.editar', 'creditos.ver', 'creditos.abonar', 'caja.ver', 'documentos.ver', 'domicilios.ver', 'domicilios.crear', 'comisiones.ver_propias', 'marketing.leads', 'asistente.usar'],
  },
  inventario: {
    nombre: 'Encargado de inventario',
    permisos: ['inventario.ver', 'inventario.editar', 'inventario.cambiar_precio', 'inventario.ajustar', 'compras.ver', 'compras.crear', 'proveedores.ver', 'proveedores.editar', 'documentos.ver', 'documentos.procesar', 'reportes.ver', 'domicilios.ver', 'asistente.usar'],
  },
  cajero: {
    nombre: 'Cajero',
    permisos: ['ventas.ver', 'ventas.crear', 'ventas.devolver', 'inventario.ver', 'clientes.ver', 'clientes.editar', 'creditos.ver', 'creditos.abonar', 'caja.ver', 'caja.operar', 'caja.gastos', 'compras.pagar', 'compras.ver', 'proveedores.ver', 'domicilios.ver', 'domicilios.crear', 'domicilios.despachar', 'comisiones.ver_propias', 'marketing.leads', 'asistente.usar'],
  },
  consulta: {
    nombre: 'Contabilidad / consulta',
    permisos: ['ventas.ver', 'compras.ver', 'inventario.ver', 'clientes.ver', 'proveedores.ver', 'creditos.ver', 'caja.ver', 'reportes.ver', 'documentos.ver', 'auditoria.ver', 'config.ver', 'contabilidad.ver', 'domicilios.ver', 'comisiones.ver', 'marketing.ver', 'asistente.usar'],
  },
};

function permisosDeRol(rol, overrides) {
  const base = ROLES[rol];
  if (!base) return new Set();
  if (base.permisos.includes('*')) return new Set(['*']);
  const lista = overrides && Array.isArray(overrides[rol]) ? overrides[rol] : base.permisos;
  return new Set(lista);
}

function tiene(usuario, permiso) {
  if (!usuario || !usuario.permisos) return false;
  return usuario.permisos.has('*') || usuario.permisos.has(permiso);
}

module.exports = { PERMISOS, ROLES, permisosDeRol, tiene };
