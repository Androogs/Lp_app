// Utilidades de interfaz: plantillas seguras, formato colombiano, modales, avisos, tablas e iconos.
import { estado } from '../lib/estado';

export class Raw { constructor(v) { this.v = v; } toString() { return this.v; } }
export const raw = (v) => new Raw(v);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function valor(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.v;
  if (Array.isArray(v)) return v.map(valor).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? valor(vals[i]) : ''); });
  return new Raw(out);
}
export function render(el, contenido) { el.innerHTML = String(contenido); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- Validación de contraseñas (misma política que el servidor; el servidor siempre valida de nuevo) ----
const claveMin = () => Number(estado.config && estado.config.clave_min) || 10;
export function textoPolitica() { return `Mínimo ${claveMin()} caracteres, con letras y números.`; }
export function validarClave(clave, usuario = '') {
  const c = String(clave || '');
  if (c.length < claveMin()) return `La contraseña debe tener al menos ${claveMin()} caracteres`;
  if (new TextEncoder().encode(c).length > 72) return 'La contraseña es demasiado larga (máximo 72 bytes)';
  if (c !== c.trim()) return 'La contraseña no puede empezar ni terminar con espacios';
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(c) || !/\d/.test(c)) return 'La contraseña debe combinar letras y números';
  if (usuario && c.toLowerCase().includes(String(usuario).toLowerCase())) return 'La contraseña no puede contener el nombre de usuario';
  return '';
}

