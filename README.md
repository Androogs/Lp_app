# Licores Palmira · Panel de gestión

Sistema administrativo de **Licores Palmira** (Palmira, Valle del Cauca · desde 1994): ventas al detal y **al por mayor**,
**domicilios con la flota propia**, inventario por lotes (FIFO / promedio), compras con lectura de facturas por IA,
clientes detal y mayoristas, créditos y cartera, caja y gastos, contabilidad, comisiones, marketing, reportes (PDF / Excel)
y el asistente **Tino**.

Versión 1.0 — gemelo del panel SEGY 3.0 adaptado a la licorera: misma arquitectura, seguridad y módulos, con la identidad,
el catálogo, los precios y la operación de Licores Palmira (ver [CAMBIOS.md](CAMBIOS.md)).

```
licores-palmira-gestion/
├── backend/     API REST · Node.js 22 + Express 5 + SQLite integrado (seguridad, datos, PDF, OCR)
├── frontend/    Interfaz web · React 19 + TypeScript 5 + Vite 6
├── docs/        Despliegue en Hostinger, seguridad, base de datos y asistente
└── package.json Monorepo (npm workspaces): instala y ejecuta ambos con un solo comando
```

---

## Requisitos

| Componente | Versión |
|---|---|
| Node.js | **22.13 o superior** (22 LTS o 24) |
| npm | 10 o superior |
| Base de datos | SQLite integrado en Node.js (no se instala nada) |

---

## Probar en tu computador

```bash
# 1. Instalar dependencias de backend y frontend (un solo comando, desde la raíz)
npm install

# 2. Configuración local del backend
cp backend/.env.development.example backend/.env      # Windows: copy backend\.env.development.example backend\.env

# 3. Base de datos con el catálogo y los datos de demostración de Licores Palmira
npm run seed                 # npm run seed -- --forzar  → borra la base local y la vuelve a crear

# 4. Arrancar backend (API :3400) y frontend (Vite :5173) a la vez
npm run dev
```

Abre **http://localhost:5173**. Vite recarga la interfaz al instante cuando guardas cambios y reenvía `/api` al backend.

| Usuario | Contraseña | Rol |
|---|---|---|
| `admin` | `Demo2026*Palmira` | Administrador |
| `carlos` | `Vendedor2026*` | Vendedor |
| `luisa` | `Cajera2026*` | Cajera (despacha domicilios) |
| `pedro` | `Inventario2026*` | Encargado de bodega |
| `conta` | `Consulta2026*` | Contabilidad / consulta |

> Usuarios **solo de demostración**: `npm run seed` se niega a correr con `NODE_ENV=production`.

**Datos de demostración** (`backend/server/seed.js`): las 113 referencias reales del catálogo web con su precio al detal y
al por mayor (`backend/database/catalogo-palmira.json`) y su imagen (`backend/database/demo-fotos/`: 50 fotos de producto
y 63 ilustraciones de botella generadas con el mismo componente de la página web), 4 distribuidores, clientes detal y
mayoristas, compras por lotes, ~38 días de ventas, créditos a tiendas, gastos de la flota, la caja del día abierta,
4 repartidores y domicilios en todos los estados. Los proveedores, clientes y teléfonos son ficticios.

### Probar la versión de producción en local

```bash
npm run build     # verifica tipos (tsc) y compila el frontend en frontend/dist
npm test          # 38 pruebas automáticas del backend
npm start         # el backend sirve la API y el frontend compilado en http://localhost:3400
```

### Verlo desde internet (túnel de Cloudflare)

Con `npm run dev` en marcha, en otra terminal:

```bash
cloudflared tunnel --url http://localhost:5173
```

- Para que la **recarga en vivo (HMR)** funcione a través del túnel, arranca con `PALMIRA_TUNNEL=1` (`set PALMIRA_TUNNEL=1 && npm run dev` en cmd de Windows).
- Para un **túnel con dominio propio**, indícalo en `PALMIRA_ALLOWED_HOSTS` (ej. `PALMIRA_ALLOWED_HOSTS=panel.licorespalmira.com`).
- Con la **versión de producción** (`npm run build` + `npm start`), apunta el túnel a `http://localhost:3400`.

---

## Lo propio de la licorera

| Módulo | Qué hace |
|---|---|
| **Vender** | Vitrina de botellas con foto (lo más vendido primero, filtro por categoría), búsqueda y lector de código de barras. La **tarifa mayorista** se aplica sola desde 10 unidades de una referencia (configurable) o a clientes mayoristas, igual que en la web. |
| **Domicilios** | Pedidos por WhatsApp, teléfono o web. Tablero *recibido → en preparación → en camino → entregado* con alertas de atraso, despacho por repartidor, cambio para el efectivo, mensaje de WhatsApp al cliente y mapa. **Al entregar se crea la venta** (descuenta inventario, cobra contraentrega y registra el envío). |
| **Inventario** | Precio al detal y al por mayor con historial, presentación (750 ml, litro, garrafa…), tipo o variedad (12 años, reposado…), categorías y subcategorías de la web, control opcional por serial o estampilla. |
| **Clientes** | Detal o mayorista (tiendas, bares, eventos), barrio para los domicilios. |
| **Comprobantes y PDF** | Logo, franja de las cinco botellas, línea de domicilio, marca de precio mayorista y la leyenda legal de bebidas alcohólicas. |
| **Tino** | Asistente (sin IA y, opcionalmente, con IA): entiende la jerga de licorera (*guaro, pola, tapa azul, media, garrafa*), consulta domicilios y explica el precio mayorista. |

El resto de módulos (compras con OCR, créditos, caja, contabilidad con tasa de cambio, comisiones, marketing con
seguimiento web, reportes, usuarios y permisos, respaldos, PWA) se conservan del panel original.

