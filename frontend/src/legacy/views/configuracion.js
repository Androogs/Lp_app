import { api } from '../../lib/api';
import { estado, navegar } from '../../lib/estado';
import { $, $$, html, raw, render as renderizar, fmt, icono, toast, modal, confirmar, mostrarError, cargando, esc, tabla, datosForm, leerDinero, validarClave, textoPolitica } from '../ui.js';

const ROLES = { admin: 'Administrador', vendedor: 'Vendedor', inventario: 'Encargado de inventario', cajero: 'Cajero', consulta: 'Contabilidad / consulta' };

export async function render(root, { partes, setTopbar }) {
  const admin = estado.tiene('usuarios.administrar');
  // Todo usuario autenticado llega aquí por #/configuracion/cuenta (app.js lo exime del permiso del módulo); sin config.ver
  // la única pestaña es "Mi cuenta", así que la pantalla se titula así y no muestra la tira de pestañas.
  const tabs = [['cuenta', 'Mi cuenta']];
  if (estado.tiene('config.ver')) tabs.unshift(['negocio', 'Negocio'], ['listas', 'Ventas y caja'], ['domicilios', 'Domicilios y comisiones'], ['categorias', 'Categorías'], ['integraciones', 'Integraciones'], ['asistente', 'Asistente Tino'], ['respaldos', 'Respaldos']);
  if (admin) tabs.splice(1, 0, ['usuarios', 'Usuarios'], ['permisos', 'Permisos']);
  if (estado.tiene('auditoria.ver')) tabs.push(['auditoria', 'Auditoría']);
  setTopbar({ titulo: tabs.length === 1 ? 'Mi cuenta' : 'Configuración' });
  let tab = partes[0] && tabs.some(([v]) => v === partes[0]) ? partes[0] : tabs[0][0];
  renderizar(root, html`${tabs.length > 1 ? html`<div class="tabs">${tabs.map(([v, t]) => html`<button class="${tab === v ? 'activo' : ''}" data-tab="${v}">${t}</button>`)}</div>` : ''}<div id="cf-cont"></div>`);
  const cont = $('#cf-cont', root);
  const pintar = () => { $$('[data-tab]', root).forEach((b) => b.classList.toggle('activo', b.dataset.tab === tab)); ({ negocio, usuarios, permisos, listas, domicilios: domiciliosConfig, categorias, integraciones, asistente: asistenteConfig, respaldos, auditoria, cuenta })[tab](cont); };
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', `#/configuracion/${tab}`); pintar(); }));
  pintar();
}

async function negocio(cont) {
  const c = await api.get('/api/configuracion');
  const ro = !estado.tiene('config.editar');
  renderizar(cont, html`<form id="f-neg" class="card">
    <div class="campo"><label>Nombre del negocio</label><input name="negocio_nombre" value="${c.negocio_nombre || ''}" ${ro ? 'readonly' : ''}></div>
    <div class="grid2"><div class="campo"><label>NIT</label><input name="negocio_nit" value="${c.negocio_nit || ''}" ${ro ? 'readonly' : ''}></div><div class="campo"><label>Teléfono</label><input name="negocio_telefono" value="${c.negocio_telefono || ''}" ${ro ? 'readonly' : ''}></div><div class="campo"><label>Dirección</label><input name="negocio_direccion" value="${c.negocio_direccion || ''}" ${ro ? 'readonly' : ''}></div><div class="campo"><label>Ciudad</label><input name="negocio_ciudad" value="${c.negocio_ciudad || ''}" ${ro ? 'readonly' : ''}></div></div>
    <div class="campo"><label>Mensaje al pie del comprobante</label><textarea name="mensaje_comprobante" ${ro ? 'readonly' : ''}>${c.mensaje_comprobante || ''}</textarea></div>
    ${!ro ? html`<div class="form-pie"><button class="btn primario" type="submit">Guardar</button></div>` : ''}
  </form>`);
  $('#f-neg', cont).addEventListener('submit', async (e) => { e.preventDefault(); try { await api.put('/api/configuracion', datosForm(e.target)); estado.config.negocio_nombre = e.target.negocio_nombre.value; toast('Configuración guardada', 'ok'); } catch (err) { mostrarError(err); } });
}

