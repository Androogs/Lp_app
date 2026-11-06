// Gráficas SVG propias (sin dependencias ni paso de build): líneas/áreas, barras agrupadas, barras horizontales,
// anillo y minigráficas. Reglas: marcas finas, una sola escala por gráfica, cuadrícula discreta, leyenda cuando hay
// dos o más series, tooltips con textContent (nunca innerHTML con datos) y colores por variables CSS:
// --viz-1 = ámbar Palmira (serie principal), crema y neutros cálidos para el contexto. Cada gráfica se redibuja al cambiar el ancho.
import { esc, fmt, aFecha, hoyISO } from './ui.js';

export const COLORES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)'];
export const color = (i) => COLORES[Math.min(i, COLORES.length - 1)];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Formato compacto para ejes: 1,2 M · 850 k · 12
export function compacto(n) {
  const v = Number(n) || 0; const a = Math.abs(v); const s = v < 0 ? '-' : '';
  if (a >= 1e9) return s + (a / 1e9).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' mil M';
  if (a >= 1e6) return s + (a / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M';
  if (a >= 1e3) return s + (a / 1e3).toLocaleString('es-CO', { maximumFractionDigits: a >= 1e5 ? 0 : 1 }) + ' k';
  return s + a.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

function ticks(min, max, n = 4) {
  if (max <= min) max = min + 1;
  const bruto = (max - min) / n;
  const p = Math.pow(10, Math.floor(Math.log10(bruto)));
  const paso = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= bruto) || 10 * p;
  const ini = Math.floor(min / paso) * paso; const fin = Math.ceil(max / paso) * paso;
  const out = [];
  for (let v = ini; v <= fin + paso / 2; v += paso) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
const anchoTexto = (t) => String(t).length * 6.6;
const recortar = (t, max) => { t = String(t ?? ''); return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t; };

// Monta una gráfica que depende del ancho del contenedor y la redibuja cuando cambia.
function montar(cont, dibujar) {
  cont.classList.add('viz');
  let ancho = 0;
  const pintar = () => {
    const w = Math.floor(cont.clientWidth);
    if (w < 40 || w === ancho) return;
    ancho = w;
    const r = dibujar(w);
    cont.innerHTML = r.svg + '<div class="viz-tip" role="status" hidden></div>';
    if (r.activar) r.activar(cont.querySelector('svg'), cont.querySelector('.viz-tip'));
  };
  pintar();
  if (window.ResizeObserver) { if (cont._ro) cont._ro.disconnect(); const ro = new ResizeObserver(() => pintar()); ro.observe(cont); cont._ro = ro; }
  return { repintar: () => { ancho = 0; pintar(); } };
}

// Tooltip: primera fila = título; siguientes = serie (clave de color) + valor en negrita.
function tip(el, cont, x, y, filas) {
  el.innerHTML = '';
  filas.forEach((f, i) => {
    const d = document.createElement('div'); d.className = i === 0 ? 'viz-tip-t' : 'viz-tip-r';
    if (f.color) { const k = document.createElement('i'); k.style.background = f.color; d.appendChild(k); }
    const s = document.createElement('span'); s.textContent = f.etiqueta; d.appendChild(s);
    if (f.valor !== undefined && f.valor !== null) { const b = document.createElement('b'); b.textContent = f.valor; d.appendChild(b); }
    el.appendChild(d);
  });
  el.hidden = false;
  const W = cont.clientWidth; const tw = el.offsetWidth; const th = el.offsetHeight;
  const left = Math.max(2, Math.min(W - tw - 2, x - tw / 2));
  let top = y - th - 12; if (top < 0) top = y + 16;
  el.style.left = `${left}px`; el.style.top = `${top}px`;
}
function ocultarTip(el) { el.hidden = true; }

export function sinDatos(mensaje = 'Sin datos en el periodo', detalle = '') {
  return `<div class="viz-vacio"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg><p>${esc(mensaje)}</p>${detalle ? `<p class="xs muted">${esc(detalle)}</p>` : ''}</div>`;
}

export function leyenda(series, { tipo = 'rect' } = {}) {
  return `<div class="viz-leyenda">${series.map((s, i) => `<span><i class="${tipo}" style="background:${s.color || color(i)}"></i>${esc(s.nombre)}</span>`).join('')}</div>`;
}

// ---------- Líneas / áreas ----------
export function lineas(cont, { etiquetas = [], series = [], alto = 220, formato = fmt.cop, area = true, tituloTip = null, minCero = true, aria = 'Gráfica de líneas' } = {}) {
  const n = etiquetas.length;
  if (!n || !series.length || series.every((s) => (s.valores || []).every((v) => !v))) { cont.classList.add('viz'); cont.innerHTML = sinDatos(); return null; }
  const titulo = tituloTip || ((i) => etiquetas[i]);
  return montar(cont, (W) => {
    const H = alto;
    const todos = series.flatMap((s) => s.valores.map((v) => Number(v) || 0));
    let min = minCero ? Math.min(0, ...todos) : Math.min(...todos);
    let max = Math.max(...todos);
    if (max <= min) max = min + 1;
    const tk = ticks(min, max, 4); min = tk[0]; max = tk[tk.length - 1];
    const padL = 10 + Math.max(...tk.map((t) => anchoTexto(compacto(t)))), padR = 14, padT = 14, padB = 26;
    const pw = Math.max(20, W - padL - padR), ph = H - padT - padB;
    const x = (i) => (n === 1 ? padL + pw / 2 : padL + (i * pw) / (n - 1));
    const y = (v) => padT + ph * (1 - (v - min) / (max - min));
    const grid = tk.map((t) => `<line class="viz-grid" x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="viz-tick" x="${padL - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(compacto(t))}</text>`).join('');
    const paso = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 58))));
    const ejeX = etiquetas.map((e, i) => {
      const esUltimo = i === n - 1;
      if (!esUltimo && (i % paso !== 0 || n - 1 - i < paso / 2)) return '';
      return `<text class="viz-tick" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : esUltimo ? 'end' : 'middle'}">${esc(e)}</text>`;
    }).join('');
    const y0 = y(Math.max(min, 0));
    const trazos = series.map((s, si) => {
      const c = s.color || color(si);
      const d = s.valores.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(Number(v) || 0).toFixed(1)}`).join(' ');
      const relleno = area && si === 0 && n > 1 ? `<path d="${d} L${x(n - 1).toFixed(1)} ${y0.toFixed(1)} L${x(0).toFixed(1)} ${y0.toFixed(1)} Z" fill="${c}" fill-opacity="0.12"/>` : '';
      const ultimo = `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(Number(s.valores[n - 1]) || 0).toFixed(1)}" r="4" fill="${c}" stroke="var(--bg)" stroke-width="2"/>`;
      return `${relleno}<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${ultimo}`;
    }).join('');
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" tabindex="0">${grid}${ejeX}${trazos}<line class="viz-cursor oculto" x1="0" x2="0" y1="${padT}" y2="${padT + ph}"/><g class="viz-marcas"></g><rect class="viz-hit" x="${padL}" y="${padT}" width="${pw}" height="${ph}" fill="transparent"/></svg>`;
    const activar = (svgEl, tipEl) => {
      const hit = svgEl.querySelector('.viz-hit'); const cursor = svgEl.querySelector('.viz-cursor'); const marcas = svgEl.querySelector('.viz-marcas');
      let idx = -1;
      const mostrar = (i) => {
        idx = i; const px = x(i);
        cursor.setAttribute('x1', px.toFixed(1)); cursor.setAttribute('x2', px.toFixed(1)); cursor.classList.remove('oculto');
        marcas.innerHTML = series.map((s, si) => `<circle cx="${px.toFixed(1)}" cy="${y(Number(s.valores[i]) || 0).toFixed(1)}" r="4.5" fill="${s.color || color(si)}" stroke="var(--bg)" stroke-width="2"/>`).join('');
        tip(tipEl, cont, px, Math.min(...series.map((s) => y(Number(s.valores[i]) || 0))), [{ etiqueta: titulo(i) }, ...series.map((s, si) => ({ color: s.color || color(si), etiqueta: s.nombre, valor: formato(s.valores[i] || 0) }))]);
      };
      const ocultar = () => { cursor.classList.add('oculto'); marcas.innerHTML = ''; ocultarTip(tipEl); idx = -1; };
      hit.addEventListener('pointermove', (e) => { const r = svgEl.getBoundingClientRect(); const rel = e.clientX - r.left; const i = n === 1 ? 0 : Math.round(((rel - padL) / pw) * (n - 1)); mostrar(Math.max(0, Math.min(n - 1, i))); });
      hit.addEventListener('pointerleave', ocultar);
      svgEl.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); mostrar(Math.min(n - 1, idx + 1)); } else if (e.key === 'ArrowLeft') { e.preventDefault(); mostrar(Math.max(0, idx - 1)); } else if (e.key === 'Escape') ocultar(); });
      svgEl.addEventListener('blur', ocultar);
    };
    return { svg, activar };
  });
}

