// Escáner de códigos de barras con la cámara. Usa la API nativa BarcodeDetector cuando existe
// (Chrome/Android) y, si no, la librería ZXing incluida en /vendor (iPhone/Safari y escritorio).
import { modal, toast, $, icono } from './ui.js';

let zxingCargado = null;
function cargarZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingCargado) {
    zxingCargado = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/vendor/zxing.min.js';
      s.onload = () => res(window.ZXing);
      s.onerror = () => rej(new Error('No se pudo cargar el lector de códigos'));
      document.head.appendChild(s);
    });
  }
  return zxingCargado;
}

const FORMATOS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'itf', 'codabar'];

export function escanear({ titulo = 'Escanear código' } = {}) {
  return new Promise((resolve) => {
    let stream = null;
    let activo = true;
    let lectorZx = null;
    const cuerpo = document.createElement('div');
    cuerpo.innerHTML = `<div class="escaner"><video playsinline muted autoplay></video><div class="marco"></div></div>
      <p class="muted small mt center" id="esc-estado">Apunta la cámara al código de barras</p>
      <div class="campo mt"><label>O escribe el código manualmente</label><div class="row"><input type="text" id="esc-manual" inputmode="numeric" placeholder="Código de barras o serial" class="grow"><button class="btn primario" id="esc-ok">Usar</button></div></div>`;
    const video = $('video', cuerpo);
    const terminar = (valor) => {
      if (!activo) return;
      activo = false;
      try { if (lectorZx) lectorZx.reset(); } catch { /* nada */ }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      m.cerrar();
      resolve(valor || null);
    };
    const m = modal({ titulo, cuerpo, alMontar: (el, cerrar) => { el.addEventListener('click', (e) => { if (e.target === el) terminar(null); }); $('[data-cerrar]', el).addEventListener('click', () => terminar(null)); } });
    $('#esc-ok', cuerpo).addEventListener('click', () => { const v = $('#esc-manual', cuerpo).value.trim(); if (v) terminar(v); });
    $('#esc-manual', cuerpo).addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) terminar(v); } });

    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no permite usar la cámara. Escribe el código manualmente.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        video.srcObject = stream;
        await video.play();
        if ('BarcodeDetector' in window) {
          let formatos = FORMATOS;
          try { const sop = await window.BarcodeDetector.getSupportedFormats(); formatos = FORMATOS.filter((f) => sop.includes(f)); } catch { /* usar lista completa */ }
          const detector = new window.BarcodeDetector({ formats: formatos });
          const ciclo = async () => {
            if (!activo) return;
            try {
              const codigos = await detector.detect(video);
              if (codigos.length && codigos[0].rawValue) { if (navigator.vibrate) navigator.vibrate(60); return terminar(codigos[0].rawValue.trim()); }
            } catch { /* cuadro no listo */ }
            setTimeout(ciclo, 180);
          };
          ciclo();
        } else {
          $('#esc-estado', cuerpo).textContent = 'Cargando lector…';
          const ZXing = await cargarZxing();
          const hints = new Map();
          hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
          lectorZx = new ZXing.BrowserMultiFormatReader(hints, 300);
          $('#esc-estado', cuerpo).textContent = 'Apunta la cámara al código de barras';
          lectorZx.decodeFromStream(stream, video, (res) => {
            if (res && activo) { if (navigator.vibrate) navigator.vibrate(60); terminar(res.getText().trim()); }
          });
        }
      } catch (e) {
        $('#esc-estado', cuerpo).textContent = e.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Puedes escribir el código manualmente.' : (e.message || 'No se pudo abrir la cámara');
        $('#esc-estado', cuerpo).classList.add('neg');
      }
    })();
  });
}

export function botonEscanear(alLeer, { clase = 'btn icono', titulo = 'Escanear' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = clase;
  b.title = titulo;
  b.innerHTML = icono('scan');
  b.addEventListener('click', async () => { const c = await escanear(); if (c) alLeer(c); else toast('Escaneo cancelado'); });
  return b;
}