async function listas(cont) {
  const c = await api.get('/api/configuracion');
  const ro = !estado.tiene('config.editar');
  renderizar(cont, html`<form id="f-listas" class="card">
    <h2>Ventas e inventario</h2>
    <div class="grid2"><div class="campo"><label>Descuento máximo (%) sin ser administrador</label><input name="descuento_maximo_pct" type="number" min="0" max="100" value="${c.descuento_maximo_pct}" ${ro ? 'readonly' : ''}></div><div class="campo"><label>Método de valoración de costos</label><select name="metodo_valoracion" ${ro ? 'disabled' : ''}><option value="FIFO" ${c.metodo_valoracion !== 'PROMEDIO' ? 'selected' : ''}>FIFO: primero en entrar, primero en salir</option><option value="PROMEDIO" ${c.metodo_valoracion === 'PROMEDIO' ? 'selected' : ''}>Costo promedio ponderado</option></select><div class="ayuda">Los productos controlados por serial o estampilla siempre usan identificación específica. El cambio aplica a las ventas futuras; las pasadas conservan su costo.</div></div>
    <div class="campo"><label>Unidades para precio mayorista</label><input name="unidades_mayor" type="number" min="1" max="10000" value="${c.unidades_mayor ?? 10}" ${ro ? 'readonly' : ''}><div class="ayuda">Desde estas unidades de una misma referencia la línea pasa sola al precio al por mayor. Los clientes mayoristas lo reciben siempre.</div></div><div></div>
    <div class="campo"><label>Consultar TRM oficial cada (minutos)</label><input name="trm_frecuencia_minutos" type="number" min="5" max="1440" value="${c.trm_frecuencia_minutos}" ${ro ? 'readonly' : ''}></div><div class="campo"><label>Consultar dólar de mercado cada (minutos)</label><input name="mercado_frecuencia_minutos" type="number" min="5" max="1440" value="${c.mercado_frecuencia_minutos}" ${ro ? 'readonly' : ''}></div>
    <div class="campo"><label>Días de alerta antes de un vencimiento</label><input name="dias_alerta_vencimiento" type="number" min="0" value="${c.dias_alerta_vencimiento}" ${ro ? 'readonly' : ''}></div><div class="campo"><label>Días sin ventas para "sin movimiento"</label><input name="dias_sin_movimiento" type="number" min="1" value="${c.dias_sin_movimiento}" ${ro ? 'readonly' : ''}></div></div>
    <label class="check"><input type="checkbox" name="permitir_stock_negativo" ${c.permitir_stock_negativo ? 'checked' : ''} ${ro ? 'disabled' : ''}> Permitir ventas sin stock a usuarios con el permiso "Vender sin stock" (queda un faltante que se compensa con la próxima compra)</label>
    <div class="sep"></div><h2>Métodos de pago</h2><div class="campo"><label>Uno por línea</label><textarea name="metodos_pago" rows="6" ${ro ? 'readonly' : ''}>${(c.metodos_pago || []).join('\n')}</textarea><div class="ayuda">Usa nombres cortos en minúscula: efectivo, transferencia, nequi, daviplata, tarjeta, qr, otro…</div></div>
    <div class="sep"></div><h2>Categorías de gastos</h2><div class="campo"><label>Una por línea</label><textarea name="categorias_gasto" rows="8" ${ro ? 'readonly' : ''}>${(c.categorias_gasto || []).join('\n')}</textarea></div>
    ${!ro ? html`<div class="form-pie"><button class="btn primario" type="submit">Guardar</button></div>` : ''}
  </form>`);
  $('#f-listas', cont).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = datosForm(e.target);
    d.metodos_pago = String(d.metodos_pago).split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
    d.categorias_gasto = String(d.categorias_gasto).split('\n').map((s) => s.trim()).filter(Boolean);
    try { await api.put('/api/configuracion', d); Object.assign(estado.config, { metodos_pago: d.metodos_pago, categorias_gasto: d.categorias_gasto, descuento_maximo_pct: Number(d.descuento_maximo_pct), permitir_stock_negativo: d.permitir_stock_negativo, unidades_mayor: Number(d.unidades_mayor) || 10 }); toast('Guardado', 'ok'); } catch (err) { mostrarError(err); }
  });
}