---

## Diseño «Bodega de noche»

| Elemento | Decisión |
|---|---|
| Fondo y superficies | Negro cálido `#110e0b` (la bodega de noche) y roble ahumado `#1a1612` / `#262019`; texto crema `#f6efe4` |
| Acción principal | Ámbar `#feb140`, la botella central del logo, con tinta oscura `#1f1405` encima |
| Estados | La misma paleta de las cinco botellas: rojo `#ef1c25` urgente, naranja `#f2592a` aviso, ámbar en curso, lima `#89c93c` / verde `#399933` correcto |
| Degradados | Los dos aprobados en la web: cálido (rojo → naranja → ámbar) en el indicador destacado y el botón Vender del celular; espectro de cinco botellas en la barra activa del menú, franjas y comprobantes |
| Tipografía | **Jost** (títulos y cifras; sucesora web de Century Gothic, la del manual) y **DM Sans** (interfaz), incluidas en el proyecto con `@fontsource-variable` (funcionan sin internet) |
| Imágenes | Acceso con la foto de la bodega; botellas sobre un fondo iluminado en vitrina y miniaturas |

Todos los tokens viven al inicio de `frontend/src/styles/app.css`. Recursos de marca en `frontend/public/icons/`:
`logo-palmira.webp` (fondo oscuro), `logo-palmira-color.webp`, `isotipo.svg` (las cinco botellas en vector),
`tino.svg` (mascota del asistente) e íconos PNG de la app; la foto de la bodega en `frontend/public/img/`.

---

## Comandos (desde la raíz)

| Comando | Qué hace |
|---|---|
| `npm run dev` | Backend + frontend en modo desarrollo |
| `npm run dev:backend` / `npm run dev:frontend` | Solo uno de los dos |
| `npm run build` | Revisión de tipos + build optimizado del frontend |
| `npm run typecheck` | Solo la revisión de tipos TypeScript |
| `npm start` | Servidor de producción (API + frontend compilado) |
| `npm test` | Pruebas automáticas del backend |
| `npm run check` | Verifica el entorno antes de publicar |
| `npm run db:init` | Crea o actualiza la base de datos (nunca borra datos) |
| `npm run crear-admin` | Crea un administrador o restablece su contraseña |
| `npm run seed` | Datos de demostración (solo desarrollo; `-- --forzar` para recrear) |
| `npm run backup` | Copia de seguridad de la base de datos |

---

## Arquitectura

**En desarrollo** hay dos procesos: Vite (`:5173`) sirve la interfaz con recarga instantánea y reenvía `/api`, `/comprobante` y `/marketing` al backend (`:3400`).

**En producción** hay un solo proceso: el backend sirve la API y los archivos compilados de `frontend/dist`, con el mismo dominio para la interfaz y la API (las cookies de sesión y la protección CSRF funcionan sin configurar CORS).

### Backend (`backend/`)

```
server/
  index.js        Servidor Express: cabeceras de seguridad, límites, rutas, archivos estáticos
  config.js       Variables de entorno validadas (lee backend/.env)
  db.js           SQLite, configuración por defecto (unidades mayoristas, domicilios…) y migraciones automáticas
  schema.sql      Esquema completo (repartidores, domicilios, precio mayor, tarifa por línea…)
  auth.js         Sesiones, CSRF, token de API, permisos
  routes/         Endpoints de la API (domicilios.js: pedidos, cotización, estados y repartidores)
  services/       Lógica de negocio (ventas con tarifa mayorista, domicilios, inventario, contabilidad…)
database/
  catalogo-palmira.json   Catálogo de demostración (113 referencias, precios detal / mayor)
  demo-fotos/             Imagen de cada referencia para los datos de demostración
assets/           Logo para los PDF y script de seguimiento web (palmira-seguimiento.js) para la página de la licorera
scripts/          db:init, crear-admin, backup, check
tests/            Pruebas automáticas (node:test)
```

### Frontend (`frontend/`)

```
src/
  main.tsx            Entrada de React (carga las fuentes Jost y DM Sans)
  App.tsx             Sesión, acceso y enrutamiento por hash (#/seccion)
  lib/                Núcleo tipado: api.ts (CSRF), estado.ts, sesion.ts, ruta.ts, modulos.ts, vistas.ts, tipos.ts
  layout/             Barra lateral, barra superior y barra inferior del celular
  views/              Pantallas en React: Login.tsx (bodega), Inicio.tsx
  legacy/             Pantallas en JavaScript montadas dentro de React (views/domicilios.js, views/ventas.js…)
  styles/             app.css (tokens y componentes), inicio.css, asistente.css, marketing.css
public/               Marca, íconos, manifiesto PWA, foto de la bodega y librería del escáner
```

Ver **[frontend/README.md](frontend/README.md)** para la estructura de pantallas y cómo migrar las heredadas a React.

---

## Publicar en Hostinger

Guía paso a paso: **[docs/DESPLIEGUE-HOSTINGER.md](docs/DESPLIEGUE-HOSTINGER.md)**.

| Campo en Hostinger | Valor |
|---|---|
| Versión de Node.js | 22.x |
| Comando de instalación | `npm install` |
| Comando de compilación | `npm run build` |
| Archivo de entrada | `backend/server/index.js` |
| Comando de inicio | `npm start` |

Antes de publicar: completa el NIT en Configuración › Negocio, cambia las contraseñas, crea los usuarios reales y carga
el catálogo real (o edita el de demostración). Más documentación: [Asistente Tino](docs/ASISTENTE.md) ·
[Seguridad](docs/SEGURIDAD.md) · [Base de datos](docs/BASE-DE-DATOS.md) · [Cambios](CAMBIOS.md)
