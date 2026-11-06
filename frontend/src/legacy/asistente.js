// Asistente Tino: mascota flotante con contador de pendientes, burbuja de avisos, panel de conversación con el resumen
// del día, dictado por voz (reconocimiento del navegador), lectura de respuestas (síntesis de voz), avisos del navegador
// (opcionales) y acciones que devuelve el servidor (botones para ir a una pantalla, tarjetas de pendientes, sugerencias).
// App.tsx llama a montarAsistente() cuando hay sesión y a desmontarAsistente() al cerrarla. Toda la lógica de datos y de
// permisos vive en el servidor (/api/asistente/*); aquí solo se pinta y se envía texto.
//
// Avisos: se consultan al entrar, cada 3 minutos, al volver a la pestaña y al cambiar de pantalla (máx. una vez cada 30 s).
// Cada aviso trae `claves` (una por producto, cuota, factura…); se guardan las ya conocidas por usuario para avisar solo
// de lo NUEVO (burbuja y, si el usuario lo activó, notificación del navegador) en vez de repetir lo mismo.
import { api } from '../lib/api';
import { estado, navegar } from '../lib/estado';
import { $, $$, esc, icono, toast, confirmar, fmt } from './ui.js';

const LS_BURBUJA = 'tino.burbuja';
const LS_LEER = 'tino.leer';
const LS_ESCRITORIO = 'tino.escritorio';
const SS_CONV = 'tino.conversacion';
const MAX_CARACTERES = 2000;
const INTERVALO_AVISOS = 3 * 60 * 1000;
const ESPERA_MINIMA_AVISOS = 30 * 1000;
const ESPERA_OCULTAR = 2 * 1000;
const HREF_VALIDO = /^#\/[\w\-/?=&.%]*$/;

const guardar = {
  local: { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } } },
  sesion: { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* nada */ } }, del(k) { try { sessionStorage.removeItem(k); } catch { /* nada */ } } },
};

const Reconocimiento = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;
const soportaDictado = () => !!Reconocimiento;
const soportaLectura = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
const esCelular = () => window.matchMedia('(max-width: 699px)').matches;
const reducirMovimiento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Estado del componente (un solo asistente por página).
let raiz = null;
let st = null;              // respuesta de GET /api/asistente/estado
let abierto = false;
let convId = null;
let mensajes = [];          // { id, rol: 'usuario'|'asistente', contenido, acciones, error, reintento, creado_en }
let enviando = false;
let reco = null;
let grabando = false;
let cargandoConv = false;
let av = null;              // respuesta de GET /api/asistente/avisos (pendientes, resumen del día, sugerencias)
let temporizadorAvisos = null;
let ultimaConsultaAvisos = 0;
let consultandoAvisos = null;
let idAvisoNuevo = null;    // aviso que trajo algo nuevo desde la última vez: es el que muestra la burbuja
let temporizadorOcultar = null; // auto-oculta la mascota a los 2 s sin foco (ni mouse encima)
let sobreWidget = false;
let orejaEstabaOculta = true; // estado ANTES del clic en la oreja: distingue "mostrar" de "ocultar" en el mismo gesto

const ahoraLocal = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const hora = (t) => (t ? String(t).slice(11, 16) : '');
const nombreAsistente = () => (st && st.nombre) || 'Tino';
const primerNombre = () => String((estado.usuario && estado.usuario.nombre) || '').split(' ')[0];
const vozPermitida = () => !!(st && st.voz !== false);
const avisosActivos = () => !!(st && st.avisos !== false);
const soportaEscritorio = () => typeof window !== 'undefined' && 'Notification' in window;
const claveMemoria = () => `tino.avisos.${(estado.usuario && estado.usuario.id) || 0}`;
function leerMemoria() { try { const m = JSON.parse(guardar.local.get(claveMemoria()) || 'null'); return m && typeof m === 'object' ? m : null; } catch { return null; } }
function guardarMemoria(m) { guardar.local.set(claveMemoria(), JSON.stringify(m)); }
const importantes = (lista) => (lista || []).filter((a) => a.nivel === 'alta' || a.nivel === 'media');

// ---------- Montaje / desmontaje ----------
export async function montarAsistente() {
  if (raiz) return;
  if (!estado.usuario || !estado.tiene('asistente.usar')) return;
  if (estado.config && estado.config.asistente && estado.config.asistente.activo === false) return;
  let e = null;
  try { e = await api.get('/api/asistente/estado', { silencioso: true }); } catch { return; }
  if (!e || !e.activo || raiz || !estado.usuario) return;
  st = e;
  convId = Number(guardar.sesion.get(SS_CONV)) || null;
  raiz = document.createElement('div');
  raiz.id = 'tino';
  raiz.className = 'tino';
  raiz.innerHTML = `${plantillaCerrado()}<section class="tino-panel" id="tino-panel" role="dialog" aria-label="Asistente ${esc(nombreAsistente())}" hidden></section>`;
  document.body.appendChild(raiz);
  enlazarCerrado();
  document.addEventListener('keydown', alTeclaGlobal);
  if (avisosActivos()) iniciarAvisos();
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', alMensajeSw);
  // Se llegó desde una notificación del navegador (#/…?tino=1): se abre Tino.
  if (/[?&]tino=1\b/.test(location.hash)) setTimeout(abrirPanel, 300);
}

// Se llama al cerrar sesión y cuando el servidor responde 401: quita la mascota y el panel, y olvida la conversación
// recordada en la pestaña para que no cruce a otro usuario que entre después.
export function desmontarAsistente() {
  detenerDictado();
  detenerLectura();
  detenerAvisos();
  clearTimeout(temporizadorOcultar);
  temporizadorOcultar = null; sobreWidget = false; orejaEstabaOculta = true;
  document.removeEventListener('keydown', alTeclaGlobal);
  if (navigator.serviceWorker) navigator.serviceWorker.removeEventListener('message', alMensajeSw);
  if (raiz) raiz.remove();
  raiz = null; st = null; abierto = false; convId = null; mensajes = []; enviando = false; cargandoConv = false; av = null;
  guardar.sesion.del(SS_CONV);
}
function alMensajeSw(ev) { if (ev && ev.data && ev.data.tipo === 'tino-abrir') abrirPanel(); }