// Domicilios (envío, alertas de tiempo) y remuneración: todo editable sin tocar código.
async function domiciliosConfig(cont) {
  const c = await api.get('/api/configuracion');
  const ro = !estado.tiene('config.editar');
  const v = c.domicilios || {}; const k = c.comisiones;
  const num = (id, val, extra = '') => `<input id="${id}" type="number" step="any" min="0" inputmode="decimal" value="${val ?? ''}" ${ro ? 'readonly' : ''} ${extra}>`;
  renderizar(cont, html`<form id="f-us" class="card">
    <h2>Domicilios</h2>
    <div class="grid2">
      <div class="campo"><label>Valor del envío por defecto ($)</label>${raw(num('d-cargo', v.cargo_envio_defecto))}<div class="ayuda">Se propone al tomar un pedido; se puede cambiar en cada domicilio. 0 = sin cargo.</div></div>
      <div class="campo"><label>Envío gratis desde ($)</label>${raw(num('d-gratis', v.envio_gratis_desde))}<div class="ayuda">Pedidos desde este valor en productos no pagan envío. 0 = nunca gratis.</div></div>
      <div class="campo"><label>Alerta si no sale de la bodega en (minutos)</label>${raw(num('d-prep', v.minutos_alerta_preparacion, 'max="1440"'))}</div>
      <div class="campo"><label>Alerta si lleva en camino más de (minutos)</label>${raw(num('d-camino', v.minutos_alerta_camino, 'max="1440"'))}</div>
    </div>
    <p class="muted xs">Los repartidores y vehículos se administran en Domicilios › Repartidores.</p>
    <div class="sep"></div>
    <h2>Salario y comisiones</h2>
    <div class="grid3">
      <div class="campo"><label>Salario base mensual de todos los trabajadores ($)</label>${raw(num('k-sal', k.salario_defecto))}<div class="ayuda">Se aplica a todos los vendedores y cajeros, salvo a quien le registres un salario distinto en Usuarios. No se reparte por días.</div></div>
      <div class="campo"><label>Comisión por defecto (% de la ganancia)</label>${raw(num('k-pct', k.comision_pct_defecto, 'max="100"'))}</div>
      <div class="campo"><label>La comisión se devenga</label><select id="k-dev" ${ro ? 'disabled' : ''}><option value="confirmacion" ${k.devengo !== 'cobro' ? 'selected' : ''}>Al confirmar la venta</option><option value="cobro" ${k.devengo === 'cobro' ? 'selected' : ''}>Al cobrar por completo</option></select></div>
    </div>
    <label class="check"><input type="checkbox" id="k-emp" ${k.empleador_comisiona ? 'checked' : ''} ${ro ? 'disabled' : ''}> Las ventas del empleador también comisionan</label>
    <p class="muted xs mt">Antes de usar estos cálculos como nómina oficial, verifica prestaciones y obligaciones laborales aplicables en Colombia.</p>
    ${!ro ? html`<div class="form-pie"><button class="btn primario" type="submit">Guardar</button></div>` : ''}
  </form>`);
  $('#f-us', cont).addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (id) => Number($('#' + id, cont).value);
    const domicilios = { cargo_envio_defecto: g('d-cargo'), envio_gratis_desde: g('d-gratis'), minutos_alerta_preparacion: g('d-prep'), minutos_alerta_camino: g('d-camino') };
    const comisiones = { salario_defecto: g('k-sal'), comision_pct_defecto: g('k-pct'), devengo: $('#k-dev', cont).value, empleador_comisiona: $('#k-emp', cont).checked };
    try { await api.put('/api/configuracion', { domicilios, comisiones }); estado.config.domicilios = domicilios; toast('Reglas guardadas', 'ok'); } catch (err) { mostrarError(err); }
  });
}

async function categorias(cont) {
  const cats = await api.get('/api/categorias');
  const padres = cats.filter((c) => !c.padre_id);
  const puede = estado.tiene('inventario.editar');
  renderizar(cont, html`<div class="card"><div class="row between"><h2 style="margin:0">Categorías de productos</h2>${puede ? html`<button class="btn chico primario" id="ct-nueva">${raw(icono('plus', 16))} Nueva</button>` : ''}</div>
    <div class="lista mt">${padres.map((p) => html`<div class="item"><div class="cuerpo"><div class="titulo">${p.nombre}</div><div class="sub">${cats.filter((c) => c.padre_id === p.id).map((c) => c.nombre).join(', ') || 'Sin subcategorías'}</div></div>${puede ? html`<button class="btn chico suave" data-ed="${p.id}">Editar</button>` : ''}</div>`)}</div></div>`);
  const form = (c) => modal({ titulo: c ? 'Editar categoría' : 'Nueva categoría', cuerpo: `<div class="campo"><label>Nombre</label><input id="ct-nombre" value="${esc(c?.nombre || '')}"></div>${!c ? `<div class="campo"><label>Dentro de (opcional)</label><select id="ct-padre"><option value="">Categoría principal</option>${padres.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select></div>` : '<label class="check"><input type="checkbox" id="ct-activo" checked> Activa</label>'}`, acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => { if (c) await api.put(`/api/categorias/${c.id}`, { nombre: $('#ct-nombre', m).value, activo: $('#ct-activo', m).checked }); else await api.post('/api/categorias', { nombre: $('#ct-nombre', m).value, padre_id: $('#ct-padre', m).value || null }); toast('Guardado', 'ok'); categorias(cont); } }] });
  const bn = $('#ct-nueva', cont); if (bn) bn.addEventListener('click', () => form(null));
  $$('[data-ed]', cont).forEach((b) => b.addEventListener('click', () => form(cats.find((c) => c.id === Number(b.dataset.ed)))));
}

