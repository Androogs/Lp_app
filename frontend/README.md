# Licores Palmira · Frontend (React + TypeScript + Vite)

## Ejecutar

Desde la raíz del proyecto: `npm run dev` (abre http://localhost:5173). Solo el frontend: `npm run dev -w frontend`
(necesita el backend corriendo en :3400; otra dirección con `PALMIRA_BACKEND_URL=http://…`).

| Comando | Qué hace |
|---|---|
| `npm run dev` | Vite con recarga instantánea y proxy a la API |
| `npm run typecheck` | Revisión estricta de tipos (`tsc --noEmit`) |
| `npm run build` | Revisión de tipos + build optimizado en `dist/` (+ `sw.js` versionado) |
| `npm run preview` | Previsualiza el build |

## Estado de la migración a React

La aplicación ya es una aplicación **React 19 + TypeScript** servida por **Vite**. React controla el arranque, la sesión,
el enrutamiento, toda la estructura (menú lateral, barra superior, barra inferior del celular, menú "Más") y las
pantallas de **Acceso** (con la foto de la bodega) e **Inicio**, escritas como componentes TSX tipados.

Las demás pantallas (Ventas, Domicilios, Inventario, Compras, Caja, Créditos, Contabilidad, Marketing, Configuración, etc.)
son el código aprobado del panel original adaptado a la licorera, ubicado en `src/legacy/views/`. React las monta dentro del panel con
`<PantallaHeredada>`: funcionan igual que antes, con el mismo diseño, y usan el mismo núcleo tipado (`lib/api.ts`,
`lib/estado.ts`, `lib/modulos.ts`), por lo que la sesión, la protección CSRF y los permisos son uno solo.

| Pantalla | Estado |
|---|---|
| Estructura, menú, barras, rutas, sesión | React + TS |
| Acceso (login, recuperar contraseña) | React + TS |
| Inicio (centro del día) | React + TS |
| Gráficas, Ventas (vitrina y tarifa mayorista), Domicilios, Inventario, Compras, Clientes, Proveedores, Créditos, Caja, Reportes, Contabilidad, Marketing, Comisiones, Configuración | JavaScript montado en React (`src/legacy/views`) |

Este esquema permite migrar **una pantalla a la vez** sin detener el sistema ni cambiar el diseño.

## Cómo migrar una pantalla a React

1. Crea `src/views/NombrePantalla.tsx` con un componente que reciba `{ ruta, setTopbar }` y llame a `setTopbar({ titulo, atras, acciones })` en un `useEffect`.
2. Reutiliza las mismas clases CSS del archivo heredado (el diseño vive en `src/styles/`), `Icono` para los iconos, `api` para los datos y `estado.tiene('permiso')` para los permisos.
3. En `src/lib/vistas.ts` cambia la entrada de esa sección a `{ tipo: 'react', … }` y agrégala en `App.tsx`.
4. Borra el archivo de `src/legacy/views/` cuando ya nada lo importe y ejecuta `npm run typecheck` y `npm run build`.

## Seguridad en el cliente

- `lib/api.ts` envía la cabecera de la aplicación y el token CSRF de la sesión en cada escritura, y lo renueva si caduca.
- La cookie de sesión es HttpOnly: el código de la interfaz nunca ve ni guarda el token de sesión.
- React escapa todo el texto por defecto; las pantallas heredadas usan la plantilla segura `html` y la función `esc()`.
- El build no usa scripts en línea, compatible con la política de seguridad de contenido (CSP) del backend.

## Diseño y marca

- Tokens del tema «Bodega de noche» al inicio de `src/styles/app.css` (`--accent` ámbar, `--lp-*` paleta de las cinco
  botellas, `--grad-calido`, `--grad-marca`, `--font-display` Jost y `--font` DM Sans).
- Fuentes autoalojadas con `@fontsource-variable/jost` y `@fontsource-variable/dm-sans` (se importan en `src/main.tsx`).
- Recursos en `public/icons/` (logo, isotipo SVG, mascota `tino.svg`, íconos de la app) y `public/img/` (bodega).
- Componentes propios: vitrina `.pv-*` (Vender y Domicilios), tablero `.dm-*`, insignias `.badge.mayor` y `.badge.camino`.