// ---------- Barras verticales (agrupadas) ----------
export function barras(cont, { etiquetas = [], series = [], alto = 220, formato = fmt.cop, tituloTip = null, aria = 'Gráfica de barras' } = {}) {
  const n = etiquetas.length; const k = series.length;
  if (!n || !k || series.every((s) => (s.valores || []).every((v) => !v))) { cont.classList.add('viz'); cont.innerHTML = sinDatos(); return null; }
  const titulo = tituloTip || ((i) => etiquetas[i]);
  return montar(cont, (W) => {
    const H = alto;
    const todos = series.flatMap((s) => s.valores.map((v) => Number(v) || 0));
    let min = Math.min(0, ...todos), max = Math.max(0, ...todos);
    if (max <= min) max = min + 1;
    const tk = ticks(min, max, 4); min = tk[0]; max = tk[tk.length - 1];
    const padL = 10 + Math.max(...tk.map((t) => anchoTexto(compacto(t)))), padR = 10, padT = 14, padB = 26;
    const pw = Math.max(20, W - padL - padR), ph = H - padT - padB;
    const slot = pw / n;
    const grupo = Math.min(slot * 0.72, k * 26);
    const bw = Math.max(2, Math.min(24, (grupo - 2 * (k - 1)) / k));
    const y = (v) => padT + ph * (1 - (v - min) / (max - min));
    const y0 = y(0);
    const grid = tk.map((t) => `<line class="viz-grid ${t === 0 ? 'base' : ''}" x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="viz-tick" x="${padL - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(compacto(t))}</text>`).join('');
    const paso = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 58))));
    const ejeX = etiquetas.map((e, i) => (i % paso === 0 || i === n - 1 ? `<text class="viz-tick" x="${(padL + slot * i + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(e)}</text>` : '')).join('');
    const barra = (x, v, c) => {
      const h = Math.abs(y(v) - y0); if (h < 0.5) return '';
      const r = Math.min(4, bw / 2, h);
      if (v >= 0) { const yt = y0 - h; return `<path d="M${x.toFixed(1)} ${y0.toFixed(1)} V${(yt + r).toFixed(1)} Q${x.toFixed(1)} ${yt.toFixed(1)} ${(x + r).toFixed(1)} ${yt.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)} ${yt.toFixed(1)} ${(x + bw).toFixed(1)} ${(yt + r).toFixed(1)} V${y0.toFixed(1)} Z" fill="${c}"/>`; }
      const yb = y0 + h; return `<path d="M${x.toFixed(1)} ${y0.toFixed(1)} V${(yb - r).toFixed(1)} Q${x.toFixed(1)} ${yb.toFixed(1)} ${(x + r).toFixed(1)} ${yb.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)} ${yb.toFixed(1)} ${(x + bw).toFixed(1)} ${(yb - r).toFixed(1)} V${y0.toFixed(1)} Z" fill="${c}"/>`;
    };
    const grupos = etiquetas.map((e, i) => {
      const x0 = padL + slot * i + (slot - (bw * k + 2 * (k - 1))) / 2;
      return `<g class="viz-grupo" data-i="${i}"><rect class="viz-hit" x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${ph}" fill="transparent"/>${series.map((s, si) => barra(x0 + si * (bw + 2), Number(s.valores[i]) || 0, s.color || color(si))).join('')}</g>`;
    }).join('');
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" tabindex="0">${grid}${ejeX}${grupos}</svg>`;
    const activar = (svgEl, tipEl) => {
      const gs = [...svgEl.querySelectorAll('.viz-grupo')];
      let idx = -1;
      const mostrar = (i) => {
        idx = i; gs.forEach((g, j) => g.classList.toggle('viz-sel', j === i));
        const cx = padL + slot * i + slot / 2; const top = Math.min(...series.map((s) => y(Math.max(0, Number(s.valores[i]) || 0))));
        tip(tipEl, cont, cx, top, [{ etiqueta: titulo(i) }, ...series.map((s, si) => ({ color: s.color || color(si), etiqueta: s.nombre, valor: formato(s.valores[i] || 0) }))]);
      };
      const ocultar = () => { gs.forEach((g) => g.classList.remove('viz-sel')); ocultarTip(tipEl); idx = -1; };
      gs.forEach((g) => { g.addEventListener('pointerenter', () => mostrar(Number(g.dataset.i))); g.addEventListener('pointermove', () => { if (idx !== Number(g.dataset.i)) mostrar(Number(g.dataset.i)); }); });
      svgEl.addEventListener('pointerleave', ocultar);
      svgEl.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); mostrar(Math.min(n - 1, idx + 1)); } else if (e.key === 'ArrowLeft') { e.preventDefault(); mostrar(Math.max(0, idx - 1)); } else if (e.key === 'Escape') ocultar(); });
      svgEl.addEventListener('blur', ocultar);
    };
    return { svg, activar };
  });
}