async function usuarios(cont) {
  const us = await api.get('/api/usuarios');
  const rem = estado.tiene('comisiones.administrar');
  const TIPO = { vendedor: 'Vendedor', empleador: 'Empleador', otro: 'No vende' };
  const remTxt = (u) => (rem ? ` · ${TIPO[u.tipo_comercial] || ''}${u.tipo_comercial === 'vendedor' ? ` · ${u.salario_mensual != null ? fmt.cop(u.salario_mensual) + ' (propio)' : 'salario base general'} · ${u.comision_pct != null ? u.comision_pct + ' %' : 'comisión por defecto'}` : ''}` : '');
  renderizar(cont, html`<div class="card"><div class="row between"><h2 style="margin:0">Usuarios</h2><button class="btn chico primario" id="us-nuevo">${raw(icono('plus', 16))} Nuevo usuario</button></div>
    <div class="lista mt">${us.map((u) => html`<div class="item"><div class="thumb">${raw(icono('user', 20))}</div><div class="cuerpo"><div class="titulo">${u.nombre} <span class="muted">@${u.usuario}</span></div><div class="sub">${ROLES[u.rol] || u.rol}${raw(remTxt(u))}${u.email ? ' · ' + u.email : ''}</div></div><div class="fin">${!u.activo ? html`<span class="badge peligro">Inactivo</span>` : u.debe_cambiar_clave ? html`<span class="badge aviso">Debe cambiar clave</span>` : ''}<div class="row mt" style="margin-top:4px;justify-content:flex-end"><button class="btn chico suave" data-ed="${u.id}">Editar</button><button class="btn chico suave" data-clave="${u.id}" title="Restablecer contraseña">${raw(icono('key', 14))}</button></div></div></div>`)}</div></div>`);
  const rolesOpts = (sel) => Object.entries(ROLES).map(([v, t]) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  // Campos de remuneración (solo quien administra comisiones): tipo comercial, salario mensual y % de comisión.
  const camposRem = (u = {}) => (rem ? `<div class="sep"></div><div class="et-campo mb">Remuneración</div><div class="grid3"><div class="campo"><label>Tipo comercial</label><select id="ur-tipo"><option value="" ${!u.tipo_comercial_explicito ? 'selected' : ''}>Según el rol</option><option value="vendedor" ${u.tipo_comercial_explicito === 'vendedor' ? 'selected' : ''}>Vendedor (comisiona)</option><option value="empleador" ${u.tipo_comercial_explicito === 'empleador' ? 'selected' : ''}>Empleador</option></select></div><div class="campo"><label>Salario mensual (solo si es distinto)</label><input id="ur-sal" data-money value="${u.salario_mensual ?? ''}" placeholder="usa el salario base general"></div><div class="campo"><label>Comisión (%)</label><input id="ur-pct" type="number" min="0" max="100" step="0.5" inputmode="decimal" value="${u.comision_pct ?? ''}" placeholder="por defecto"></div></div><p class="muted xs">La comisión es un % de la ganancia de sus ventas, no del valor vendido. Los cambios quedan en auditoría.</p>` : '');
  const leerRem = (m) => (rem ? { tipo_comercial: $('#ur-tipo', m).value || null, salario_mensual: $('#ur-sal', m).value ? leerDinero($('#ur-sal', m)) : null, comision_pct: $('#ur-pct', m).value === '' ? null : Number($('#ur-pct', m).value) } : {});
  $('#us-nuevo', cont).addEventListener('click', () => modal({ titulo: 'Nuevo usuario', cuerpo: `<div class="campo"><label>Nombre *</label><input id="nu-nombre"></div><div class="grid2"><div class="campo"><label>Usuario *</label><input id="nu-usuario" autocapitalize="none"></div><div class="campo"><label>Rol</label><select id="nu-rol">${rolesOpts('vendedor')}</select></div><div class="campo"><label>Correo</label><input id="nu-email" type="email"></div><div class="campo"><label>Teléfono</label><input id="nu-tel"></div></div><div class="campo"><label>Contraseña temporal *</label><input id="nu-clave" type="text" autocomplete="new-password" maxlength="72" placeholder="${esc(textoPolitica())}"><div class="ayuda">El usuario deberá cambiarla al entrar.</div></div>${camposRem()}`, acciones: [{ texto: 'Crear', clase: 'primario', alHacerClic: async ({ modal: m }) => { const malo = validarClave($('#nu-clave', m).value, $('#nu-usuario', m).value.trim()); if (malo) { toast(malo, 'error'); return false; } await api.post('/api/usuarios', { nombre: $('#nu-nombre', m).value, usuario: $('#nu-usuario', m).value, rol: $('#nu-rol', m).value, email: $('#nu-email', m).value, telefono: $('#nu-tel', m).value, clave: $('#nu-clave', m).value, ...leerRem(m) }); toast('Usuario creado', 'ok'); usuarios(cont); } }] }));
  $$('[data-ed]', cont).forEach((b) => b.addEventListener('click', async () => {
    const u = us.find((x) => x.id === Number(b.dataset.ed));
    const cod = await api.get(`/api/usuarios/${u.id}/codigo-recuperacion`).catch(() => ({}));
    const explicito = { vendedor: 'vendedor', cajero: 'vendedor', admin: 'empleador' }[u.rol] === u.tipo_comercial ? '' : u.tipo_comercial;
    modal({ titulo: `Editar · ${u.nombre}`, cuerpo: `<div class="campo"><label>Nombre</label><input id="eu-nombre" value="${esc(u.nombre)}"></div><div class="grid2"><div class="campo"><label>Rol</label><select id="eu-rol">${rolesOpts(u.rol)}</select></div><div class="campo"><label>Correo</label><input id="eu-email" value="${esc(u.email || '')}"></div></div><label class="check"><input type="checkbox" id="eu-activo" ${u.activo ? 'checked' : ''}> Usuario activo</label>${camposRem({ ...u, tipo_comercial_explicito: explicito })}${cod.codigo ? `<div class="alerta info mt">Código de recuperación vigente: <b class="mono">${cod.codigo}</b> (vence ${fmt.fechaHora(cod.expira_en)}). Entrégaselo al usuario.</div>` : ''}`, acciones: [{ texto: 'Guardar', clase: 'primario', alHacerClic: async ({ modal: m }) => {
      const nuevo = leerRem(m);
      if (rem && u.salario_mensual != null && nuevo.salario_mensual !== u.salario_mensual && !await confirmar(`El salario registrado es ${fmt.cop(u.salario_mensual)} y pasará a ${nuevo.salario_mensual != null ? fmt.cop(nuevo.salario_mensual) : 'el salario base general'}. ¿Confirmas el cambio?`, { textoOk: 'Cambiar salario' })) return false;
      await api.put(`/api/usuarios/${u.id}`, { nombre: $('#eu-nombre', m).value, rol: $('#eu-rol', m).value, email: $('#eu-email', m).value, activo: $('#eu-activo', m).checked, ...nuevo }); toast('Usuario actualizado', 'ok'); usuarios(cont);
    } }] });
  }));
  $$('[data-clave]', cont).forEach((b) => b.addEventListener('click', () => modal({ titulo: 'Restablecer contraseña', cuerpo: `<div class="campo"><label>Nueva contraseña temporal</label><input id="rc-clave" type="text" autocomplete="new-password" maxlength="72" placeholder="${esc(textoPolitica())}"></div><p class="muted small">Se cerrarán las sesiones del usuario y deberá cambiarla al entrar.</p>`, acciones: [{ texto: 'Restablecer', clase: 'primario', alHacerClic: async ({ modal: m }) => { const malo = validarClave($('#rc-clave', m).value); if (malo) { toast(malo, 'error'); return false; } await api.post(`/api/usuarios/${b.dataset.clave}/restablecer-clave`, { nueva: $('#rc-clave', m).value }); toast('Contraseña restablecida', 'ok'); } }] })));
}

async function permisos(cont) {
  const c = await api.get('/api/configuracion');
  const roles = c.roles.filter((r) => r.clave !== 'admin');
  const actual = (rol) => (c.permisos_roles && c.permisos_roles[rol.clave]) || rol.permisos_defecto;
  renderizar(cont, html`<div class="card"><h2>Permisos por rol</h2><p class="muted small mb">El administrador siempre tiene todos los permisos. Marca lo que puede hacer cada rol.</p>
    <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Permiso</th>${roles.map((r) => html`<th class="center">${r.nombre}</th>`)}</tr></thead><tbody>
      ${c.permisos_catalogo.map((p) => html`<tr><td style="white-space:normal">${p.nombre}<div class="xs muted mono">${p.clave}</div></td>${roles.map((r) => html`<td class="center"><input type="checkbox" data-rol="${r.clave}" data-p="${p.clave}" ${actual(r).includes(p.clave) ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent)"></td>`)}</tr>`)}</tbody></table></div>
    <div class="form-pie"><button class="btn suave" id="pm-reset">Restaurar predeterminados</button><button class="btn primario" id="pm-guardar">Guardar permisos</button></div></div>`);
  $('#pm-guardar', cont).addEventListener('click', async () => { const o = {}; roles.forEach((r) => { o[r.clave] = $$(`[data-rol="${r.clave}"]:checked`, cont).map((x) => x.dataset.p); }); try { await api.put('/api/configuracion', { permisos_roles: o }); toast('Permisos guardados. Los usuarios los verán al recargar.', 'ok'); } catch (e) { mostrarError(e); } });
  $('#pm-reset', cont).addEventListener('click', async () => { if (await confirmar('¿Restaurar los permisos predeterminados de todos los roles?')) { await api.put('/api/configuracion', { permisos_roles: null }); toast('Permisos restaurados', 'ok'); permisos(cont); } });
}

async function integraciones(cont) {
  const c = await api.get('/api/configuracion');
  const puede = estado.tiene('config.editar');
  const base = location.origin;
  renderizar(cont, html`<div class="card"><h2>Tasa de cambio (TRM y dólar)</h2>
      <p class="small muted">TRM oficial: Superintendencia Financiera de Colombia vía datos.gov.co (sin credenciales; opcional <span class="mono">DATOS_GOV_APP_TOKEN</span> para más consultas). Cotización de mercado: open.er-api.com por defecto (configurable con <span class="mono">MERCADO_API_URL</span>). Frecuencias en la pestaña "Ventas y caja". Si no hay conexión se conserva el último valor con su fecha.</p>
      <a class="btn chico suave mt" href="#/contabilidad/trm">Ver TRM y estado de conexión</a></div>
    <div class="card"><h2>Lectura automática de facturas (OCR con IA)</h2>
      <div class="alerta ${c.ocr_disponible ? 'info' : 'aviso'}">${c.ocr_disponible ? 'Activa: el servidor tiene configurada la clave ANTHROPIC_API_KEY.' : 'Inactiva: configura la variable ANTHROPIC_API_KEY en el servidor (archivo .env) y reinicia la aplicación. Mientras tanto, las facturas se adjuntan y se digitan manualmente.'}</div>
      <div class="campo mt"><label>Modelo de IA para la lectura</label><input id="in-modelo" value="${c.ocr_modelo || ''}" ${puede ? '' : 'readonly'}><div class="ayuda">Predeterminado: claude-opus-5-5. Alternativa más económica: claude-haiku-5-5.</div></div>${puede ? html`<button class="btn chico suave" id="in-modelo-ok">Guardar modelo</button>` : ''}</div>
    <div class="card"><h2>API y webhooks (n8n)</h2><p class="small muted">Con el token, n8n u otra automatización puede enviar facturas recibidas por correo a la bandeja de documentos. Nunca se registra una compra sin confirmación de un usuario.</p>
      <div class="campo mt"><label>Token de API</label><div class="row"><input id="in-token" class="mono" value="${c.api_token || ''}" readonly placeholder="Sin token generado">${puede ? html`<button class="btn suave" id="in-token-gen">Generar</button>` : ''}</div></div>
      <div class="campo"><label>Enviar documento (POST)</label><input class="mono" readonly value="${base}/api/webhooks/documentos"></div>
      <div class="campo"><label>Cabecera</label><input class="mono" readonly value="X-Api-Token: &lt;token&gt;"></div>
      <div class="campo"><label>Cuerpo JSON de ejemplo</label><textarea class="mono" readonly rows="6">{ "archivo": "data:application/pdf;base64,JVBERi0...", "nombre": "factura-123.pdf", "remitente": "ventas@proveedor.com", "nota": "Recibida por correo", "ocr": true }</textarea></div>
      <div class="campo"><label>Consultas disponibles con el token (GET)</label><textarea class="mono" readonly rows="4">${base}/api/productos?q=iphone
${base}/api/creditos?estado=vencido
${base}/api/reportes/inventario?formato=csv
${base}/api/webhooks/ping</textarea></div></div>`);
  const bt = $('#in-token-gen', cont); if (bt) bt.addEventListener('click', async () => { if (await confirmar('Se generará un token nuevo y el anterior dejará de funcionar. ¿Continuar?')) { const r = await api.post('/api/configuracion/api-token'); $('#in-token', cont).value = r.api_token; toast('Token generado. Cópialo ahora: por seguridad no se volverá a mostrar.', 'ok'); } });
  const bm = $('#in-modelo-ok', cont); if (bm) bm.addEventListener('click', async () => { await api.put('/api/configuracion', { ocr_modelo: $('#in-modelo', cont).value.trim() }); toast('Modelo guardado', 'ok'); });
}

// Asistente Tino: activo, proveedor, modelo, esfuerzo, límite por hora y voz. La clave del proveedor vive en el servidor
// (variable de entorno) y aquí solo se informa si existe; nunca se muestra ni se guarda.
async function asistenteConfig(cont) {
  const [c, est] = await Promise.all([api.get('/api/configuracion'), api.get('/api/asistente/estado').catch(() => null)]);
  const a = { activo: true, motor: 'auto', proveedor: 'anthropic', modelo: 'claude-opus-5-5', esfuerzo: 'low', limite_mensajes_hora: 40, voz: true, nombre: 'Tino', avisos: true, dias_cobertura: 7, ...(c.asistente || {}) };
  const ro = !estado.tiene('config.editar');
  const claves = (est && est.claves) || {};
  const variable = a.proveedor === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
  const claveOk = a.proveedor === 'openrouter' ? !!claves.openrouter : !!claves.anthropic;
  const estadoTxt = (ok) => (ok ? 'clave presente' : 'sin clave');
  renderizar(cont, html`<form id="f-ast" class="card">
    <div class="row between"><h2 style="margin:0">Asistente Tino</h2>${est ? html`<span class="badge ${est.disponible ? 'ok' : 'aviso'}">${est.disponible ? 'Listo' : 'Sin configurar'}</span>` : ''}</div>
    <p class="small muted mt">Tino responde preguntas sobre inventario, ventas de cualquier día, pendientes, caja, créditos, compras, rentabilidad y TRM usando solo lo que cada usuario tiene permiso de ver, avisa cuando un producto se agota o se va a acabar y explica cómo hacer los procesos de la aplicación. Lo ven los usuarios con el permiso "Usar el asistente Tino".</p>
    <label class="check mt"><input type="checkbox" name="activo" ${a.activo ? 'checked' : ''} ${ro ? 'disabled' : ''}> Asistente activo (muestra la mascota y el panel de conversación)</label>
    <div class="grid2">
      <div class="campo"><label>Motor de respuestas</label><select name="motor" ${ro ? 'disabled' : ''}>
        <option value="auto" ${a.motor !== 'local' && a.motor !== 'ia' ? 'selected' : ''}>Automático: datos del sistema y, si hay clave, IA para lo demás (recomendado)</option>
        <option value="local" ${a.motor === 'local' ? 'selected' : ''}>Solo datos del sistema (sin IA, sin costo, sin internet)</option>
        <option value="ia" ${a.motor === 'ia' ? 'selected' : ''}>Todo con IA (requiere la clave)</option>
      </select><div class="ayuda">Con "Automático" o "Solo datos del sistema", Tino funciona aunque no haya clave de IA.</div></div>
      <div class="campo"><label>Avisar cuando un producto alcance para menos de</label><input name="dias_cobertura" type="number" min="1" max="60" inputmode="numeric" value="${a.dias_cobertura}" ${ro ? 'readonly' : ''}><div class="ayuda">Días, según el ritmo de ventas reciente. Los agotados y los que llegan al stock mínimo siempre se avisan.</div></div>
    </div>
    <label class="check"><input type="checkbox" name="avisos" ${a.avisos !== false ? 'checked' : ''} ${ro ? 'disabled' : ''}> Mostrar avisos de pendientes en la mascota (contador, burbuja y, si cada usuario lo activa, avisos del navegador)</label>
    <h3 class="mt">Inteligencia artificial (opcional)</h3>
    <div class="alerta ${claveOk ? 'info' : a.motor === 'ia' ? 'aviso' : 'info'} mt">${claveOk ? `Clave del proveedor configurada en el servidor (${variable}).` : a.motor === 'ia' ? `Falta la clave en el servidor: agrega ${variable} en las variables de entorno del servidor (hPanel › Node.js o archivo .env) y reinicia la aplicación, o cambia el motor a "Automático". La clave nunca se guarda en la aplicación.` : `Sin clave de IA: Tino responde con los datos del sistema. Para que también conteste preguntas abiertas, agrega ${variable} en las variables de entorno del servidor y reinicia la aplicación.`}</div>
    <div class="grid2">
      <div class="campo"><label>Proveedor de IA</label><select name="proveedor" ${ro ? 'disabled' : ''}><option value="anthropic" ${a.proveedor !== 'openrouter' ? 'selected' : ''}>Anthropic (SDK oficial, recomendado)</option><option value="openrouter" ${a.proveedor === 'openrouter' ? 'selected' : ''}>OpenRouter (alternativa, sin probar)</option></select><div class="ayuda">Anthropic: ${estadoTxt(claves.anthropic)} · OpenRouter: ${estadoTxt(claves.openrouter)}.</div></div>
      <div class="campo"><label>Modelo</label><input name="modelo" list="ast-modelos" value="${a.modelo}" autocomplete="off" ${ro ? 'readonly' : ''}><datalist id="ast-modelos"><option value="claude-opus-5-5"></option><option value="claude-sonnet-5-5"></option><option value="claude-haiku-5-5"></option></datalist><div class="ayuda">Recomendado: claude-opus-5-5. Más económicos: claude-sonnet-5-5 y claude-haiku-5-5.</div></div>
      <div class="campo"><label>Esfuerzo de razonamiento</label><select name="esfuerzo" ${ro ? 'disabled' : ''}><option value="low" ${a.esfuerzo !== 'medium' && a.esfuerzo !== 'high' ? 'selected' : ''}>Bajo (rápido y económico, recomendado)</option><option value="medium" ${a.esfuerzo === 'medium' ? 'selected' : ''}>Medio</option><option value="high" ${a.esfuerzo === 'high' ? 'selected' : ''}>Alto (más lento y costoso)</option></select></div>
      <div class="campo"><label>Límite de mensajes por hora (por usuario)</label><input name="limite_mensajes_hora" type="number" min="1" max="1000" inputmode="numeric" value="${a.limite_mensajes_hora}" ${ro ? 'readonly' : ''}><div class="ayuda">Protege el costo de la IA. En modo "Automático", al superarlo Tino sigue respondiendo con los datos del sistema.</div></div>
    </div>
    <label class="check"><input type="checkbox" name="voz" ${a.voz ? 'checked' : ''} ${ro ? 'disabled' : ''}> Permitir dictado por voz y lectura de respuestas (usa el micrófono y la voz del navegador; no se envía audio al servidor)</label>
    <p class="muted xs mt">Cada respuesta guarda tokens y costo estimado en dólares; se ven en la auditoría (acción "asistente_consulta"). Detalles en docs/ASISTENTE.md.</p>
    ${!ro ? html`<div class="form-pie"><button class="btn primario" type="submit">Guardar</button></div>` : ''}
  </form>`);
  $('#f-ast', cont).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const asistente = { activo: f.activo.checked, motor: f.motor.value, avisos: f.avisos.checked, dias_cobertura: Number(f.dias_cobertura.value), proveedor: f.proveedor.value, modelo: f.modelo.value.trim(), esfuerzo: f.esfuerzo.value, limite_mensajes_hora: Number(f.limite_mensajes_hora.value), voz: f.voz.checked };
    try { await api.put('/api/configuracion', { asistente }); toast('Asistente guardado. Los usuarios verán el cambio al recargar.', 'ok'); asistenteConfig(cont); } catch (err) { mostrarError(err); }
  });
}

