// Captura de fotos y documentos desde el celular: cámara, galería o archivos (incluye PDF).
// Las imágenes se reducen en el navegador (máx. 1600 px, JPEG 0.85) para subir rápido.

export function elegirArchivo({ capturar = false, aceptar = 'image/*,application/pdf', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = aceptar;
    if (multiple) input.multiple = true;
    if (capturar) input.capture = 'environment';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => { const files = [...input.files]; input.remove(); resolve(multiple ? files : files[0] || null); });
    // Si el usuario cancela, no hay evento fiable: limpiamos al volver el foco.
    window.addEventListener('focus', () => setTimeout(() => { if (document.body.contains(input)) { input.remove(); resolve(multiple ? [] : null); } }, 800), { once: true });
    input.click();
  });
}

export function leerComoDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export async function comprimirImagen(file, { maxLado = 1600, calidad = 0.85 } = {}) {
  if (!file.type.startsWith('image/')) return { dataUrl: await leerComoDataURL(file), mime: file.type, nombre: file.name, tamano: file.size };
  const dataUrl = await leerComoDataURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * escala);
  canvas.height = Math.round(img.height * escala);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const salida = canvas.toDataURL('image/jpeg', calidad);
  return { dataUrl: salida, mime: 'image/jpeg', nombre: (file.name || 'foto').replace(/\.\w+$/, '') + '.jpg', tamano: Math.round(salida.length * 0.75) };
}

// Atajo: abre cámara o galería y devuelve { dataUrl, mime, nombre }.
export async function capturar({ camara = true, soloImagen = false } = {}) {
  const f = await elegirArchivo({ capturar: camara, aceptar: soloImagen ? 'image/*' : 'image/*,application/pdf' });
  if (!f) return null;
  return comprimirImagen(f);
}
