'use strict';
// Utilidades de lenguaje para el motor local de Tino (sin IA): normalización del español, raíces de palabras para
// comparar singular/plural, formato colombiano de dinero y fechas, e interpretación de periodos escritos en lenguaje
// natural ("ayer", "el lunes", "15 de octubre", "la semana pasada", "del 1 al 15 de octubre", "últimos 7 días"…).
const { hoy, aFecha, sumarDias, sumarMeses, diasEntre, rangoPeriodo } = require('../../util');

// ---------- Normalización ----------
// Minúsculas, sin tildes ni diéresis; conserva letras, números y los separadores de fecha.
function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!,;:"“”'’()[\]{}*+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Raíz simple que se aplica igual a la pregunta y a los productos: así "cargadores" y "cargador", "cables" y "cable",
// "estuches" y "estuche" quedan iguales. Las palabras con números (A15, 20W, 256GB) no se tocan.
function raiz(w) {
  let r = String(w || '');
  if (r.length <= 3 || /\d/.test(r)) return r;
  if (r.endsWith('s')) r = r.slice(0, -1);
  if (r.length > 3 && r.endsWith('e')) r = r.slice(0, -1);
  return r;
}

const PALABRAS_VACIAS = new Set(('de del la las el los lo un una unos unas y o u a al en para por con sin que q cual cuales quien quienes ' +
  'cuanto cuanta cuantos cuantas cuant cuanta hay quedan queda quedo quedaron tengo tenemos tienes tiene tienen tenes ' +
  'me mi mis nos te tu su sus se le les es son esta estan este estos estas eso esa ese ya aun todavia ahora actualmente actual ' +
  'dime decime dame muestrame mostrar muestra quiero quisiera saber ver revisar consultar consulta favor porfa porfavor ' +
  'por favor necesito podrias puedes puede hola tino oye mira como cuando donde mas menos muy bien solo tambien ' +
  'stock inventario unidad unidades existencia existencias disponible disponibles disponibilidad producto productos articulo articulos ' +
  'item items cosa cosas total aproximadamente').split(/\s+/));

// Tokens útiles de un texto ya normalizado (sin palabras vacías), en su forma de raíz.
function tokens(n, { extraVacias } = {}) {
  return String(n || '')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !PALABRAS_VACIAS.has(t) && !(extraVacias && extraVacias.has(t)) && (t.length >= 2 || /\d/.test(t)))
    .map(raiz);
}

// Distancia de edición acotada (para tolerar errores de digitación como "cargdor").
function distancia(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i; let minFila = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
      if (prev[j] < minFila) minFila = prev[j];
    }
    if (minFila > max) return max + 1;
  }
  return prev[b.length];
}

// ---------- Formato colombiano ----------
const FMT_NUM = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const FMT_TASA = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cop = (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? '-$ ' : '$ ') + FMT_NUM.format(Math.abs(v)); };
const usd = (n) => { const v = Number(n) || 0; return (v < 0 ? '-US$ ' : 'US$ ') + FMT_TASA.format(Math.abs(v)); };
const num = (n) => FMT_NUM.format(Math.round(Number(n) || 0));
const tasa = (n) => '$ ' + FMT_TASA.format(Number(n) || 0);
const pct = (n) => `${(Number(n) || 0).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;
const plural = (n, uno, varios) => `${num(n)} ${Number(n) === 1 ? uno : varios}`;
const unidades = (n) => plural(n, 'unidad', 'unidades');

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaCorta = (f) => { if (!f) return ''; const [y, m, d] = String(f).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
// Día y mes; el año solo si no es el actual.
const diaMes = (f) => { if (!f) return ''; const [y, m, d] = String(f).slice(0, 10).split('-'); return Number(y) === new Date().getFullYear() ? `${d}/${m}` : `${d}/${m}/${y}`; };
const horaDe = (f) => (f && String(f).length >= 16 ? String(f).slice(11, 16) : '');
function fechaLarga(f, { conAnio = false } = {}) {
  const d = aFecha(String(f).slice(0, 10));
  const anio = conAnio || d.getFullYear() !== new Date().getFullYear() ? ` de ${d.getFullYear()}` : '';
  return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}${anio}`;
}
// "hoy", "ayer", "el lunes 2 de noviembre" o "el 15 de octubre".
function cuandoFue(f) {
  const h = hoy();
  const dia = String(f).slice(0, 10);
  if (dia === h) return 'hoy';
  if (dia === sumarDias(h, -1)) return 'ayer';
  const dif = diasEntre(dia, h);
  if (dif > 0 && dif < 7) return `el ${fechaLarga(dia)}`;
  return `el ${fechaLarga(dia).replace(/^\S+ /, '')}`;
}
const capitalizar = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const saludoHora = (d = new Date()) => { const hh = d.getHours(); return hh < 12 ? 'Buenos días' : hh < 19 ? 'Buenas tardes' : 'Buenas noches'; };