async function respaldos(cont) {
  const r = await api.get('/api/respaldos');
  const puede = estado.tiene('config.editar');
  renderizar(cont, html`<div class="card"><h2>Copias de seguridad</h2><p class="small muted">La base de datos (SQLite) se copia automáticamente cada día en el servidor (se conservan 14). Descarga una copia y guárdala fuera del servidor con regularidad.</p>
      <div class="muted xs mono mt">${r.base_datos}</div>
      ${puede ? html`<div class="row wrap mt gap"><a class="btn primario" href="/api/respaldos/descargar">${raw(icono('download'))} Descargar copia ahora</a><button class="btn suave" id="rs-crear">${raw(icono('database'))} Crear copia en el servidor</button></div>` : ''}
      <div class="mt-l">${r.respaldos.length ? tabla([{ titulo: 'Archivo', clave: 'nombre' }, { titulo: 'Fecha', valor: (x) => fmt.fechaHora(new Date(x.fecha).toISOString().slice(0, 19).replace('T', ' ')) }, { titulo: 'Tamaño', valor: (x) => `${(x.tamano / 1024).toFixed(0)} KB` }], r.respaldos) : html`<p class="muted">Aún no hay copias.</p>`}</div></div>`);
  const b = $('#rs-crear', cont); if (b) b.addEventListener('click', async () => { await api.post('/api/respaldos'); toast('Copia creada', 'ok'); respaldos(cont); });
}

