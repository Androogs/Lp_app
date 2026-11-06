// Icono SVG del sistema (mismo juego de iconos que el resto de la aplicación). El contenido del SVG es fijo y viene del
// propio código (nunca de datos del usuario), por eso se inserta como HTML.
import { ICONOS } from '../legacy/ui.js';

interface Props { nombre: string; tam?: number }

export function Icono({ nombre, tam = 24 }: Props) {
  const trazos = (ICONOS as Record<string, string>)[nombre] || '';
  return (
    <svg width={tam} height={tam} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: trazos }} />
  );
}