// ---------- Periodos en lenguaje natural ----------
const MES_NUM = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, sept: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const RX_MES = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|sept|octubre|noviembre|diciembre)';
const DIA_SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valida = (y, m, d) => { const f = new Date(y, m - 1, d); return f.getFullYear() === y && f.getMonth() === m - 1 && f.getDate() === d; };
const finDeMes = (y, m) => new Date(y, m, 0).getDate();

// Si el usuario no dice el año, se toma el más reciente que no quede en el futuro.
function anioPara(m, d, base) {
  const b = aFecha(base);
  let y = b.getFullYear();
  if (iso(y, m, d || 1) > base) y -= 1;
  return y;
}
function rangoMes(m, y, h) {
  const desde = iso(y, m, 1);
  let hasta = iso(y, m, finDeMes(y, m));
  if (hasta > h) hasta = h;
  return { desde, hasta };
}
function etiquetaRango(desde, hasta) {
  if (desde === hasta) return cuandoFue(desde);
  return `del ${diaMes(desde)} al ${diaMes(hasta)}`;
}

// Devuelve { desde, hasta, etiqueta, coincidencia } o null. `n` es texto normalizado.
function interpretarPeriodo(n, base = hoy()) {
  const t = ` ${n} `;
  const h = base;
  const r = (desde, hasta, etiqueta, coincidencia) => ({ desde, hasta: hasta > h ? h : hasta, etiqueta, coincidencia: coincidencia.trim() });
  let m;

  // Rango: "del 1 al 15 de octubre", "entre el 3 y el 10 de octubre de 2026", "del 20 de septiembre al 5 de octubre"
  m = t.match(new RegExp(`(?:del|desde el|desde|entre el|entre)\\s+(?<![a-z0-9])(\\d{1,2})(?:\\s+de\\s+${RX_MES})?\\s+(?:al|hasta el|hasta|y el|y)\\s+(\\d{1,2})\\s+de\\s+${RX_MES}(?:\\s+(?:de|del)\\s+(\\d{4}))?`));
  if (m) {
    const m2 = MES_NUM[m[4]]; const m1 = m[2] ? MES_NUM[m[2]] : m2;
    const d1 = Number(m[1]); const d2 = Number(m[3]);
    const y2 = m[5] ? Number(m[5]) : anioPara(m2, d2, h);
    const y1 = m1 > m2 ? y2 - 1 : y2;
    if (valida(y1, m1, d1) && valida(y2, m2, d2) && iso(y1, m1, d1) <= iso(y2, m2, d2)) {
      const desde = iso(y1, m1, d1); const hasta = iso(y2, m2, d2);
      return r(desde, hasta, etiquetaRango(desde, hasta > h ? h : hasta), m[0]);
    }
  }
  // Fecha ISO 2026-10-15
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m && valida(+m[1], +m[2], +m[3])) { const f = iso(+m[1], +m[2], +m[3]); return r(f, f, cuandoFue(f), m[0]); }
  // Fecha 15/10, 15/10/2026, 15-10-26
  m = t.match(/(?:^|\s)(?:el\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?=\s)/);
  if (m) {
    const d = +m[1]; const mm = +m[2];
    let y = m[3] ? +m[3] : anioPara(mm, d, h);
    if (y < 100) y += 2000;
    if (valida(y, mm, d)) { const f = iso(y, mm, d); return r(f, f, cuandoFue(f), m[0]); }
  }
  // "15 de octubre", "el 15 de octubre de 2025", "octubre 15"
  m = t.match(new RegExp(`(?:\\bel\\s+(?:dia\\s+)?)?(?<![a-z0-9])(\\d{1,2})\\s+(?:de\\s+)?${RX_MES}(?:\\s+(?:de|del)\\s+(\\d{4}))?`));
  if (m) {
    const d = +m[1]; const mm = MES_NUM[m[2]]; const y = m[3] ? +m[3] : anioPara(mm, d, h);
    if (valida(y, mm, d)) { const f = iso(y, mm, d); return r(f, f, cuandoFue(f), m[0]); }
  }
  m = t.match(new RegExp(`${RX_MES}\\s+(\\d{1,2})(?!\\d)`));
  if (m) {
    const mm = MES_NUM[m[1]]; const d = +m[2]; const y = anioPara(mm, d, h);
    if (valida(y, mm, d)) { const f = iso(y, mm, d); return r(f, f, cuandoFue(f), m[0]); }
  }
  // "el día 15" (del mes en curso o del anterior si aún no llega)
  m = t.match(/\bel\s+dia\s+(\d{1,2})\b/);
  if (m) {
    const b = aFecha(h); let y = b.getFullYear(); let mm = b.getMonth() + 1; const d = +m[1];
    if (iso(y, mm, d) > h) { mm -= 1; if (mm < 1) { mm = 12; y -= 1; } }
    if (valida(y, mm, d)) { const f = iso(y, mm, d); return r(f, f, cuandoFue(f), m[0]); }
  }
  // Últimos N días / semanas / meses
  m = t.match(/\b(?:los\s+)?ultim[oa]s\s+(\d{1,3})\s+(dias|semanas|meses)\b/);
  if (m) {
    const k = +m[1]; const u = m[2];
    const desde = u === 'dias' ? sumarDias(h, -(k - 1)) : u === 'semanas' ? sumarDias(h, -(7 * k - 1)) : sumarMeses(h, -k);
    return r(desde, h, `en los últimos ${k} ${u === 'dias' ? 'días' : u}`, m[0]);
  }
  m = t.match(/\b(?:la\s+)?ultima\s+semana\b/);
  if (m) return r(sumarDias(h, -6), h, 'en los últimos 7 días', m[0]);
  m = t.match(/\b(?:el\s+)?ultimo\s+mes\b/);
  if (m) return r(sumarDias(h, -29), h, 'en los últimos 30 días', m[0]);
  // Semana pasada (lunes a domingo anteriores)
  m = t.match(/\b(?:la\s+)?(?:semana\s+pasada|semana\s+anterior|otra\s+semana)\b/);
  if (m) {
    const lunes = rangoPeriodo('semana', aFecha(h)).desde;
    const desde = sumarDias(lunes, -7); const hasta = sumarDias(lunes, -1);
    return r(desde, hasta, `la semana pasada (${diaMes(desde)} al ${diaMes(hasta)})`, m[0]);
  }
  m = t.match(/\b(?:esta\s+semana|en\s+la\s+semana|de\s+la\s+semana|la\s+semana|semanal)\b/);
  if (m) return r(rangoPeriodo('semana', aFecha(h)).desde, h, 'esta semana', m[0]);
  // Mes pasado / este mes / nombre del mes
  m = t.match(/\b(?:el\s+)?(?:mes\s+pasado|mes\s+anterior)\b/);
  if (m) {
    const b = aFecha(h); let y = b.getFullYear(); let mm = b.getMonth(); if (mm < 1) { mm = 12; y -= 1; }
    const x = rangoMes(mm, y, h);
    return r(x.desde, x.hasta, `el mes pasado (${MESES[mm - 1]})`, m[0]);
  }
  m = t.match(new RegExp(`(?:\\b(?:en|de|durante|del\\s+mes\\s+de|el\\s+mes\\s+de|para)\\s+)?${RX_MES}(?:\\s+(?:de|del)\\s+(\\d{4}))?\\b`));
  if (m) {
    const mm = MES_NUM[m[1]]; const y = m[2] ? +m[2] : anioPara(mm, 1, h);
    const x = rangoMes(mm, y, h);
    return r(x.desde, x.hasta, `en ${MESES[mm - 1]}${y !== aFecha(h).getFullYear() ? ` de ${y}` : ''}`, m[0]);
  }
  m = t.match(/\b(?:este\s+mes|del\s+mes|en\s+el\s+mes|lo\s+que\s+va\s+del\s+mes|el\s+mes|mensual|en\s+el\s+mes\s+actual)\b/);
  if (m) return r(rangoPeriodo('mes', aFecha(h)).desde, h, 'este mes', m[0]);
  // Año
  m = t.match(/\b(?:el\s+)?(?:ano\s+pasado|ano\s+anterior)\b/);
  if (m) { const y = aFecha(h).getFullYear() - 1; return r(`${y}-01-01`, `${y}-12-31`, `en ${y}`, m[0]); }
  m = t.match(/\b(?:este\s+ano|del\s+ano|en\s+el\s+ano|en\s+lo\s+que\s+va\s+del\s+ano|anual)\b/);
  if (m) return r(rangoPeriodo('anio', aFecha(h)).desde, h, 'este año', m[0]);
  m = t.match(/\b(?:en|de|del|durante)\s+(?:el\s+)?(20\d{2})\b/);
  if (m) { const y = +m[1]; return r(`${y}-01-01`, `${y}-12-31`, `en ${y}`, m[0]); }
  // Días relativos
  m = t.match(/\b(?:antier|anteayer|antes\s+de\s+ayer)\b/);
  if (m) { const f = sumarDias(h, -2); return r(f, f, `antier (${fechaLarga(f)})`, m[0]); }
  m = t.match(/\bayer\b/);
  if (m) { const f = sumarDias(h, -1); return r(f, f, 'ayer', m[0]); }
  m = t.match(/\b(?:hoy|el\s+dia\s+de\s+hoy|en\s+el\s+dia|del\s+dia|hasta\s+ahora|en\s+lo\s+que\s+va\s+del\s+dia)\b/);
  if (m) return r(h, h, 'hoy', m[0]);
  // Día de la semana: "el lunes", "el martes pasado", "este viernes"
  m = t.match(/\b(?:el\s+|este\s+|el\s+pasado\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)(\s+pasado|\s+anterior)?\b/);
  if (m) {
    const objetivo = DIA_SEMANA[m[1]];
    const actual = aFecha(h).getDay();
    let atras = (actual - objetivo + 7) % 7;
    if (m[2] && atras === 0) atras = 7;
    const f = sumarDias(h, -atras);
    return r(f, f, atras === 0 ? 'hoy' : `el ${fechaLarga(f)}`, m[0]);
  }
  // Todo el historial
  m = t.match(/\b(?:desde\s+siempre|desde\s+el\s+inicio|desde\s+que\s+empezamos|historico|en\s+total|todo\s+el\s+tiempo)\b/);
  if (m) return r('2000-01-01', h, 'desde el inicio', m[0]);
  return null;
}

// Quita del texto lo que se usó como fecha, para que "15 de octubre" no se confunda con un producto.
function sinPeriodo(n, periodo) {
  if (!periodo || !periodo.coincidencia) return n;
  return ` ${n} `.replace(` ${periodo.coincidencia} `, ' ').replace(periodo.coincidencia, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  normalizar, raiz, tokens, distancia, PALABRAS_VACIAS,
  cop, usd, num, tasa, pct, plural, unidades, fechaCorta, diaMes, fechaLarga, horaDe, cuandoFue, capitalizar, saludoHora, DIAS, MESES,
  interpretarPeriodo, sinPeriodo,
};