// ---------- Estado cerrado ----------
// La mascota y su tarjeta arrancan ocultas (clase .oculto); la oreja queda siempre a la vista. El conjunto se muestra
// al enfocar o tocar cualquier parte del bloque (la oreja es el botón al que se puede llegar con Tab) y se vuelve a
// ocultar solo a los 3 s de quedar sin foco y sin el mouse encima.
function plantillaCerrado() {
  const conVoz = soportaDictado() && vozPermitida();
  return `<div class="tino-cerrado oculto" id="tino-cerrado">
    <button type="button" class="tino-mascota" id="tino-mascota" aria-label="Abrir el asistente ${esc(nombreAsistente())}"><img src="/icons/tino.svg" alt=""><span class="tino-contador" id="tino-contador" aria-hidden="true" hidden></span></button>
    <div class="tino-lado">
      <div class="tino-burbuja" id="tino-burbuja" hidden></div>
      <button type="button" class="tino-abrir" id="tino-abrir" aria-label="Pregúntale a ${esc(nombreAsistente())}">${icono(conVoz ? 'mic' : 'message', 18)}<span>Pregúntale a ${esc(nombreAsistente())}</span></button>
    </div>
    <button type="button" class="tino-oreja" id="tino-oreja" aria-expanded="false" aria-controls="tino-cerrado" aria-label="Mostrar a ${esc(nombreAsistente())}" title="Mostrar a ${esc(nombreAsistente())}"><img src="/icons/tino.svg" alt=""><span class="tino-contador" id="tino-oreja-n" aria-hidden="true" hidden></span></button></div>`;
}
function enlazarCerrado() {
  const c = $('#tino-cerrado', raiz);
  $('#tino-mascota', raiz).addEventListener('click', abrirPanel);
  $('#tino-abrir', raiz).addEventListener('click', abrirPanel);
  const oreja = $('#tino-oreja', raiz);
  oreja.addEventListener('pointerdown', () => { orejaEstabaOculta = c.classList.contains('oculto'); });
  oreja.addEventListener('click', () => { if (orejaEstabaOculta) mostrarCerrado(); else ocultarAhora(); orejaEstabaOculta = false; });
  c.addEventListener('focusin', mostrarCerrado);
  c.addEventListener('focusout', (e) => { if (!c.contains(e.relatedTarget)) programarOcultar(); });
  c.addEventListener('pointerenter', () => { sobreWidget = true; mostrarCerrado(); });
  c.addEventListener('pointerleave', () => { sobreWidget = false; if (!c.contains(document.activeElement)) programarOcultar(); });
  pintarBurbuja();
}
function mostrarCerrado() {
  const c = raiz && $('#tino-cerrado', raiz);
  const o = raiz && $('#tino-oreja', raiz);
  if (!c || !o || abierto) return;
  clearTimeout(temporizadorOcultar);
  c.classList.remove('oculto');
  o.setAttribute('aria-expanded', 'true');
  o.setAttribute('aria-label', `Ocultar a ${nombreAsistente()}`);
  o.title = `Ocultar a ${nombreAsistente()}`;
}
function ocultarAhora() {
  const c = raiz && $('#tino-cerrado', raiz);
  const o = raiz && $('#tino-oreja', raiz);
  if (!c || !o) return;
  clearTimeout(temporizadorOcultar);
  c.classList.add('oculto');
  o.setAttribute('aria-expanded', 'false');
  o.setAttribute('aria-label', `Mostrar a ${nombreAsistente()}`);
  o.title = `Mostrar a ${nombreAsistente()}`;
  if (c.contains(document.activeElement)) document.activeElement.blur();
  // La burbuja ya se mostró una vez: queda como vista para que no reaparezca hasta que cambien los pendientes.
  const b = $('#tino-burbuja', raiz);
  if (b && !b.hidden) marcarVistos();
}
function programarOcultar() {
  clearTimeout(temporizadorOcultar);
  temporizadorOcultar = setTimeout(() => {
    const c = raiz && $('#tino-cerrado', raiz);
    if (!c || abierto || sobreWidget || c.contains(document.activeElement)) return;
    ocultarAhora();
  }, ESPERA_OCULTAR);
}
// Con un aviso nuevo la mascota se asoma sola un momento: si nadie la enfoca, vuelve a esconderse a los 3 s.
function mostrarTemporal() { mostrarCerrado(); programarOcultar(); }
// La burbuja muestra el aviso más importante cuando hay algo que el usuario aún no ha visto; si no, la invitación
// de siempre (que se puede ocultar para siempre). Al cerrarla, al abrir Tino o cuando el bloque se oculta solo,
// ese conjunto de avisos queda como visto y la burbuja no vuelve a salir hasta que lleguen pendientes distintos.
function pintarBurbuja() {
  const b = raiz && $('#tino-burbuja', raiz);
  if (!b) return;
  const lista = importantes(av && av.avisos);
  const memoria = leerMemoria() || {};
  const conVoz = soportaDictado() && vozPermitida();
  if (lista.length && av.firma && memoria.vista !== av.firma) {
    const nuevo = idAvisoNuevo && lista.find((x) => x.id === idAvisoNuevo);
    const a = nuevo || lista[0];
    const n = lista.length;
    b.className = `tino-burbuja alerta ${a.nivel}`;
    b.innerHTML = `<button type="button" class="tino-burbuja-cuerpo" id="tino-burbuja-abrir"><b>${esc(n > 1 ? `Tienes ${n} pendientes` : 'Tienes un pendiente')}</b><p>${nuevo ? '<span class="tino-nuevo">Nuevo</span> ' : ''}${esc(a.titulo)}${a.detalle ? `<br><span>${esc(a.detalle)}</span>` : ''}</p><span class="tino-burbuja-ver">Ver el resumen</span></button><button type="button" class="tino-burbuja-x" id="tino-burbuja-x" aria-label="Marcar como visto">${icono('x', 14)}</button>`;
    b.hidden = false;
    $('#tino-burbuja-abrir', b).addEventListener('click', abrirPanel);
    $('#tino-burbuja-x', b).addEventListener('click', (e) => { e.stopPropagation(); marcarVistos(); });
    return;
  }
  b.className = 'tino-burbuja';
  b.innerHTML = `<b>¿Tienes alguna duda?</b><p>${conVoz ? 'Pregúntame por texto o por voz: inventario, ventas, pendientes y más.' : 'Pregúntame por inventario, ventas, pendientes y más.'}</p><button type="button" class="tino-burbuja-x" id="tino-burbuja-x" aria-label="Ocultar este mensaje">${icono('x', 14)}</button>`;
  // Si esta tanda de avisos ya se mostró y se ocultó, tampoco se repite la invitación: la burbuja no reaparece.
  b.hidden = guardar.local.get(LS_BURBUJA) === 'oculta' || !!(av && av.firma && memoria.vista === av.firma);
  $('#tino-burbuja-x', b).addEventListener('click', (e) => { e.stopPropagation(); b.hidden = true; guardar.local.set(LS_BURBUJA, 'oculta'); });
}
function pintarContador() {
  const c = raiz && $('#tino-contador', raiz);
  const m = raiz && $('#tino-mascota', raiz);
  if (!c || !m) return;
  const lista = importantes(av && av.avisos);
  const urgente = lista.some((a) => a.nivel === 'alta');
  c.hidden = !lista.length;
  c.textContent = lista.length > 9 ? '9+' : String(lista.length);
  c.classList.toggle('alta', urgente);
  m.setAttribute('aria-label', lista.length ? `Abrir el asistente ${nombreAsistente()}: ${lista.length} ${lista.length === 1 ? 'pendiente' : 'pendientes'}${urgente ? ', hay urgentes' : ''}` : `Abrir el asistente ${nombreAsistente()}`);
  const on = raiz && $('#tino-oreja-n', raiz);
  if (on) { on.hidden = !lista.length; on.textContent = lista.length > 9 ? '9+' : String(lista.length); on.classList.toggle('alta', urgente); }
  const bp = raiz && $('#tino-pend-n', raiz);
  if (bp) { bp.hidden = !lista.length; bp.textContent = lista.length > 9 ? '9+' : String(lista.length); }
}
function marcarVistos() {
  if (!av) return;
  idAvisoNuevo = null;
  guardarMemoria({ ...(leerMemoria() || {}), vista: av.firma });
  pintarBurbuja();
}

