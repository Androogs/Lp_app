/* Licores Palmira · Seguimiento web (se incrusta en la página web de la licorera, no en el panel).
 * Envía eventos anónimos al panel de gestión: visita, producto consultado, clic en contacto y formulario.
 * Configuración: window.PALMIRA_SEGUIMIENTO = { token, endpoint } (la inyecta /api/publico/marketing/seguimiento.js) o los
 * atributos data-token y data-endpoint de la etiqueta <script>. No usa cookies: guarda un id de visitante y los parámetros
 * UTM en localStorage durante 30 días. Compatible con navegadores antiguos (sin módulos ni sintaxis moderna). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.document) return;
  if (window.__palmiraSeguimientoCargado) return;
  window.__palmiraSeguimientoCargado = true;

  var script = document.currentScript || (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var conf = window.PALMIRA_SEGUIMIENTO || {};
  var token = conf.token || (script && script.getAttribute('data-token')) || '';
  var endpoint = conf.endpoint || (script && script.getAttribute('data-endpoint')) || '';
  if (!endpoint && script && script.src) { try { var u = new URL(script.src); endpoint = u.origin + '/api/publico/marketing/eventos'; } catch (e) { endpoint = ''; } }
  if (!token || !endpoint) { if (window.console && console.warn) console.warn('[Licores Palmira] seguimiento sin token o sin endpoint; no se enviarán eventos.'); return; }

  var DIAS = 30;
  var ms = DIAS * 24 * 60 * 60 * 1000;
  function leer(clave) { try { var raw = window.localStorage.getItem(clave); if (!raw) return null; var o = JSON.parse(raw); if (o && o.hasta && o.hasta < Date.now()) { window.localStorage.removeItem(clave); return null; } return o ? o.valor : null; } catch (e) { return null; } }
  function guardar(clave, valor) { try { window.localStorage.setItem(clave, JSON.stringify({ valor: valor, hasta: Date.now() + ms })); } catch (e) { /* sin almacenamiento */ } }
  function idAleatorio() { var s = ''; var c = 'abcdefghijklmnopqrstuvwxyz0123456789'; for (var i = 0; i < 20; i++) s += c.charAt(Math.floor(Math.random() * c.length)); return 'v' + Date.now().toString(36) + s; }

  // Visitante anónimo (se renueva cada 30 días de inactividad)
  var visitante = leer('palmira.visitante');
  if (!visitante) visitante = idAleatorio();
  guardar('palmira.visitante', visitante);

  // UTM: los de la dirección actual pisan a los guardados; se conservan 30 días para atribuir visitas posteriores.
  var CLAVES = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var utm = leer('palmira.utm') || {};
  try {
    var qs = window.location.search.replace(/^\?/, '').split('&');
    var nuevos = {}; var hay = false;
    for (var i = 0; i < qs.length; i++) {
      var par = qs[i].split('=');
      var k = decodeURIComponent(par[0] || '');
      if (CLAVES.indexOf(k) >= 0 && par[1]) { nuevos[k] = decodeURIComponent(par.slice(1).join('=').replace(/\+/g, ' ')).slice(0, 120); hay = true; }
    }
    if (hay) { utm = nuevos; guardar('palmira.utm', utm); }
  } catch (e) { /* dirección rara */ }

  var enviando = {};
  function enviar(tipo, extra) {
    var cuerpo = { token: token, tipo: tipo, visitante: visitante, pagina: String(window.location.href).slice(0, 500), referente: String(document.referrer || '').slice(0, 500) };
    for (var i = 0; i < CLAVES.length; i++) if (utm[CLAVES[i]]) cuerpo[CLAVES[i]] = utm[CLAVES[i]];
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined && extra[k] !== null && extra[k] !== '') cuerpo[k] = extra[k];
    var json = JSON.stringify(cuerpo);
    // Evita duplicados del mismo tipo+producto en la misma carga (por ejemplo, doble ejecución del script).
    var clave = tipo + ':' + (cuerpo.producto_texto || '') + ':' + (extra && extra.datos && extra.datos.destino ? extra.datos.destino : '');
    if (enviando[clave] && Date.now() - enviando[clave] < 1500) return;
    enviando[clave] = Date.now();
    try {
      // text/plain = petición "simple" (sin preflight) y compatible con sendBeacon al salir de la página.
      if (navigator.sendBeacon && tipo === 'clic_contacto') { var ok = navigator.sendBeacon(endpoint, new Blob([json], { type: 'text/plain' })); if (ok) return; }
      if (window.fetch) { window.fetch(endpoint, { method: 'POST', mode: 'cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: json }).catch(function () {}); return; }
      var x = new XMLHttpRequest(); x.open('POST', endpoint, true); x.setRequestHeader('Content-Type', 'text/plain'); x.send(json);
    } catch (e) { /* nunca rompe la página */ }
  }

  function productoDePagina() {
    if (window.PALMIRA_PRODUCTO) return String(window.PALMIRA_PRODUCTO).slice(0, 200);
    var el = document.querySelector('[data-palmira-producto]');
    return el ? String(el.getAttribute('data-palmira-producto') || el.textContent || '').trim().slice(0, 200) : '';
  }
  function alCargar() {
    enviar('visita', { datos: { titulo: String(document.title || '').slice(0, 200) } });
    var producto = productoDePagina();
    if (producto) enviar('producto', { producto_texto: producto });
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(alCargar, 0);
  else document.addEventListener('DOMContentLoaded', alCargar);

  // Clics en contacto: enlaces de WhatsApp, teléfono, correo o cualquier elemento con data-palmira-contacto.
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document && !(el.getAttribute && (el.getAttribute('href') || el.hasAttribute('data-palmira-contacto')))) el = el.parentNode;
    if (!el || el === document || !el.getAttribute) return;
    var href = String(el.getAttribute('href') || '');
    var esContacto = el.hasAttribute('data-palmira-contacto') || /^(https?:\/\/)?(api\.|web\.)?(wa\.me|whatsapp\.com|chat\.whatsapp\.com)/i.test(href) || /^tel:/i.test(href) || /^mailto:/i.test(href);
    if (!esContacto) return;
    var destino = /wa\.me|whatsapp/i.test(href) ? 'whatsapp' : /^tel:/i.test(href) ? 'telefono' : /^mailto:/i.test(href) ? 'correo' : (el.getAttribute('data-palmira-contacto') || 'contacto');
    enviar('clic_contacto', { producto_texto: productoDePagina() || undefined, datos: { destino: destino, texto: String(el.textContent || '').trim().slice(0, 120), href: href.slice(0, 300) } });
  }, true);

  // Formularios marcados con data-palmira-formulario: crean un cliente potencial con nombre, teléfono, correo y mensaje.
  // Los recortes coinciden con los del servidor (que de todos modos recorta, nunca descarta, lo que llegue más largo).
  var LIMITES = { nombre: 160, name: 160, telefono: 40, phone: 40, tel: 40, whatsapp: 40, celular: 40, email: 160, correo: 160, mensaje: 2000, message: 2000, comentario: 2000, producto: 200, producto_id: 20 };
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-palmira-formulario')) return;
    var datos = {};
    var campos = ['nombre', 'name', 'telefono', 'phone', 'tel', 'whatsapp', 'celular', 'email', 'correo', 'mensaje', 'message', 'comentario', 'producto', 'producto_id'];
    for (var i = 0; i < f.elements.length; i++) {
      var c = f.elements[i];
      if (!c.name || c.type === 'password' || c.type === 'hidden' && campos.indexOf(c.name) < 0) continue;
      if (campos.indexOf(c.name) >= 0) datos[c.name] = String(c.value || '').trim().slice(0, LIMITES[c.name] || 300);
    }
    datos.formulario = String(f.getAttribute('data-palmira-formulario') || f.getAttribute('id') || f.getAttribute('name') || 'formulario').slice(0, 80);
    enviar('formulario', { producto_texto: datos.producto || productoDePagina() || undefined, datos: datos });
  }, true);

  // Uso manual desde la página: window.PALMIRA.evento('conversacion', { producto_texto: '...', datos: {...} })
  window.PALMIRA = window.PALMIRA || {};
  window.PALMIRA.evento = function (tipo, extra) { if (['visita', 'producto', 'clic_contacto', 'formulario', 'conversacion'].indexOf(tipo) >= 0) enviar(tipo, extra || {}); };
  window.PALMIRA.visitante = visitante;
})();