// ---- Formato ----
const fmtCop = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const fmtUsd = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt = {
  cop: (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? '-$ ' : '$ ') + fmtCop.format(Math.abs(v)); },
  usd: (n) => { const v = Number(n) || 0; return (v < 0 ? '-US$ ' : 'US$ ') + fmtUsd.format(Math.abs(v)); },
  monto: (n, moneda) => (moneda === 'USD' ? fmt.usd(n) : fmt.cop(n)),
  tasa: (n) => (n === null || n === undefined ? '—' : '$ ' + fmtUsd.format(Number(n))),
  signo: (n) => (Number(n) > 0 ? '+' : '') + fmt.cop(n),
  num: (n) => fmtCop.format(Math.round(Number(n) || 0)),
  pct: (n) => `${(Number(n) || 0).toLocaleString('es-CO', { maximumFractionDigits: 1 })}%`,
  fecha: (t) => { if (!t) return ''; const [f] = String(t).split(/[ T]/); const [y, m, d] = f.split('-'); return `${d}/${m}/${y}`; },
  fechaHora: (t) => { if (!t) return ''; const [f, h = ''] = String(t).split(/[ T]/); const [y, m, d] = f.split('-'); return `${d}/${m}/${y}${h ? ' ' + h.slice(0, 5) : ''}`; },
  fechaLarga: (t) => { if (!t) return ''; const d = aFecha(t); return d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }); },
  relativa: (t) => { if (!t) return ''; const dias = Math.round((hoyDate() - aFecha(t).setHours(0, 0, 0, 0)) / 86400000); if (dias === 0) return 'hoy'; if (dias === 1) return 'ayer'; if (dias < 0) return `en ${-dias} d`; return `hace ${dias} d`; },
};
export function aFecha(t) { const [f, h = '00:00:00'] = String(t).split(/[ T]/); const [y, m, d] = f.split('-').map(Number); const [hh = 0, mm = 0] = h.split(':').map(Number); return new Date(y, m - 1, d, hh, mm); }
export function hoyDate() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
export function hoyISO(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function sumarDias(iso, n) { const d = aFecha(iso); d.setDate(d.getDate() + n); return hoyISO(d); }
export const METODOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', tarjeta: 'Tarjeta', qr: 'Código QR', otro: 'Otro' };
// Domicilios: estado → [texto, clase de insignia]
export const ESTADOS_DOMICILIO = { recibido: ['Recibido', 'neutro'], en_preparacion: ['En preparación', 'aviso'], en_camino: ['En camino', 'camino'], entregado: ['Entregado', 'ok'], cancelado: ['Cancelado', 'peligro'] };
export const CANALES_DOMICILIO = { whatsapp: 'WhatsApp', telefono: 'Llamada', web: 'Página web', presencial: 'En el local', otro: 'Otro' };
export const TIPOS_CLIENTE = { detal: ['Detal', 'neutro'], mayorista: ['Mayorista', 'mayor'] };
export const TIPOS_RESPONSABLE = { vendedor: ['Vendedor', 'vendedor'], empleador: ['Empleador', 'empleador'], otro: ['Otro', 'neutro'] };
export const nombreMetodo = (m) => METODOS[m] || (m ? m[0].toUpperCase() + m.slice(1) : '');
export const ESTADOS_CREDITO = { al_dia: ['Al día', 'ok'], proximo: ['Próximo a vencer', 'aviso'], vencido: ['Vencido', 'peligro'], parcial: ['Parcialmente pagado', 'neutro'], pagado: ['Pagado', 'ok'], anulado: ['Anulado', 'neutro'] };
export const ESTADOS_VENTA = { confirmada: ['Confirmada', 'ok'], anulada: ['Anulada', 'peligro'], devuelta_parcial: ['Devolución parcial', 'aviso'], devuelta: ['Devuelta', 'neutro'] };
export const ESTADOS_PRODUCTO = { activo: ['Activo', 'ok'], agotado: ['Agotado', 'peligro'], descontinuado: ['Descontinuado', 'neutro'], inactivo: ['Inactivo', 'neutro'] };
export const TIPOS_PAGO = { contado: 'Contado', credito: 'Crédito', parcial: 'Pago parcial' };
export const ORIGEN_TASA = { trm: ['TRM oficial', 'ok'], mercado: ['Mercado', 'aviso'], manual: ['Manual', 'neutro'] };
export const RESULTADO = { definitivo: ['Definitivo', 'ok'], estimado: ['Estimado', 'aviso'], anulada: ['Anulada', 'peligro'] };
// Lee un número con decimales (precios en USD) desde un input.
export function leerDecimal(input) { const v = Number(String(input.value || '').replace(',', '.')); return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
export function badge(mapa, clave) { const [t, c] = mapa[clave] || [clave, 'neutro']; return html`<span class="badge ${c}">${t}</span>`; }

// ---- Dinero en formularios ----
export function leerDinero(input) { return Number(String(input.value || '').replace(/[^\d-]/g, '')) || 0; }
export function formatearDinero(input) { const v = leerDinero(input); input.value = v ? fmtCop.format(v) : ''; }
export function activarDinero(root) {
  $$('input[data-money]', root).forEach((i) => {
    if (i.dataset.listo) return;
    i.dataset.listo = '1';
    i.setAttribute('inputmode', 'numeric');
    i.addEventListener('focus', () => { const v = leerDinero(i); i.value = v ? String(v) : ''; setTimeout(() => i.select(), 0); });
    i.addEventListener('blur', () => formatearDinero(i));
    if (i.value) formatearDinero(i);
  });
}
export function datosForm(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.dataset.money !== undefined) o[el.name] = leerDinero(el);
    else o[el.name] = el.value;
  }
  return o;
}
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---- Avisos ----
export function toast(mensaje, tipo = '') {
  const c = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = mensaje;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, tipo === 'error' ? 5000 : 2800);
}
export function mostrarError(e) {
  console.error(e);
  toast(e && e.message ? e.message : 'Ocurrió un error', 'error');
}

  // ---- Modales ----
