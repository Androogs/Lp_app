# Publicar Licores Palmira · Gestión en Hostinger

El panel de Licores Palmira es una aplicación **Node.js** con base de datos SQLite integrada.

> **Importante: no se sube a `public_html`.**
> `public_html` es para sitios estáticos o PHP. Un servidor Node.js no puede ejecutarse desde ahí. En Hostinger tienes dos caminos:
>
> | Plan | Camino |
> |---|---|
> | **Business** o **Cloud** (hosting web con *Aplicaciones Node.js*) | [Opción A](#opción-a--aplicación-nodejs-planes-business--cloud) — recomendado, sin terminal |
> | **VPS** | [Opción B](#opción-b--vps-ubuntu) — control total |
> | Premium / Single | No ejecutan Node.js. Hay que subir de plan o usar un VPS. |
>
> Hostinger cambia sus menús con frecuencia; si un nombre no coincide exactamente, busca la opción equivalente ("Node.js", "Aplicaciones", "Variables de entorno").

---

## Antes de empezar (en tu computador)

1. Prueba el proyecto en local (ver README) y ejecuta `npm test`: deben pasar todas las pruebas.
2. Genera un secreto para la aplicación:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Guárdalo: será `APP_SECRET`.
3. Elige la contraseña del primer administrador: mínimo 10 caracteres, con letras y números, que no contenga el nombre de usuario.

---

## Opción A · Aplicación Node.js (planes Business / Cloud)

### 1. Preparar el ZIP

Usa el ZIP entregado tal cual. Si lo armas tú, comprime la carpeta raíz (la que contiene `backend/`, `frontend/` y `package.json`) **sin** `node_modules/`, `backend/data/` ni archivos `.env`.
El ZIP incluye `frontend/dist/` ya compilado; el comando de compilación de Hostinger lo vuelve a generar.

### 2. Crear la aplicación

1. hPanel → **Sitios web** → **Agregar sitio web** → **Aplicación Node.js** (o *Websites › Node.js Apps*).
2. Elige **Subir archivos** y selecciona el ZIP (o conecta tu repositorio de GitHub).
3. Configuración de compilación:

   | Campo | Valor |
   |---|---|
   | Framework / preset | **Express** (u "Otro") |
   | Versión de Node.js | **22.x** (o 24.x). **No uses 18 ni 20**: no traen SQLite integrado. |
   | Directorio raíz | `/` (la carpeta raíz, donde están `backend/`, `frontend/` y `package.json`) |
   | Comando de instalación | `npm install` (instala backend y frontend) |
   | Comando de compilación | `npm run build` (compila el frontend React con Vite) |
   | Archivo de entrada | `backend/server/index.js` |
   | Comando de inicio (si lo pide) | `npm start` |

   En producción un solo proceso Node.js sirve la API y la interfaz compilada (`frontend/dist`).

### 3. Variables de entorno

En la misma pantalla (sección **Variables de entorno**) agrega:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://tudominio.com` (el dominio de la app, sin barra final) |
| `APP_SECRET` | el secreto que generaste |
| `DATA_DIR` | ruta **absoluta fuera de la carpeta de la app**, p. ej. `/home/u123456789/palmira-data` |
| `INITIAL_ADMIN_USER` | `admin` (o el usuario que quieras) |
| `INITIAL_ADMIN_PASSWORD` | la contraseña inicial |
| `TZ` | `America/Bogota` |
| `ANTHROPIC_API_KEY` | *(opcional)* para leer facturas con IA y el asistente Tino |

`PORT` lo asigna Hostinger automáticamente; no lo definas salvo que el panel lo pida.

**Sobre `DATA_DIR`:** ahí viven la base de datos, las fotos, las facturas y los respaldos. Debe estar fuera de la carpeta de la aplicación para que **una nueva publicación no borre los datos**. Tu usuario (`u123456789`) aparece en hPanel › Avanzado › SSH o en el Administrador de archivos. Si el plan no permite escribir fuera de la carpeta de la app, la aplicación lo indicará en los registros al arrancar; en ese caso usa la Opción B.

### 4. Desplegar y dominio

1. Pulsa **Desplegar**. Al terminar, Hostinger asigna un dominio temporal o te deja conectar el tuyo.
2. **Dominio:** en la configuración de la app elige tu dominio o subdominio (p. ej. `panel.licorespalmira.com`). Si el dominio está en otro proveedor, apunta su registro **A** a la IP que muestra Hostinger.
3. **SSL:** hPanel › Seguridad › **SSL** → instala el certificado gratuito para el dominio y activa *Forzar HTTPS*.
4. Si cambiaste de dominio, actualiza `APP_URL` y vuelve a desplegar.

### 5. Primer ingreso

1. Abre `https://tudominio.com/api/salud` → debe responder `{"ok":true,"bd":"ok",...}`.
2. Abre `https://tudominio.com`, entra con `INITIAL_ADMIN_USER` / `INITIAL_ADMIN_PASSWORD`.
3. El sistema te lleva a **Configuración › Mi cuenta** y **obliga a cambiar la contraseña** antes de poder registrar datos.
4. Ya con tu contraseña definitiva, **borra `INITIAL_ADMIN_PASSWORD`** de las variables de entorno.
5. En **Configuración** completa los datos del negocio (nombre, NIT, dirección) y crea los usuarios del equipo.

### 6. Actualizar a una versión nueva

Sube el ZIP nuevo (o haz *push* a GitHub) y vuelve a desplegar. Los datos en `DATA_DIR` se conservan y la base se actualiza sola al arrancar. Antes de actualizar, descarga un respaldo (Configuración › Respaldos).

---

## Opción B · VPS (Ubuntu)

Ejemplo para un VPS Ubuntu 22.04/24.04 de Hostinger. Ejecuta como un usuario con `sudo`.

```bash
# 1. Node.js 22 y herramientas
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx unzip
sudo npm install -g pm2

# 2. Usuario y carpetas (la app y los datos separados)
sudo adduser --system --group --home /opt/palmira palmira
sudo mkdir -p /opt/palmira/app /var/lib/palmira
sudo chown -R palmira:palmira /opt/palmira /var/lib/palmira
sudo chmod 750 /var/lib/palmira

# 3. Subir el ZIP (desde tu PC):  scp licores-palmira-gestion.zip usuario@IP:/tmp/
sudo -u palmira unzip -o /tmp/licores-palmira-gestion.zip -d /opt/palmira/app
cd /opt/palmira/app
sudo -u palmira cp backend/.env.production.example backend/.env
sudo -u palmira nano backend/.env      # APP_URL, APP_SECRET, DATA_DIR=/var/lib/palmira, INITIAL_ADMIN_*
sudo chmod 600 backend/.env

# 4. Instalar, compilar, verificar y probar
sudo -u palmira npm ci || sudo -u palmira npm install
sudo -u palmira npm run build
sudo -u palmira npm run check
sudo -u palmira npm test

# 5. Ejecutar con PM2 (reinicio automático)
sudo -u palmira pm2 start backend/ecosystem.config.js
sudo -u palmira pm2 save
sudo env PATH=$PATH pm2 startup systemd -u palmira --hp /opt/palmira
```

### Nginx como proxy inverso

`/etc/nginx/sites-available/palmira`:

```nginx
server {
    listen 80;
    server_name panel.tudominio.com;
    client_max_body_size 25m;

    location / {
        proxy_pass         http://127.0.0.1:3400;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/palmira /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# SSL gratuito
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d panel.tudominio.com
# Cortafuegos: solo SSH y web
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

En `backend/.env` del VPS deja `HOST=127.0.0.1` para que la app solo escuche detrás de Nginx.

### Respaldo fuera del servidor (recomendado)

```bash
# Copia diaria de la base y archivos a las 2 a. m. (crontab -e del usuario palmira)
0 2 * * * cd /opt/palmira/app && npm run backup >/dev/null 2>&1
```
Descarga periódicamente `/var/lib/palmira/respaldos` y `/var/lib/palmira/archivos` a otro lugar (tu PC, Google Drive).

---

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| La app no arranca: `node:sqlite` no encontrado | Versión de Node menor a 22.13. Elige Node 22 o 24. |
| La página dice "La interfaz aún no está compilada" | Falta el comando de compilación `npm run build` en Hostinger (o ejecútalo en el VPS). |
| `APP_SECRET debe tener al menos 32 caracteres` | Genera uno con el comando del inicio de esta guía. |
| No puedo entrar y no hay usuarios | Faltan `INITIAL_ADMIN_USER` / `INITIAL_ADMIN_PASSWORD`, o la contraseña no cumple la política (ver registros). Corrige y reinicia. |
| Entré pero "Debes cambiar tu contraseña temporal" | Es intencional: cámbiala en Configuración › Mi cuenta. |
| "Demasiados intentos fallidos" | Bloqueo de 15 minutos por seguridad. Un administrador puede restablecer la contraseña, o espera. |
| Los datos desaparecen al volver a publicar | `DATA_DIR` está dentro de la carpeta de la app. Usa una ruta absoluta fuera de ella. |
| Bucle de redirección o la sesión no se mantiene | Falta SSL o el proxy no envía `X-Forwarded-Proto`. Instala SSL. Como diagnóstico temporal puedes poner `FORCE_HTTPS=false` y `COOKIE_SECURE=false` (no lo dejes así). |
| "La sesión de seguridad expiró" | Recarga la página: la app renueva el token automáticamente. |
| El OCR / Tino dicen "no disponible" | Falta `ANTHROPIC_API_KEY` (opcional). |

Comprobación rápida en el servidor: `npm run check`.