// ---------- Avisos: consulta periódica y notificaciones ----------
function iniciarAvisos() {
  detenerAvisos();
  consultarAvisos({ forzar: true });
  temporizadorAvisos = setInterval(() => consultarAvisos({ forzar: true }), INTERVALO_AVISOS);
  document.addEventListener('visibilitychange', alCambiarVisibilidad);
  window.addEventListener('hashchange', alCambiarPantalla);
}
function detenerAvisos() {
  if (temporizadorAvisos) clearInterval(temporizadorAvisos);
  temporizadorAvisos = null;
  document.removeEventListener('visibilitychange', alCambiarVisibilidad);
  window.removeEventListener('hashchange', alCambiarPantalla);
}
const alCambiarVisibilidad = () => { if (document.visibilityState === 'visible') consultarAvisos(); };
const alCambiarPantalla = () => consultarAvisos();
async function consultarAvisos({ forzar = false } = {}) {
  if (!raiz || !avisosActivos() || !estado.usuario) return av;
  if (consultandoAvisos) return consultandoAvisos;
  if (!forzar && Date.now() - ultimaConsultaAvisos < ESPERA_MINIMA_AVISOS) return av;
  ultimaConsultaAvisos = Date.now();
  consultandoAvisos = (async () => {
    try {
      const r = await api.get('/api/asistente/avisos', { silencioso: true });
      if (!raiz || !r || r.activo === false) return av;
      av = r;
      detectarNuevos(r);
      pintarContador();
      if (!abierto) pintarBurbuja();
      else if (!mensajes.length && !cargandoConv) pintarMensajes();
    } catch { /* sin conexión: se reintenta en la próxima consulta */ }
    return av;
  })();
  try { return await consultandoAvisos; } finally { consultandoAvisos = null; }
}
// Compara las claves de los avisos importantes con las ya conocidas: lo nuevo dispara la burbuja (y la notificación del
// navegador si el usuario la activó y la pestaña está en segundo plano). La primera vez solo se memoriza.
function detectarNuevos(r) {
  const memoria = leerMemoria();
  const actuales = importantes(r.avisos);
  const claves = [...new Set(actuales.flatMap((a) => a.claves || []))];
  if (memoria && Array.isArray(memoria.claves)) {
    const conocidas = new Set(memoria.claves);
    const nuevos = actuales.filter((a) => (a.claves || []).some((k) => !conocidas.has(k)));
    if (nuevos.length) {
      idAvisoNuevo = nuevos[0].id;
      pulsoMascota();
      if (!abierto) mostrarTemporal();
      if (document.visibilityState !== 'visible' || !abierto) notificarEscritorio(nuevos);
    }
  }
  guardarMemoria({ ...(memoria || {}), claves });
}
function pulsoMascota() {
  const m = raiz && $('#tino-mascota', raiz);
  if (!m || reducirMovimiento()) return;
  m.classList.remove('avisando');
  void m.offsetWidth;
  m.classList.add('avisando');
}
let permisoConcedido = false; // respuesta de requestPermission en esta sesión (algunos navegadores tardan en reflejarla en .permission)
const escritorioActivo = () => soportaEscritorio() && guardar.local.get(LS_ESCRITORIO) === '1' && (Notification.permission === 'granted' || permisoConcedido);
async function notificarEscritorio(nuevos) {
  if (!escritorioActivo() || document.visibilityState === 'visible') return;
  const a = nuevos[0];
  const titulo = `${nombreAsistente()} · ${nuevos.length > 1 ? `${nuevos.length} avisos nuevos` : 'Aviso nuevo'}`;
  const opciones = { body: `${a.titulo}${a.detalle ? `. ${a.detalle}` : ''}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: `tino-${a.id}`, lang: 'es-CO', data: { url: `/${HREF_VALIDO.test(a.href || '') ? a.href : '#/inicio'}` } };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg && reg.showNotification) { await reg.showNotification(titulo, opciones); return; }
  } catch { /* sin service worker: se usa la notificación directa */ }
  try {
    const n = new Notification(titulo, opciones);
    n.onclick = () => { window.focus(); abrirPanel(); n.close(); };
  } catch { /* el navegador no permite notificaciones aquí */ }
}
async function alternarEscritorio(casilla) {
  if (!casilla.checked) { guardar.local.set(LS_ESCRITORIO, '0'); return; }
  if (!soportaEscritorio()) { casilla.checked = false; return; }
  // Si el usuario ya lo había bloqueado, el navegador responde "denied" sin volver a preguntar.
  let permiso = Notification.permission;
  if (permiso !== 'granted') { try { permiso = await Notification.requestPermission(); } catch { permiso = 'denied'; } }
  permisoConcedido = permiso === 'granted';
  if (permiso !== 'granted') {
    casilla.checked = false;
    guardar.local.set(LS_ESCRITORIO, '0');
    toast('El navegador bloqueó los avisos. Permítelos en la configuración del sitio (candado junto a la dirección).', 'error');
    return;
  }
  guardar.local.set(LS_ESCRITORIO, '1');
  toast('Listo: te avisaré en el escritorio cuando haya pendientes nuevos y la app esté en segundo plano.', 'ok');
}

// ---------- Panel ----------
function plantillaPanel() {
  const disp = !!st.disponible;
  const conDictado = soportaDictado() && vozPermitida();
  const conLectura = soportaLectura() && vozPermitida();
  return `<header class="tino-cab">
      <img class="tino-avatar" src="/icons/tino.svg" alt="">
      <div class="tino-titulo"><b>${esc(nombreAsistente())}</b><small><span class="tino-negocio">Asistente de ${esc(estado.config.negocio_nombre || 'Licores Palmira')} · </span><span class="tino-estado ${disp ? 'ok' : ''}"><i aria-hidden="true"></i>${disp ? 'Listo' : 'Sin configurar'}</span></small></div>
      ${avisosActivos() ? `<button type="button" class="btn icono chico fantasma tino-pend" id="tino-pendientes" aria-label="Ver mis pendientes" title="Mis pendientes" ${disp ? '' : 'disabled'}>${icono('bell', 18)}<span class="tino-pend-n" id="tino-pend-n" hidden></span></button>` : ''}
      <button type="button" class="btn icono chico fantasma" id="tino-nueva" aria-label="Nueva conversación" title="Nueva conversación">${icono('plus', 18)}</button>
      <button type="button" class="btn icono chico fantasma" id="tino-hist" aria-label="Historial de conversaciones" title="Historial">${icono('clock', 18)}</button>
      <button type="button" class="btn icono chico fantasma" id="tino-cerrar" aria-label="Cerrar el asistente" title="Cerrar (Esc)">${icono('x', 18)}</button>
    </header>
    <div class="tino-mensajes" id="tino-mensajes" aria-live="polite" aria-relevant="additions"></div>
    <footer class="tino-pie">
      <div class="tino-transcripcion" id="tino-transcripcion" hidden></div>
      <div class="tino-entrada">
        <textarea id="tino-texto" class="tino-texto" rows="1" maxlength="${MAX_CARACTERES}" placeholder="${disp ? 'Escribe tu pregunta…' : 'Asistente no disponible'}" aria-label="Mensaje para ${esc(nombreAsistente())}" ${disp ? '' : 'disabled'}></textarea>
        ${conDictado ? `<button type="button" class="btn icono" id="tino-mic" aria-label="Dictar por voz" aria-pressed="false" title="Dictar por voz" ${disp ? '' : 'disabled'}>${icono('mic', 20)}</button>` : ''}
        <button type="button" class="btn icono primario" id="tino-enviar" aria-label="Enviar mensaje" title="Enviar" ${disp ? '' : 'disabled'}>${icono('send', 20)}</button>
      </div>
      <div class="tino-opciones">
        <div class="tino-casillas">
          ${conLectura ? `<label class="tino-leer"><input type="checkbox" id="tino-leer" ${guardar.local.get(LS_LEER) === '1' ? 'checked' : ''}> Leer respuestas</label>` : ''}
          ${avisosActivos() && soportaEscritorio() ? `<label class="tino-leer" title="Notificación del navegador cuando haya pendientes nuevos y la app esté en segundo plano"><input type="checkbox" id="tino-escritorio" ${escritorioActivo() ? 'checked' : ''}> Avisos del navegador</label>` : ''}
        </div>
        <span class="tino-pista">Enter envía · Shift+Enter salto de línea</span>
      </div>
    </footer>`;
}

async function abrirPanel() {
  if (!raiz || abierto) return;
  abierto = true;
  $('#tino-cerrado', raiz).hidden = true;
  const panel = $('#tino-panel', raiz);
  panel.innerHTML = plantillaPanel();
  panel.hidden = false;
  enlazarPanel();
  pintarContador();
  pintarMensajes();
  enfocarEntrada();
  marcarVistos();
  if (convId && !mensajes.length) await cargarConversacion(convId, { silencioso: true });
  if (avisosActivos()) { await consultarAvisos({ forzar: true }); marcarVistos(); }
}
function cerrarPanel() {
  if (!raiz || !abierto) return;
  abierto = false;
  detenerDictado();
  detenerLectura();
  $('#tino-panel', raiz).hidden = true;
  $('#tino-cerrado', raiz).hidden = false;
  pintarContador();
  pintarBurbuja();
  programarOcultar();
}
function enlazarPanel() {
  $('#tino-cerrar', raiz).addEventListener('click', cerrarPanel);
  $('#tino-nueva', raiz).addEventListener('click', nuevaConversacion);
  $('#tino-hist', raiz).addEventListener('click', mostrarHistorial);
  $('#tino-enviar', raiz).addEventListener('click', () => enviar());
  const ta = $('#tino-texto', raiz);
  ta.addEventListener('input', () => ajustarAltura(ta));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviar(); } });
  const mic = $('#tino-mic', raiz);
  if (mic) mic.addEventListener('click', alternarDictado);
  const leer = $('#tino-leer', raiz);
  if (leer) leer.addEventListener('change', () => { guardar.local.set(LS_LEER, leer.checked ? '1' : '0'); if (!leer.checked) detenerLectura(); });
  const esc2 = $('#tino-escritorio', raiz);
  if (esc2) esc2.addEventListener('change', () => alternarEscritorio(esc2));
  const pend = $('#tino-pendientes', raiz);
  if (pend) pend.addEventListener('click', () => enviar('¿Qué tengo pendiente?'));
}
function enfocarEntrada() { setTimeout(() => { const t = $('#tino-texto', raiz); if (t && !t.disabled) t.focus(); }, 60); }
function ajustarAltura(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 118) + 'px'; }
function alTeclaGlobal(e) {
  if (e.key !== 'Escape' || !abierto) return;
  // Si hay un modal abierto encima, el Esc es para él.
  if ($('#modales') && $('#modales').children.length) return;
  cerrarPanel();
}

// ---------- Mensajes ----------
// Formato ligero y seguro: primero se escapa el HTML; luego **negritas**, listas con "- " o "1. ", líneas sangradas como
// detalle del punto anterior y saltos de línea.
const enLinea = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
function formatear(texto) {
  const partes = [];
  let lista = null;
  for (const linea of esc(texto || '').split('\n')) {
    const vineta = linea.match(/^\s{0,1}[-•]\s+(.*)$/);
    const numero = linea.match(/^\s{0,1}(\d{1,2})[.)]\s+(.*)$/);
    const detalle = linea.match(/^\s{2,}(\S.*)$/);
    if (detalle && lista && lista.items.length) { lista.items[lista.items.length - 1] += `<br><span class="tino-sub">${enLinea(detalle[1])}</span>`; continue; }
    if (vineta || numero) {
      const tipo = vineta ? 'ul' : 'ol';
      if (!lista || lista.tipo !== tipo) { lista = { tipo, items: [], inicio: numero ? Number(numero[1]) : 1 }; partes.push(lista); }
      lista.items.push(enLinea(vineta ? vineta[1] : numero[2]));
    } else { lista = null; partes.push(enLinea(linea)); }
  }
  let salida = '';
  partes.forEach((p, i) => {
    if (typeof p === 'object') { salida += `<${p.tipo}${p.tipo === 'ol' && p.inicio !== 1 ? ` start="${p.inicio}"` : ''}>${p.items.map((li) => `<li>${li}</li>`).join('')}</${p.tipo}>`; return; }
    const anterior = partes[i - 1];
    if (i > 0 && typeof anterior !== 'object') salida += '<br>';
    salida += p;
  });
  return salida;
}
// Tarjeta de pendientes: cada fila lleva a la pantalla filtrada.
function plantillaAvisos(items) {
  const filas = (items || []).filter((a) => a && a.titulo).slice(0, 8).map((a) => {
    const href = HREF_VALIDO.test(a.href || '') ? a.href : '';
    const nivel = ['alta', 'media', 'info'].includes(a.nivel) ? a.nivel : 'info';
    const etiqueta = nivel === 'alta' ? 'Urgente' : nivel === 'media' ? 'Pronto' : 'Para revisar';
    const cuerpo = `<span class="tino-aviso-ico" aria-hidden="true">${icono(a.icono || 'alert', 16)}</span><span class="tino-aviso-txt"><b>${esc(a.titulo)}</b>${a.detalle ? `<small>${esc(a.detalle)}</small>` : ''}</span><span class="sr-only">${etiqueta}</span>${href ? `<span class="tino-aviso-ir" aria-hidden="true">${icono('chevron', 16)}</span>` : ''}`;
    return href ? `<a class="tino-aviso ${nivel}" href="${esc(href)}" data-ir="${esc(href)}" role="listitem">${cuerpo}</a>` : `<div class="tino-aviso ${nivel}" role="listitem">${cuerpo}</div>`;
  }).join('');
  return filas ? `<div class="tino-avisos" role="list" aria-label="Pendientes">${filas}</div>` : '';
}
const plantillaChips = (lista, etiqueta = 'Preguntas sugeridas') => (lista && lista.length ? `<div class="tino-chips" role="list" aria-label="${esc(etiqueta)}">${lista.slice(0, 4).map((x) => `<button type="button" class="tino-chip" role="listitem" data-chip="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : '');
// Separa las acciones guardadas en botones/tarjetas y sugerencias.
function separarAcciones(acciones) {
  const lista = Array.isArray(acciones) ? acciones : [];
  const sug = lista.find((a) => a && a.tipo === 'sugerencias');
  return { acciones: lista.filter((a) => a && a.tipo !== 'sugerencias'), sugerencias: sug && Array.isArray(sug.items) ? sug.items.filter((x) => typeof x === 'string') : [] };
}
function plantillaMensaje(m) {
  if (m.rol === 'usuario') return `<div class="tino-msg usuario"><div><div class="tino-globo">${formatear(m.contenido)}</div><div class="tino-hora">${esc(hora(m.creado_en))}</div></div></div>`;
  const avatar = `<img class="tino-avatar chico" src="/icons/tino.svg" alt="">`;
  if (m.error) return `<div class="tino-msg asistente">${avatar}<div><div class="tino-error" role="alert"><span>${esc(m.error)}</span>${m.reintento ? `<button type="button" class="btn chico suave" data-reintentar="${esc(m.id)}">${icono('refresh', 14)} Reintentar</button>` : ''}</div><div class="tino-hora">${esc(hora(m.creado_en))}</div></div></div>`;
  const lista = m.acciones || [];
  const tarjeta = lista.filter((a) => a && a.tipo === 'avisos').map((a) => plantillaAvisos(a.items)).join('');
  const botones = lista.filter((a) => a && a.tipo === 'navegar' && typeof a.hash === 'string' && HREF_VALIDO.test(a.hash)).map((a) => `<a class="btn chico suave" href="${esc(a.hash)}" data-ir="${esc(a.hash)}">${icono('external', 14)} ${esc(/^(ver|ir|abrir|registrar|buscar|hacer)\b/i.test(a.etiqueta || '') ? a.etiqueta : `Ir a ${a.etiqueta || a.hash}`)}</a>`).join('');
  // Con la tarjeta de pendientes, la lista del texto (que sirve para la lectura en voz alta) no se repite en pantalla.
  const texto = tarjeta ? String(m.contenido || '').split('\n').filter((l) => !/^- \*\*/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim() : m.contenido;
  return `<div class="tino-msg asistente">${avatar}<div><div class="tino-globo">${formatear(texto)}${tarjeta}${botones ? `<div class="tino-accion">${botones}</div>` : ''}</div><div class="tino-hora">${esc(hora(m.creado_en))}</div></div></div>`;
}
// Saludo al abrir: resumen del día y pendientes, calculados en el servidor (no gasta mensajes ni IA).
function plantillaBienvenida() {
  const avatar = '<img class="tino-avatar chico" src="/icons/tino.svg" alt="">';
  const nombre = primerNombre();
  if (avisosActivos() && !av) return `<div class="tino-msg asistente">${avatar}<div><div class="tino-globo">¡Hola${nombre ? ', ' + esc(nombre) : ''}! Estoy revisando tus pendientes…</div></div></div>`;
  if (!av || !avisosActivos()) return `<div class="tino-msg asistente">${avatar}<div><div class="tino-globo">¡Hola${nombre ? ', ' + esc(nombre) : ''}! Soy ${esc(nombreAsistente())}. Pregúntame por el inventario, las ventas de cualquier día, la caja, la cartera o cómo hacer algo en la aplicación.</div></div></div>`;
  const lista = av.avisos || [];
  const intro = `<b>${esc(av.saludo || '¡Hola!')}.</b> ${esc(av.fecha || '')}.${(av.lineas || []).length ? `<br>${(av.lineas || []).map((l) => formatear(l)).join('<br>')}` : ''}`;
  const pend = lista.length ? `<div class="tino-pend-cab">${esc(lista.length === 1 ? 'Tienes 1 pendiente' : `Tienes ${lista.length} pendientes`)}</div>${plantillaAvisos(lista)}` : '<div class="tino-pend-cab ok">Todo al día: no tienes pendientes importantes.</div>';
  return `<div class="tino-msg asistente">${avatar}<div><div class="tino-globo">${intro}${pend}</div></div></div>`;
}
function pintarMensajes() {
  const cont = $('#tino-mensajes', raiz);
  if (!cont) return;
  let h = '';
  if (!st.disponible) {
    const admin = estado.usuario && estado.usuario.rol === 'admin';
    h += `<div class="alerta aviso tino-aviso">${esc(st.motivo || 'El asistente no está disponible por ahora.')}${admin ? `<div class="mt small">Cómo activarlo: agrega la variable en las variables de entorno del servidor (hPanel › Node.js o archivo <span class="mono">.env</span>) y reinicia la aplicación, o elige otro proveedor o modelo en <a href="#/configuracion/asistente" data-ir="#/configuracion/asistente">Configuración › Asistente Tino</a>.</div>` : ''}</div>`;
  }
  if (cargandoConv) h += '<div class="cargando">Cargando conversación…</div>';
  else if (!mensajes.length) {
    h += plantillaBienvenida();
    const sug = (av && av.sugerencias && av.sugerencias.length ? av.sugerencias : st.sugerencias) || [];
    if (st.disponible) h += plantillaChips(sug, 'Preguntas de ejemplo');
  }
  for (const m of mensajes) h += plantillaMensaje(m);
  const ultimo = mensajes[mensajes.length - 1];
  if (!enviando && st.disponible && ultimo && ultimo.rol === 'asistente' && !ultimo.error && ultimo.sugerencias && ultimo.sugerencias.length) h += plantillaChips(ultimo.sugerencias);
  if (enviando) h += `<div class="tino-pensando" id="tino-pensando"><img class="tino-avatar chico" src="/icons/tino.svg" alt=""><span>${esc(nombreAsistente())} está pensando<i>.</i><i>.</i><i>.</i></span></div>`;
  cont.innerHTML = h;
  $$('[data-chip]', cont).forEach((b) => b.addEventListener('click', () => enviar(b.dataset.chip)));
  $$('[data-reintentar]', cont).forEach((b) => b.addEventListener('click', () => reintentar(b.dataset.reintentar)));
  $$('[data-ir]', cont).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); irA(a.dataset.ir); }));
  // Bienvenida: se lee desde arriba (saludo y resumen primero). Respuesta larga: se muestra desde su comienzo.
  if (!mensajes.length) { cont.scrollTop = 0; return; }
  const ultimaRespuesta = [...cont.querySelectorAll('.tino-msg.asistente')].pop();
  if (!enviando && ultimaRespuesta && ultimaRespuesta.offsetHeight > cont.clientHeight * 0.8) cont.scrollTop = Math.max(0, ultimaRespuesta.offsetTop - 8);
  else cont.scrollTop = cont.scrollHeight;
}
function fijarEnviando(valor) {
  const b = $('#tino-enviar', raiz); const t = $('#tino-texto', raiz); const mic = $('#tino-mic', raiz);
  if (b) b.disabled = valor || !st.disponible;
  if (t) t.disabled = valor || !st.disponible;
  if (mic) mic.disabled = valor || !st.disponible;
}

// El usuario pidió explícitamente ir a una pantalla: en ese caso sí se navega sin esperar a que toque el botón.
const pidioNavegar = (t) => /\b(ll[eé]vame|ll[eé]vanos|[aá]bre(me|nos)?|abrir|ir a|vamos a|ve a|mu[eé]strame la pantalla)\b/i.test(t);

async function enviar(textoDado) {
  if (!raiz || !st.disponible || enviando) return;
  const ta = $('#tino-texto', raiz);
  const texto = String(textoDado ?? (ta ? ta.value : '')).trim();
  if (!texto) return;
  if (texto.length > MAX_CARACTERES) { toast(`El mensaje es demasiado largo (máximo ${MAX_CARACTERES} caracteres)`, 'error'); return; }
  detenerDictado();
  detenerLectura();
  if (ta) { ta.value = ''; ajustarAltura(ta); }
  mensajes.push({ id: 'u' + Date.now(), rol: 'usuario', contenido: texto, creado_en: ahoraLocal() });
  enviando = true;
  fijarEnviando(true);
  pintarMensajes();
  try {
    const r = await api.post('/api/asistente/mensajes', { conversacion_id: convId, mensaje: texto, contexto: { ruta: location.hash || '#/inicio', titulo: document.title } });
    convId = r.conversacion_id;
    guardar.sesion.set(SS_CONV, String(convId));
    mensajes.push({ id: 'a' + Date.now(), rol: 'asistente', contenido: r.respuesta, acciones: r.acciones || [], sugerencias: Array.isArray(r.sugerencias) ? r.sugerencias : [], creado_en: r.creado_en || ahoraLocal() });
    consultarAvisos();
    if (leerActivo()) leer(r.respuesta);
    const nav = (r.acciones || []).find((a) => a.tipo === 'navegar' && a.hash);
    if (nav && pidioNavegar(texto)) irA(nav.hash);
  } catch (e) {
    if (e && e.datos && e.datos.conversacion_id) { convId = e.datos.conversacion_id; guardar.sesion.set(SS_CONV, String(convId)); }
    if (e && e.status === 503 && (e.codigo === 'asistente_no_configurado' || e.codigo === 'asistente_desactivado')) { st.disponible = false; st.motivo = e.message; }
    const puedeReintentar = !(e && (e.status === 400 || e.status === 403));
    mensajes.push({ id: 'e' + Date.now(), rol: 'asistente', error: mensajeError(e), reintento: puedeReintentar ? texto : null, creado_en: ahoraLocal() });
  } finally {
    enviando = false;
    fijarEnviando(false);
    pintarMensajes();
    enfocarEntrada();
  }
}
function mensajeError(e) {
  if (!e) return 'Ocurrió un error inesperado.';
  if (e.status === 0) return 'Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.';
  if (e.status === 429) return e.message || 'Alcanzaste el límite de mensajes por hora. Intenta más tarde.';
  return e.message || 'No se pudo obtener respuesta.';
}
function reintentar(id) {
  const i = mensajes.findIndex((m) => m.id === id);
  if (i < 0) return;
  const texto = mensajes[i].reintento;
  mensajes.splice(i, 1);
  // Quita también el mensaje del usuario que quedó sin respuesta para no duplicarlo en pantalla.
  if (i > 0 && mensajes[i - 1] && mensajes[i - 1].rol === 'usuario' && mensajes[i - 1].contenido === texto) mensajes.splice(i - 1, 1);
  enviar(texto);
}
function irA(hash) {
  if (!hash) return;
  navegar(hash);
  if (esCelular()) cerrarPanel();
}

// ---------- Conversaciones ----------
function nuevaConversacion() {
  convId = null;
  guardar.sesion.del(SS_CONV);
  mensajes = [];
  detenerLectura();
  pintarMensajes();
  enfocarEntrada();
}
async function cargarConversacion(id, { silencioso = false } = {}) {
  cargandoConv = true;
  pintarMensajes();
  try {
    const c = await api.get(`/api/asistente/conversaciones/${id}`);
    convId = c.id;
    guardar.sesion.set(SS_CONV, String(convId));
    mensajes = [];
    let ultimoUsuario = null;
    for (const m of c.mensajes || []) {
      if (m.rol === 'usuario') { ultimoUsuario = m.contenido; mensajes.push({ id: 'm' + m.id, rol: 'usuario', contenido: m.contenido, creado_en: m.creado_en }); }
      else if (m.rol === 'asistente') {
        if (m.error) mensajes.push({ id: 'm' + m.id, rol: 'asistente', error: m.error, reintento: ultimoUsuario, creado_en: m.creado_en });
        else { const x = separarAcciones(m.acciones); mensajes.push({ id: 'm' + m.id, rol: 'asistente', contenido: m.contenido, acciones: x.acciones, sugerencias: x.sugerencias, creado_en: m.creado_en }); }
      }
    }
  } catch (e) {
    convId = null; guardar.sesion.del(SS_CONV); mensajes = [];
    if (!silencioso) toast(e.message || 'No se pudo abrir la conversación', 'error');
  } finally {
    cargandoConv = false;
    pintarMensajes();
  }
}
async function mostrarHistorial() {
  const cont = $('#tino-mensajes', raiz);
  if (!cont) return;
  detenerDictado();
  cont.innerHTML = '<div class="cargando">Cargando…</div>';
  let lista = [];
  try { lista = await api.get('/api/asistente/conversaciones'); } catch (e) { cont.innerHTML = `<div class="tino-error" role="alert">${esc(e.message || 'No se pudo cargar el historial')}</div>`; return; }
  cont.innerHTML = `<div class="tino-hist-cab"><b>Tus conversaciones</b><button type="button" class="btn chico suave" id="tino-hist-volver">${icono('back', 14)} Volver</button></div>
    ${lista.length ? `<div class="lista">${lista.map((c) => `<div class="item ${c.id === convId ? 'activo' : ''}"><button type="button" class="tino-hist-item" data-abrir="${c.id}" aria-label="Abrir conversación: ${esc(c.titulo || 'Conversación')}"><div class="titulo">${esc(c.titulo || 'Conversación')}</div><div class="sub">${esc(c.ultimo || 'Sin respuesta todavía')}</div><div class="xs muted">${esc(fmt.fechaHora(c.actualizado_en))} · ${Number(c.n_mensajes) || 0} mensajes</div></button><button type="button" class="btn icono chico fantasma" data-borrar="${c.id}" aria-label="Eliminar conversación" title="Eliminar">${icono('trash', 16)}</button></div>`).join('')}</div>` : '<div class="vacio"><p>Aún no tienes conversaciones guardadas.</p></div>'}`;
  $('#tino-hist-volver', cont).addEventListener('click', pintarMensajes);
  $$('[data-abrir]', cont).forEach((b) => b.addEventListener('click', () => cargarConversacion(Number(b.dataset.abrir))));
  $$('[data-borrar]', cont).forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmar('¿Eliminar esta conversación? No se puede deshacer.', { textoOk: 'Eliminar', peligro: true })) return;
    try {
      await api.del(`/api/asistente/conversaciones/${b.dataset.borrar}`);
      if (Number(b.dataset.borrar) === convId) { convId = null; guardar.sesion.del(SS_CONV); mensajes = []; }
      toast('Conversación eliminada', 'ok');
      mostrarHistorial();
    } catch (e) { toast(e.message || 'No se pudo eliminar', 'error'); }
  }));
}

// ---------- Voz: dictado (reconocimiento) ----------
function alternarDictado() {
  if (grabando) { detenerDictado(); return; }
  if (!Reconocimiento || !raiz) return;
  const ta = $('#tino-texto', raiz);
  const tr = $('#tino-transcripcion', raiz);
  const base = ta.value.trim() ? ta.value.trim() + ' ' : '';
  try {
    reco = new Reconocimiento();
  } catch { toast('Tu navegador no permite el dictado por voz', 'error'); return; }
  reco.lang = 'es-CO';
  reco.continuous = false;
  reco.interimResults = true;
  reco.maxAlternatives = 1;
  reco.onresult = (ev) => {
    let final = ''; let parcial = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) final += r[0].transcript; else parcial += r[0].transcript; }
    if (final) { ta.value = (base + final).trim(); ajustarAltura(ta); }
    tr.textContent = parcial ? `Escuchando: ${parcial}` : (final ? 'Listo. Revisa el texto y envíalo.' : 'Escuchando…');
  };
  reco.onerror = (ev) => {
    const codigo = ev && ev.error;
    detenerDictado();
    if (codigo === 'not-allowed' || codigo === 'service-not-allowed') toast('No hay permiso para usar el micrófono. Actívalo en el navegador.', 'error');
    else if (codigo === 'no-speech') toast('No escuché nada. Intenta de nuevo.', '');
    else if (codigo && codigo !== 'aborted') toast('No se pudo reconocer la voz. Intenta de nuevo.', 'error');
  };
  reco.onend = () => {
    grabando = false; reco = null;
    marcarMic();
    setTimeout(() => { const t = $('#tino-transcripcion', raiz); if (t) t.hidden = true; }, 1500);
    enfocarEntrada();
  };
  try {
    reco.start();
    grabando = true;
    marcarMic();
    tr.hidden = false;
    tr.textContent = 'Escuchando…';
  } catch { grabando = false; reco = null; marcarMic(); toast('No se pudo iniciar el dictado', 'error'); }
}
function detenerDictado() {
  if (reco) { try { reco.stop(); } catch { /* ya detenido */ } }
  grabando = false;
  marcarMic();
}
function marcarMic() {
  const mic = raiz && $('#tino-mic', raiz);
  if (!mic) return;
  mic.classList.toggle('grabando', grabando);
  mic.setAttribute('aria-pressed', String(grabando));
  mic.setAttribute('aria-label', grabando ? 'Detener el dictado' : 'Dictar por voz');
  mic.innerHTML = icono(grabando ? 'mic_off' : 'mic', 20);
}

// ---------- Voz: lectura de respuestas (síntesis) ----------
const leerActivo = () => { const c = raiz && $('#tino-leer', raiz); return !!(c && c.checked && soportaLectura()); };
function elegirVoz() {
  const voces = window.speechSynthesis.getVoices() || [];
  for (const pref of ['es-co', 'es-mx', 'es-es', 'es-419', 'es']) { const v = voces.find((x) => x.lang && x.lang.toLowerCase().replace('_', '-').startsWith(pref)); if (v) return v; }
  return null;
}
function leer(texto) {
  if (!soportaLectura()) return;
  const limpio = String(texto || '').replace(/\*\*/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!limpio) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(limpio);
    const voz = elegirVoz();
    if (voz) u.voice = voz;
    u.lang = voz ? voz.lang : 'es-CO';
    u.rate = reducirMovimiento() ? 1 : 1.02;
    window.speechSynthesis.speak(u);
  } catch { /* sin voz disponible */ }
}
function detenerLectura() { if (soportaLectura()) { try { window.speechSynthesis.cancel(); } catch { /* nada */ } } }