export function modal({ titulo, cuerpo, acciones = [], ancho = false, alMontar, cerrable = true }) {
  const fondo = document.createElement('div');
  fondo.className = 'modal-fondo';
  fondo.innerHTML = `<div class="modal ${ancho ? 'ancho' : ''}" role="dialog" aria-modal="true">
    <div class="cab"><h2>${esc(titulo)}</h2>${cerrable ? `<button class="btn icono chico fantasma" data-cerrar aria-label="Cerrar">${icono('x')}</button>` : ''}</div>
    <div class="cuerpo"></div>
    ${acciones.length ? '<div class="pie"></div>' : ''}
  </div>`;
  const cuerpoEl = $('.cuerpo', fondo);
  if (cuerpo instanceof HTMLElement) cuerpoEl.appendChild(cuerpo); else cuerpoEl.innerHTML = String(cuerpo || '');
  // Prevenir scrolling en el login: limitar el tamaño de la ventana modal en la página de inicio de sesión
  const body = document.body;
  if (window.location.hash === '#/login') {
    cuerpoEl.style.maxHeight = 'calc(100vh - 80px)';
    cuerpoEl.style.overflowY = 'auto';
    fondo.classList.add('scroll-limitado');
  }
  const cerrar = () => { fondo.remove(); document.body.style.overflow = ''; };
  const pie = $('.pie', fondo);
  for (const a of acciones) {
    const b = document.createElement('button');
    b.className = `btn ${a.clase || ''}`;
    b.innerHTML = a.texto;
    if (a.id) b.id = a.id;
    b.addEventListener('click', async () => {
      if (!a.alHacerClic) return cerrar();
      b.disabled = true;
      try { const r = await a.alHacerClic({ cerrar, modal: fondo, boton: b }); if (r !== false) cerrar(); } catch (e) { mostrarError(e); } finally { b.disabled = false; }
    });
    pie.appendChild(b);
  }
  if (cerrable) {
    $('[data-cerrar]', fondo).addEventListener('click', cerrar);
    fondo.addEventListener('click', (e) => { if (e.target === fondo) cerrar(); });
  }
  $('#modales').appendChild(fondo);
  document.body.style.overflow = 'hidden';
  activarDinero(fondo);
  if (alMontar) alMontar(fondo, cerrar);
  return { el: fondo, cerrar };
}
export function confirmar(mensaje, { titulo = 'Confirmar', textoOk = 'Confirmar', peligro = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      titulo, cuerpo: `<p>${esc(mensaje)}</p>`,
      acciones: [
        { texto: 'Cancelar', clase: 'suave', alHacerClic: () => { resolve(false); } },
        { texto: textoOk, clase: peligro ? 'peligro solido' : 'primario', alHacerClic: () => { resolve(true); } },
      ],
    });
    m.el.addEventListener('click', (e) => { if (e.target === m.el) resolve(false); });
  });
}
export function pedirTexto(titulo, { etiqueta = 'Motivo', placeholder = '', obligatorio = true, textoOk = 'Guardar' } = {}) {
  return new Promise((resolve) => {
    modal({
      titulo,
      cuerpo: `<div class="campo"><label>${esc(etiqueta)}</label><textarea id="pt-texto" placeholder="${esc(placeholder)}"></textarea></div>`,
      acciones: [
        { texto: 'Cancelar', clase: 'suave', alHacerClic: () => { resolve(null); } },
        { texto: textoOk, clase: 'primario', alHacerClic: ({ modal: m }) => { const v = $('#pt-texto', m).value.trim(); if (obligatorio && !v) { toast('Escribe el motivo', 'error'); return false; } resolve(v); } },
      ],
      alMontar: (m) => setTimeout(() => $('#pt-texto', m).focus(), 50),
    });
  });
}

// ---- Piezas ----
export function vacio(texto, accionHtml = '') { return html`<div class="vacio">${raw(icono('inbox'))}<p>${texto}</p>${raw(accionHtml)}</div>`; }
export function cargando(lineas = 4) { return html`<div class="card">${Array.from({ length: lineas }, (_, i) => raw(`<div class="skel" style="width:${90 - i * 15}%;margin:10px 0"></div>`))}</div>`; }
export function tabla(columnas, filas, { totales, vacioTexto = 'Sin datos' } = {}) {
  if (!filas.length) return vacio(vacioTexto);
  const celda = (c, f) => { const v = typeof c.valor === 'function' ? c.valor(f) : f[c.clave]; return c.dinero ? fmt.cop(v) : (v ?? ''); };
  return html`<div class="tabla-wrap"><table class="tabla"><thead><tr>${columnas.map((c) => html`<th class="${c.dinero || c.num ? 'n' : ''}">${c.titulo}</th>`)}</tr></thead>
    <tbody>${filas.map((f) => html`<tr>${columnas.map((c) => html`<td class="${c.dinero || c.num ? 'n' : ''}">${celda(c, f)}</td>`)}</tr>`)}</tbody>
    ${totales ? html`<tfoot><tr>${columnas.map((c, i) => html`<td class="${c.dinero || c.num ? 'n' : ''}">${i === 0 ? 'Total' : totales[c.clave] !== undefined ? (c.dinero ? fmt.cop(totales[c.clave]) : fmt.num(totales[c.clave])) : ''}</td>`)}</tr></tfoot>` : ''}
  </table></div>`;
}
// Miniatura de producto: foto (botella sobre fondo de la marca) o el ícono de botella si no tiene.
export function miniatura(p, clase = 'thumb') {
  return `<div class="${clase}">${p && p.foto ? `<img src="/api/archivos/${esc(p.foto)}" alt="" loading="lazy">` : icono('bottle', 18)}</div>`;
}
// Insignia de la tarifa aplicada a una línea (detal o mayor).
export const tarifaBadge = (t) => (t === 'mayor' ? '<span class="badge mayor">Mayor</span>' : '');
export function stockBadge(stock, minimo) { const cls = stock <= 0 ? 'cero' : stock <= (minimo || 0) ? 'bajo' : ''; return html`<span class="stock-badge ${cls}">${stock}</span>`; }

