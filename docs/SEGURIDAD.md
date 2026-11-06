# Seguridad de Licores Palmira · Gestión

Resumen de los controles implementados y cómo verificarlos. Todos están cubiertos por `npm test` (`tests/seguridad.test.js`).

## Autenticación y contraseñas
- **bcrypt** (costo 12, configurable con `BCRYPT_ROUNDS`). Nunca se guarda ni se devuelve una contraseña en texto plano.
- Los hash `scrypt` de la versión anterior siguen funcionando y se **convierten a bcrypt automáticamente** en el siguiente ingreso.
- **Política:** mínimo 10 caracteres (`PASSWORD_MIN_LENGTH`), letras y números, máximo 72 bytes (límite de bcrypt), sin espacios al inicio o final, sin contener el usuario, sin contraseñas triviales. Se valida en el navegador y **siempre** en el servidor.
- **Bloqueo de cuenta:** 5 intentos fallidos → 15 minutos (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES`). Además, máximo 20 intentos fallidos por IP cada 15 minutos.
- **Sin enumeración de usuarios:** mismo mensaje y tiempo de respuesta exista o no el usuario.
- **Contraseña temporal:** las cuentas creadas o restablecidas por un administrador deben cambiar la contraseña antes de poder modificar datos.
- **Sin credenciales por defecto en producción:** el primer administrador se define por variables de entorno; los usuarios de demostración no pueden cargarse en producción.

## Sesiones
- Token aleatorio de 256 bits en cookie `HttpOnly`, `SameSite=Lax`, `Secure` y prefijo `__Host-` en producción.
- En la base solo se guarda la **huella SHA-256** del token: una copia robada de la base no permite suplantar sesiones.
- Expiración absoluta (12 h, `SESSION_HOURS`) y por inactividad (2 h, `SESSION_IDLE_MINUTES`). Limpieza automática cada 30 min.
- Rotación al iniciar sesión; cambiar o restablecer la contraseña cierra las demás sesiones; desactivar un usuario las cierra todas.

## CSRF
- Token CSRF propio de cada sesión, enviado en la cabecera `X-CSRF-Token` y comparado en tiempo constante.
- Toda escritura en `/api` exige además `X-Requested-With`, lo que obliga a una verificación CORS previa que un sitio externo no puede superar.

## Inyección SQL
- 100 % de las consultas usan **parámetros enlazados** (`?`). Los nombres de columnas dinámicos provienen de listas fijas del código, nunca del usuario.

## XSS
- La interfaz construye el HTML con una plantilla que **escapa por defecto** todo dato.
- Content-Security-Policy estricta: solo scripts propios (`script-src 'self'`, sin scripts en línea), sin `object`, sin iframes de terceros (`frame-ancestors 'none'`).
- Los enlaces que propone el asistente IA solo pueden apuntar a pantallas internas.
- Exportaciones CSV protegidas contra inyección de fórmulas.

## Archivos subidos
- Se verifica la **firma real** del archivo (JPG, PNG, WEBP, GIF, PDF); se ignora el tipo que declara el navegador.
- Máximo 12 MB por archivo; nombre aleatorio generado por el servidor; carpeta fuera del directorio público.
- Se sirven solo a usuarios con sesión y permiso, con `Content-Security-Policy: sandbox` y `nosniff`.
- Rutas validadas con expresión estricta (sin recorrido de directorios).

## Cabeceras y transporte
- Helmet: HSTS (1 año), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Cross-Origin-Opener/Resource-Policy`, `Permissions-Policy`.
- Redirección forzada a HTTPS en producción (`FORCE_HTTPS`).
- Límite general de 1 MB por petición; 20 MB solo en las rutas que reciben archivos.
- Límite de peticiones por IP a toda la API y límites específicos para acceso, recuperación y comprobantes públicos.
- Los errores internos nunca exponen trazas al navegador.

## Control de acceso
- Permisos por rol verificados en **cada ruta del servidor** (no solo ocultando botones).
- Solo un administrador puede crear o modificar administradores y cambiar los permisos de los roles.
- Auditoría de acciones sensibles: accesos, fallos, bloqueos, cambios de contraseña, configuración, ventas, compras, anulaciones.

## Secretos
- Claves de servicios externos (Anthropic, Meta, Google, TikTok) solo en variables de entorno.
- El token de API para integraciones (n8n) se guarda como huella SHA-256 y se muestra **una sola vez**.
- Los códigos de recuperación se guardan **cifrados con AES-256-GCM** (para que el administrador pueda entregarlos) y se verifican con HMAC; caducan en 30 minutos y se invalidan tras 5 intentos.

## Recomendaciones operativas
1. Usa HTTPS siempre (SSL gratuito de Hostinger).
2. Mantén `DATA_DIR` fuera de la carpeta pública y de la aplicación.
3. Descarga respaldos periódicamente fuera del servidor.
4. Borra `INITIAL_ADMIN_PASSWORD` después del primer ingreso.
5. Revisa Configuración › Auditoría ante cualquier sospecha.
6. Actualiza dependencias con `npm audit` cada cierto tiempo.