async function auditoria(cont) {
  renderizar(cont, html`<div class="card compacta row wrap gap"><input type="date" id="au-desde"><input type="date" id="au-hasta"><input type="text" id="au-entidad" placeholder="Entidad (venta, producto…)" style="max-width:200px"><button class="btn chico primario" id="au-ok">Filtrar</button></div><div id="au-tabla" class="mt"></div>`);
  const cargar = async () => {
    $('#au-tabla', cont).innerHTML = String(cargando(4));
    const filas = await api.get('/api/auditoria' + api.qs({ desde: $('#au-desde', cont).value, hasta: $('#au-hasta', cont).value, entidad: $('#au-entidad', cont).value.trim(), limite: 300 }));
    $('#au-tabla', cont).innerHTML = String(tabla([{ titulo: 'Fecha', valor: (f) => fmt.fechaHora(f.fecha) }, { titulo: 'Usuario', clave: 'usuario_nombre' }, { titulo: 'Acción', clave: 'accion' }, { titulo: 'Entidad', valor: (f) => `${f.entidad} ${f.entidad_id || ''}` }, { titulo: 'Detalle', valor: (f) => (f.detalle ? JSON.stringify(f.detalle).slice(0, 160) : '') }], filas, { vacioTexto: 'Sin registros' }));
  };
  $('#au-ok', cont).addEventListener('click', cargar);
  cargar();
}