// ---- Iconos (trazos simples, 24px) ----
export const ICONOS = {
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  bag: '<path d="M6 2l-3 5v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-3-5z"/><path d="M3 7h18M16 11a4 4 0 0 1-8 0"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  card: '<rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8M19 8v8"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  whatsapp: '<path d="M21 11.5a8.4 8.4 0 0 1-12.6 7.3L3 21l2.3-5.3A8.4 8.4 0 1 1 21 11.5z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-1.7-1-1 .7a4 4 0 0 1-2.3-2.3l.7-1-1-1.7z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eye_off: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
  dollar: '<path d="M12 2v20M17 6.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  trend_up: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  trend_down: '<path d="M23 18l-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  analytics: '<path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 5-7"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17h.01"/>',
  // Marketing y asistente (2026-10-12)
  megaphone: '<path d="M3 11l18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v4M8 23h8"/>',
  mic_off: '<path d="M1 1l22 22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><path d="M12 19v4M8 23h8"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  funnel: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  chevron_down: '<path d="M6 9l6 6 6-6"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  click: '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  // Licorera (Licores Palmira)
  bottle: '<path d="M10 2h4v3.5c0 .8.4 1.6 1 2.1 1.3 1 2 2.5 2 4.1V20a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8.3c0-1.6.7-3.1 2-4.1.6-.5 1-1.3 1-2.1z"/><path d="M7 13h10"/>',
  moto: '<circle cx="5.5" cy="17" r="3"/><circle cx="18.5" cy="17" r="3"/><path d="M8.5 17h5l3-6h-4l-2-4H8"/><path d="M15 6h3l1.5 5"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 12v9h14v-9M10 21v-5h4v5"/>',
  glass: '<path d="M6 2h12l-1.5 9a4.5 4.5 0 0 1-9 0z"/><path d="M12 15.5V22M8 22h8"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};
export function icono(nombre, tam = 24) {
  return `<svg width="${tam}" height="${tam}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[nombre] || ''}</svg>`;
}

// Selector con búsqueda (clientes, proveedores, productos). `buscar(q)` devuelve [{id, titulo, sub}].
export function selectorBusqueda({ titulo, placeholder = 'Buscar…', buscar, alElegir, crearNuevo }) {
  const cuerpo = document.createElement('div');
  cuerpo.innerHTML = `<div class="buscador">${icono('search')}<input type="search" id="sb-q" placeholder="${esc(placeholder)}" autocomplete="off"></div><div id="sb-res" class="lista mt"></div>${crearNuevo ? `<button class="btn suave bloque mt" id="sb-nuevo">${icono('plus')} ${esc(crearNuevo.texto)}</button>` : ''}`;
  const m = modal({ titulo, cuerpo });
  const res = $('#sb-res', cuerpo);
  const q = $('#sb-q', cuerpo);
  const pintar = async (texto) => {
    res.innerHTML = '<div class="cargando small">Buscando…</div>';
    try {
      const items = await buscar(texto);
      if (!items.length) { res.innerHTML = String(vacio('Sin resultados')); return; }
      res.innerHTML = items.map((it) => `<a class="item" data-id="${esc(it.id)}"><div class="cuerpo"><div class="titulo">${esc(it.titulo)}</div>${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}</div>${it.fin ? `<div class="fin">${it.fin}</div>` : ''}${icono('chevron', 18)}</a>`).join('');
      $$('.item', res).forEach((a, i) => a.addEventListener('click', () => { alElegir(items[i]); m.cerrar(); }));
    } catch (e) { res.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; }
  };
  q.addEventListener('input', debounce(() => pintar(q.value.trim()), 250));
  if (crearNuevo) $('#sb-nuevo', cuerpo).addEventListener('click', () => { m.cerrar(); crearNuevo.accion(q.value.trim()); });
  pintar('');
  setTimeout(() => q.focus(), 80);
  return m;
}
