# Asistente Tino

Tino es el asistente del panel. Responde preguntas sobre el negocio con los **datos reales** de la base, avisa de los pendientes y explica cómo hacer cada proceso. Funciona **sin clave de IA**: la IA es un complemento opcional.

## Qué puede responder

| Tema | Ejemplos |
|---|---|
| Inventario | "¿Cuántos cargadores hay?", "¿Hay vidrio para Galaxy A15?", "Lista de productos", "Valor del inventario" |
| Lo que se va a acabar | "¿Qué productos se van a acabar?", "¿Qué hay que pedir?" |
| Ventas | "¿Cuánto se vendió hoy?", "Ventas del lunes", "Ventas del 15 de octubre", "¿Cuánto vendimos en octubre?", "Del 1 al 15 de octubre" |
| Ventas por producto | "¿Cuántos iPhone se vendieron este mes?", y de seguimiento "¿y ayer?" |
| Precios | "¿Cuánto vale el iPhone 17?" (el costo y el margen solo para quien ve costos) |
| Pendientes | "¿Qué tengo pendiente?", "Resumen del día", o la campana del panel |
| Caja | "¿Cómo va la caja?" |
| Cartera | "¿Quién me debe?", "Créditos vencidos", "¿Cuánto debe Ana?" |
| Proveedores | "¿Cuánto le debo a los proveedores?", "Última compra" |
| Ganancias y gastos | "¿Cuánto gané este mes?", "Gastos de la semana" |
| Otros | Lo más vendido, productos sin movimiento, domicilios y repartidores, tasa de cambio, comisiones, documentos |
| Procesos | "¿Cómo cierro la caja?", "¿Cómo registro una compra en dólares?" |
| Navegación | "Llévame a inventario" |

Fechas que entiende: hoy, ayer, antier, un día de la semana ("el lunes", "el martes pasado"), "15 de octubre", "15/10", "2026-10-15", "el día 3", esta semana, la semana pasada, este mes, el mes pasado, un mes por nombre (con o sin año), este año, el año pasado, "últimos N días", rangos ("del 1 al 15 de octubre"). Si un mes aún no llega este año, se toma el del año anterior.

## Motores de respuesta

Se elige en **Configuración › Asistente Tino › Motor de respuestas**.

| Motor | Comportamiento | Requiere clave |
|---|---|---|
| **Automático** (predeterminado) | El motor local responde todo lo que entiende. Lo que no entiende va a la IA si hay clave. Si la IA falla o se supera el límite por hora, responde el motor local. | No |
| **Solo datos del sistema** | Solo el motor local: sin costo, sin internet. | No |
| **Todo con IA** | Todo pasa por la IA, con las herramientas de consulta (comportamiento de la versión anterior). | Sí |

**Motor local** (`backend/server/services/asistente/local.js`): normaliza el texto, reconoce el periodo, puntúa intenciones por palabras clave y busca productos y clientes mencionados. La búsqueda tolera singular y plural, mayúsculas, tildes y errores de digitación. No confunde modelos con número: "iPhone 15" no trae el iPhone 17. Las respuestas salen de consultas reales; si no hay datos, lo dice. Reutiliza las herramientas del asistente, que ya validan permisos.

**Con IA** (Anthropic por defecto, OpenRouter como alternativa): la clave va en las variables de entorno del servidor (`ANTHROPIC_API_KEY` u `OPENROUTER_API_KEY`) y nunca se guarda en la aplicación. La IA usa las mismas herramientas, incluidas `consultar_pendientes` y `consultar_ventas_producto`.

## Avisos y notificaciones

`backend/server/services/asistente/avisos.js` calcula, según los permisos de cada usuario:

| Aviso | Nivel |
|---|---|
| Productos agotados | Urgente |
| Productos en el stock mínimo o por debajo | Pronto |
| Productos que **se acabarán en menos de N días** (N configurable, 7 por defecto) | Pronto |
| Cuotas vencidas | Urgente |
| Cuotas por vencer | Pronto |
| Facturas por pagar a proveedores | Urgente si hay vencidas, si no Pronto |
| Domicilios por despachar | Pronto |
| Domicilios atrasados (en bodega o en camino más del tiempo configurado) | Urgente |
| Caja abierta desde un día anterior | Pronto |
| Documentos por revisar, caja sin abrir | Para revisar |

**Cómo se estima "se va a acabar":** ritmo diario = unidades vendidas en los últimos 30 días ÷ 30. Si el negocio lleva menos tiempo vendiendo, se usan los días reales, con un mínimo de 7. Luego, días de cobertura = stock actual ÷ ritmo diario. Es una **estimación**: supone que el ritmo reciente se mantiene, y así se le dice al usuario.

En la interfaz (`frontend/src/legacy/asistente.js`):

- **Contador** sobre la mascota con los pendientes urgentes y próximos. Es rojo si hay urgentes y ámbar si no.
- **Burbuja**: aparece solo cuando hay algo **nuevo**. Muestra ese aviso nuevo y se oculta al verlo o al abrir Tino. Cada aviso trae una clave por entidad (producto, cuota, factura), y el navegador recuerda las ya conocidas por usuario.
- **Resumen al abrir Tino**: saludo, ventas del día y caja, más la tarjeta de pendientes. Cada fila lleva a la pantalla filtrada. No gasta mensajes ni IA.
- **Avisos del navegador** (casilla en el panel, la activa cada usuario): notificación del sistema cuando hay un pendiente nuevo y la app está en segundo plano. Al tocarla, se abre Tino.
- Los avisos se consultan al entrar, cada 3 minutos, al volver a la pestaña y al cambiar de pantalla, como máximo una vez cada 30 segundos.