// ---------- Barras horizontales (ranking) ----------
export function barrasH(cont, { items = [], formato = fmt.num, color: c = color(0), filaAlto = 30, aria = 'Ranking', vacio = 'Sin datos en el periodo' } = {}) {
  if (!items.length || items.every((it) => !it.valor)) { cont.classList.add('viz'); cont.innerHTML = sinDatos(vacio); return null; }
  return montar(cont, (W) => {
    const padT = 6, padB = 6;
    const H = padT + padB + items.length * filaAlto;
    const labelW = Math.min(190, Math.max(90, W * 0.4));
    const valueW = 12 + Math.max(...items.map((it) => anchoTexto(formato(it.valor))));
    const barX = labelW + 10; const barW = Math.max(20, W - barX - valueW - 8);
    const max = Math.max(1, ...items.map((it) => Math.abs(Number(it.valor) || 0)));
    const maxChars = Math.max(6, Math.floor(labelW / 6.8));
    const filas = items.map((it, i) => {
      const yTop = padT + i * filaAlto; const cy = yTop + filaAlto / 2; const v = Math.abs(Number(it.valor) || 0);
      const w = v > 0 ? Math.max(2, (v / max) * barW) : 0; const r = Math.min(4, w / 2);
      const bar = w ? `<path d="M${barX} ${(cy - 7).toFixed(1)} H${(barX + w - r).toFixed(1)} Q${(barX + w).toFixed(1)} ${(cy - 7).toFixed(1)} ${(barX + w).toFixed(1)} ${(cy - 7 + r).toFixed(1)} V${(cy + 7 - r).toFixed(1)} Q${(barX + w).toFixed(1)} ${(cy + 7).toFixed(1)} ${(barX + w - r).toFixed(1)} ${(cy + 7).toFixed(1)} H${barX} Z" fill="${it.color || c}"/>` : '';
      const texto = `<text class="viz-etq" x="${labelW}" y="${(cy + 4).toFixed(1)}" text-anchor="end">${esc(recortar(it.etiqueta, maxChars))}</text><text class="viz-val" x="${(barX + w + 6).toFixed(1)}" y="${(cy + 4).toFixed(1)}">${esc(formato(it.valor))}</text>`;
      const fila = `<g class="viz-fila" data-i="${i}"><rect class="viz-fila-bg" x="0" y="${yTop}" width="${W}" height="${filaAlto}" rx="6"/>${bar}${texto}</g>`;
      return it.href ? `<a href="${esc(it.href)}">${fila}</a>` : fila;
    }).join('');
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${filas}</svg>`;
    const activar = (svgEl, tipEl) => {
      svgEl.querySelectorAll('.viz-fila').forEach((g) => {
        const it = items[Number(g.dataset.i)];
        g.addEventListener('pointerenter', () => { g.classList.add('viz-sel'); const r = g.getBoundingClientRect(), cr = cont.getBoundingClientRect(); tip(tipEl, cont, r.left - cr.left + r.width / 2, r.top - cr.top, [{ etiqueta: it.etiqueta }, { color: it.color || c, etiqueta: it.nombreValor || 'Valor', valor: formato(it.valor) }, ...(it.sub ? [{ etiqueta: it.sub }] : [])]); });
        g.addEventListener('pointerleave', () => { g.classList.remove('viz-sel'); ocultarTip(tipEl); });
      });
    };
    return { svg, activar };
  });
}

// ---------- Anillo (parte del todo, máximo 6 segmentos: el resto se agrupa en "Otros") ----------
export function anillo(cont, { items = [], formato = fmt.num, centro = null, colores = COLORES, maxSegmentos = 6, vacio = 'Sin datos', sufijo = '' } = {}) {
  cont.classList.add('viz', 'viz-anillo');
  const limpios = items.filter((it) => Number(it.valor) > 0).sort((a, b) => b.valor - a.valor);
  const total = limpios.reduce((s, it) => s + Number(it.valor), 0);
  if (!total) { cont.innerHTML = sinDatos(vacio); return; }
  let lista = limpios;
  if (limpios.length > maxSegmentos) { const cabeza = limpios.slice(0, maxSegmentos - 1); const resto = limpios.slice(maxSegmentos - 1); lista = [...cabeza, { etiqueta: 'Otros', valor: resto.reduce((s, it) => s + Number(it.valor), 0), detalle: resto.map((it) => it.etiqueta).join(', ') }]; }
  const R = 70, G = 24, C = 2 * Math.PI * R;
  let off = 0;
  const arcos = lista.map((it, i) => {
    const frac = Number(it.valor) / total; const len = Math.max(0, C * frac - 2);
    const el = `<circle class="viz-arco" data-i="${i}" cx="100" cy="100" r="${R}" fill="none" stroke="${colores[i] || colores[colores.length - 1]}" stroke-width="${G}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 100 100)"/>`;
    off += C * frac; return el;
  }).join('');
  const cValor = centro ? centro.valor : formato(total);
  const cEt = centro ? centro.etiqueta : 'Total';
  const svg = `<svg width="200" height="200" viewBox="0 0 200 200" role="img" aria-label="Distribución"><circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--bg-2)" stroke-width="${G}"/>${arcos}<text class="viz-centro" x="100" y="98" text-anchor="middle">${esc(recortar(cValor, 12))}</text><text class="viz-centro-et" x="100" y="116" text-anchor="middle">${esc(recortar(cEt, 20))}</text></svg>`;
  const filas = lista.map((it, i) => `<li data-i="${i}"><i style="background:${colores[i] || colores[colores.length - 1]}"></i><span class="viz-li-et">${esc(it.etiqueta)}</span><b>${esc(formato(it.valor))}${sufijo}</b><span class="viz-li-pct">${(Math.round((Number(it.valor) * 1000) / total) / 10).toLocaleString('es-CO')} %</span></li>`).join('');
  cont.innerHTML = `${svg}<ul class="viz-lista">${filas}</ul><div class="viz-tip" role="status" hidden></div>`;
  const tipEl = cont.querySelector('.viz-tip');
  const arcosEl = [...cont.querySelectorAll('.viz-arco')]; const lis = [...cont.querySelectorAll('li')];
  const sel = (i, on) => { arcosEl.forEach((a, j) => a.classList.toggle('viz-sel', on && j === i)); lis.forEach((l, j) => l.classList.toggle('viz-sel', on && j === i)); };
  const mostrar = (i, ref) => { const it = lista[i]; sel(i, true); const r = ref.getBoundingClientRect(), cr = cont.getBoundingClientRect(); tip(tipEl, cont, r.left - cr.left + r.width / 2, r.top - cr.top, [{ etiqueta: it.etiqueta }, { color: colores[i] || colores[colores.length - 1], etiqueta: `${(Math.round((Number(it.valor) * 1000) / total) / 10).toLocaleString('es-CO')} % del total`, valor: formato(it.valor) + sufijo }, ...(it.detalle ? [{ etiqueta: it.detalle }] : [])]); };
  arcosEl.forEach((a, i) => { a.addEventListener('pointerenter', () => mostrar(i, a)); a.addEventListener('pointerleave', () => { sel(i, false); ocultarTip(tipEl); }); });
  lis.forEach((l, i) => { l.addEventListener('pointerenter', () => mostrar(i, l)); l.addEventListener('pointerleave', () => { sel(i, false); ocultarTip(tipEl); }); });
}

// ---------- Minigráfica (sparkline, sin ejes) ----------
export function minigrafica(valores = [], { ancho = 120, alto = 34, color: c = 'var(--viz-1)' } = {}) {
  const v = valores.map((x) => Number(x) || 0);
  if (v.length < 2 || v.every((x) => !x)) return '';
  const max = Math.max(...v), min = Math.min(0, ...v); const rango = max - min || 1;
  const x = (i) => (i * (ancho - 4)) / (v.length - 1) + 2; const y = (n) => 3 + (alto - 7) * (1 - (n - min) / rango);
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(n).toFixed(1)}`).join(' ');
  return `<svg class="viz-mini" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" aria-hidden="true"><path d="${d} L${x(v.length - 1).toFixed(1)} ${alto - 2} L2 ${alto - 2} Z" fill="${c}" fill-opacity="0.14"/><path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(v[v.length - 1]).toFixed(1)}" r="2.6" fill="${c}"/></svg>`;
}

// ---------- Reagrupar una serie diaria por semana o mes (en el cliente, sin volver a consultar) ----------
export function reagrupar(puntos, modo) {
  if (!puntos.length || modo === 'dia' || !/^\d{4}-\d{2}-\d{2}$/.test(puntos[0].clave)) return puntos;
  const clave = (f) => {
    if (modo === 'mes') return f.slice(0, 7);
    const d = aFecha(f); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return hoyISO(d);
  };
  const etq = (k) => (modo === 'mes' ? `${MESES[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}` : `${k.slice(8, 10)}/${k.slice(5, 7)}`);
  const m = new Map();
  for (const p of puntos) {
    const k = clave(p.clave);
    if (!m.has(k)) m.set(k, { clave: k, etiqueta: etq(k) });
    const b = m.get(k);
    for (const [campo, v] of Object.entries(p)) if (typeof v === 'number') b[campo] = (b[campo] || 0) + v;
  }
  return [...m.values()];
}