async function cuenta(cont) {
  const u = estado.usuario;
  renderizar(cont, html`<div class="card"><h2>${u.nombre}</h2><div class="muted small">@${u.usuario} · ${ROLES[u.rol] || u.rol}</div>
    ${u.debe_cambiar_clave ? html`<div class="alerta aviso mt">Por seguridad, cambia tu contraseña ahora.</div>` : ''}
    <form id="f-clave" class="mt-l"><h3>Cambiar contraseña</h3><div class="campo mt"><label>Contraseña actual</label><input name="actual" type="password" autocomplete="current-password" required></div><div class="campo"><label>Nueva contraseña</label><input name="nueva" type="password" autocomplete="new-password" required minlength="${estado.config.clave_min || 10}" maxlength="72" placeholder="${esc(textoPolitica())}"></div><div class="campo"><label>Repetir nueva contraseña</label><input name="repetir" type="password" autocomplete="new-password" required></div><button class="btn primario" type="submit">Cambiar contraseña</button></form>
    <div class="sep"></div><h3>Instalar en el celular</h3><p class="small muted mt">En Chrome (Android): menú ⋮ → "Instalar aplicación". En Safari (iPhone): botón compartir → "Agregar a inicio". Así abre a pantalla completa con su propio icono.</p></div>`);
  $('#f-clave', cont).addEventListener('submit', async (e) => { e.preventDefault(); const f = e.target; if (f.nueva.value !== f.repetir.value) return toast('Las contraseñas no coinciden', 'error'); const malo = validarClave(f.nueva.value, estado.usuario.usuario); if (malo) return toast(malo, 'error'); try { await api.post('/api/auth/cambiar-clave', { actual: f.actual.value, nueva: f.nueva.value }); estado.usuario.debe_cambiar_clave = false; toast('Contraseña actualizada', 'ok'); f.reset(); } catch (err) { mostrarError(err); } });
}