**Límites a tener en cuenta:**

- Las notificaciones funcionan mientras la aplicación esté abierta en alguna pestaña o instalada y abierta. No hay notificaciones "push" desde el servidor con el navegador cerrado.
- Requieren HTTPS (o `localhost`) y el permiso del navegador.

## Permisos

Tino lo ven los usuarios con el permiso **"Usar el asistente Tino"**. Cada respuesta y cada aviso respeta los permisos del usuario. Por ejemplo:

- quien no ve créditos no recibe avisos de cartera;
- el vendedor ve sus propias ventas y comisiones, no la utilidad del negocio;
- los costos solo los ve quien puede ver costos.

Las conversaciones son siempre del propio usuario.

## Herramientas de consulta

Todas son de **solo lectura**, validan sus parámetros, comprueban el permiso y acotan el resultado (~40 filas / ~6 KB). Si no se pasa periodo, usan el mes en curso.

| Herramienta | Qué responde | Filtros propios |
|---|---|---|
| `consultar_ventas` | Resumen del periodo (total, unidades, ticket promedio, métodos de pago, más vendidos, por vendedor, serie por día — o por hora si es un solo día) | `q` (número/cliente/producto), `numero` (detalle completo), `cliente`, `vendedor`, `producto`, `categoria`, `tipo_pago`, `estado`, `monto_minimo`, `limite` |
| `consultar_compras` | Compras a proveedores con TRM registrada y saldos | `proveedor`, `moneda`, `solo_con_saldo`, `limite` |
| `consultar_trm` | TRM oficial y dólar de mercado | `fecha` (histórica, también tasas manuales/mercado de ese día) |
| `consultar_inventario` | Productos, stock y precios | `q`, `solo_bajo_stock`, `limite` |
| `consultar_caja` | Caja abierta o último cierre | `fecha` (aperturas y cierres de ese día) |
| `consultar_clientes` | Clientes por nombre, teléfono o cédula, con saldo y compras | `q`, `limite` |
| `consultar_creditos` | Créditos por estado y resumen de cartera | `estado`, `cliente` (sus créditos, cuotas y últimos abonos), `limite` |
| `consultar_rentabilidad` | Ganancia, comisiones y resultado | `alcance` (`todos` o `propio`, según permiso) |
| `consultar_marketing` | Panel, campañas, rentabilidad o leads | `que` |
| `consultar_domicilios` | Domicilios: resumen del día y del mes, atrasados, carga por repartidor y lista por estado o texto | `estado`, `q`, periodo, `limite` |
| `consultar_pendientes` | Avisos del usuario y resumen del día | — |
| `consultar_ventas_producto` | Unidades vendidas de productos concretos | `q`, periodo |
| `guia_de_uso` | Pasos para un proceso en la app | `tema` |
| `navegar` | Botón para ir a una pantalla | `ruta`, `filtros` |

## Configuración (`configuracion.asistente`)

| Campo | Valores | Por defecto |
|---|---|---|
| `activo` | sí / no | sí |
| `motor` | `auto`, `local`, `ia` | `auto` |
| `avisos` | sí / no (contador, burbuja y notificaciones) | sí |
| `dias_cobertura` | 1 a 60 | 7 |
| `proveedor`, `modelo`, `esfuerzo` | solo para la IA | `anthropic`, `claude-opus-5-5`, `low` |
| `limite_mensajes_hora` | por usuario; protege el costo de la IA | 40 |
| `voz` | dictado y lectura en voz alta (del navegador) | sí |

## API

| Ruta | Uso |
|---|---|
| `GET /api/asistente/estado` | Disponibilidad, motor efectivo (`local`, `mixto` o `ia`) y sugerencias |
| `GET /api/asistente/avisos` | Pendientes, conteo por nivel, huella del conjunto y resumen del día |
| `POST /api/asistente/mensajes` | `{ mensaje, conversacion_id? }` → `{ respuesta, acciones, sugerencias, motor, intencion, … }` |
| `GET/POST/DELETE /api/asistente/conversaciones[/:id]` | Historial del propio usuario |

Tipos de `acciones`:

- `navegar`: botón para ir a una pantalla (`hash`, `etiqueta`).
- `avisos`: tarjeta de pendientes.
- `sugerencias`: preguntas de seguimiento. Se guardan en el historial.

Cada consulta queda en la auditoría con la acción `asistente_consulta`, el motor y la intención.

## Archivos

```
backend/server/services/asistente.js             Orquestación: motores, límite por hora, historial, auditoría
backend/server/services/asistente/local.js       Motor local: intenciones, búsqueda de productos y clientes, respuestas
backend/server/services/asistente/lenguaje.js    Normalización del español, fechas en lenguaje natural, formato colombiano
backend/server/services/asistente/avisos.js      Pendientes, proyección de agotamiento y resumen del día
backend/server/services/asistente/herramientas.js Herramientas de consulta con permisos (las usan la IA y el motor local)
backend/server/services/asistente/guia.js        Guías de uso de los procesos
backend/tests/asistente.test.js                  Pruebas: cifras contra la base, permisos, seguimientos, IA simulada, fechas
frontend/src/legacy/asistente.js                 Mascota, contador, burbuja, panel, notificaciones y voz
frontend/src/styles/asistente.css                Estilos
```

## Cómo ampliar el motor local

1. Agrega la intención con sus palabras clave en `REGLAS` (`local.js`). Las palabras van sin tildes y el peso va de 2 a 6.
2. Escribe su respuesta en `R.<intención>`. Comprueba el permiso con `tiene()` y usa las funciones de formato de `lenguaje.js`.
3. Agrega un caso en `tests/asistente.test.js`.
