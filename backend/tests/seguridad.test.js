'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciar, detener, Cliente, CLAVES, getDb } = require('./ayuda');

test.before(iniciar);
test.after(detener);

test('cabeceras de seguridad', async () => {
  const r = await new Cliente().get('/api/salud');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('las contraseñas se guardan con bcrypt, nunca en texto plano', () => {
  for (const u of getDb().prepare('SELECT usuario, password_hash FROM usuarios').all()) {
    assert.match(u.password_hash, /^\$2[aby]\$\d{2}\$/);
    assert.ok(!u.password_hash.includes(CLAVES[u.usuario] || '###'));
  }
});

test('rutas privadas exigen sesión', async () => {
  const c = new Cliente();
  for (const ruta of ['/api/productos', '/api/ventas', '/api/usuarios', '/api/configuracion', '/api/dashboard']) {
    const r = await c.get(ruta);
    assert.equal(r.status, 401, ruta);
  }
});

test('login: credenciales incorrectas, cookie segura y token CSRF', async () => {
  const c = new Cliente();
  const malo = await c.post('/api/auth/login', { usuario: 'admin', clave: 'incorrecta123' });
  assert.equal(malo.status, 401);
  assert.equal(malo.datos.error, 'Usuario o contraseña incorrectos');
  const noExiste = await c.post('/api/auth/login', { usuario: 'nadie', clave: 'incorrecta123' });
  assert.equal(noExiste.datos.error, malo.datos.error, 'no revela si el usuario existe');
  const ok = await c.entrar('admin', CLAVES.admin);
  const cookie = ok.setCookie.join(';');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(ok.datos.csrf && ok.datos.csrf.length >= 32);
  // En la base solo queda la huella del token de sesión.
  const token = c.cookie.split('=')[1];
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sesiones WHERE token_hash = ?').get(token).n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sesiones WHERE token_hash = ?').get(crypto.createHash('sha256').update(token).digest('hex')).n, 1);
  getDb().prepare("UPDATE usuarios SET intentos_fallidos = 0 WHERE usuario = 'admin'").run();
});

test('protección CSRF en escrituras', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const sinCabecera = await c.post('/api/clientes', { nombre: 'X' }, { sinApp: true });
  assert.equal(sinCabecera.status, 403);
  const sinToken = await c.post('/api/clientes', { nombre: 'X' }, { sinCsrf: true });
  assert.equal(sinToken.status, 403);
  assert.equal(sinToken.datos.codigo, 'csrf_invalido');
  const otroToken = await c.post('/api/clientes', { nombre: 'X' }, { sinCsrf: true, cabeceras: { 'X-CSRF-Token': 'a'.repeat(43) } });
  assert.equal(otroToken.status, 403);
  const ok = await c.post('/api/clientes', { nombre: 'Cliente CSRF', telefono: '3001112233' });
  assert.equal(ok.status, 201);
});

test('bloqueo de cuenta tras intentos fallidos', async () => {
  const c = new Cliente();
  for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { usuario: 'pedro', clave: `mala${i}xxxxxx` });
  const r = await c.post('/api/auth/login', { usuario: 'pedro', clave: CLAVES.pedro });
  assert.equal(r.status, 429);
  getDb().prepare("UPDATE usuarios SET bloqueado_hasta = NULL, intentos_fallidos = 0 WHERE usuario = 'pedro'").run();
  assert.equal((await c.post('/api/auth/login', { usuario: 'pedro', clave: CLAVES.pedro })).status, 200);
});

test('migración transparente de hashes scrypt antiguos a bcrypt', async () => {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('Antigua2025x', sal, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  getDb().prepare("INSERT INTO usuarios(nombre, usuario, password_hash, rol) VALUES ('Legado', 'legado', ?, 'consulta')").run(`scrypt$${sal}$${hash}`);
  const c = new Cliente();
  await c.entrar('legado', 'Antigua2025x');
  assert.match(getDb().prepare("SELECT password_hash h FROM usuarios WHERE usuario = 'legado'").get().h, /^\$2[aby]\$/);
});

test('política de contraseñas', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  for (const clave of ['corta1', 'solamenteletras', '12345678901', 'nuevousuario123']) {
    const r = await c.post('/api/usuarios', { nombre: 'Nuevo', usuario: 'nuevousuario', rol: 'vendedor', clave });
    assert.equal(r.status, 400, clave);
  }
  const ok = await c.post('/api/usuarios', { nombre: 'Nuevo', usuario: 'nuevousuario', rol: 'vendedor', clave: 'Segura2026xy' });
  assert.equal(ok.status, 201);
  assert.equal(ok.datos.password_hash, undefined, 'nunca se devuelve el hash');
});

test('permisos por rol y sin escalada de privilegios', async () => {
  const v = new Cliente();
  await v.entrar('carlos', CLAVES.carlos);
  assert.equal((await v.get('/api/configuracion')).status, 403);
  assert.equal((await v.post('/api/usuarios', { nombre: 'X', usuario: 'xx1', rol: 'admin', clave: 'Segura2026xy' })).status, 403);
  assert.equal((await v.get('/api/auditoria')).status, 403);
  assert.equal((await v.post('/api/compras', { items: [] })).status, 403);
  // Un rol con usuarios.administrar que no es administrador no puede crear administradores.
  const db = getDb();
  db.prepare("INSERT INTO configuracion(clave, valor) VALUES ('permisos_roles', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(JSON.stringify({ consulta: ['usuarios.administrar', 'config.ver'] }));
  const k = new Cliente();
  await k.entrar('conta', CLAVES.conta);
  assert.equal((await k.post('/api/usuarios', { nombre: 'X', usuario: 'xadmin', rol: 'admin', clave: 'Segura2026xy' })).status, 403);
  assert.equal((await k.put('/api/configuracion', { permisos_roles: { consulta: ['*'] } })).status, 403);
  db.prepare("DELETE FROM configuracion WHERE clave = 'permisos_roles'").run();
});

test('recuperación de contraseña: código cifrado, intentos limitados', async () => {
  const anon = new Cliente();
  await anon.post('/api/auth/recuperar', { usuario: 'luisa' });
  const fila = getDb().prepare("SELECT r.* FROM recuperacion_clave r JOIN usuarios u ON u.id = r.usuario_id WHERE u.usuario = 'luisa' AND usado = 0").get();
  assert.ok(fila.codigo.startsWith('v1.'), 'el código queda cifrado');
  const admin = new Cliente();
  await admin.entrar('admin', CLAVES.admin);
  const { datos } = await admin.get(`/api/usuarios/${fila.usuario_id}/codigo-recuperacion`);
  assert.match(datos.codigo, /^\d{6}$/);
  const incorrecto = String((Number(datos.codigo) + 1) % 1000000).padStart(6, '0');
  for (let i = 0; i < 5; i++) assert.equal((await anon.post('/api/auth/restablecer', { usuario: 'luisa', codigo: incorrecto, nueva: 'NuevaClave2026' })).status, 400);
  assert.equal((await anon.post('/api/auth/restablecer', { usuario: 'luisa', codigo: datos.codigo, nueva: 'NuevaClave2026' })).status, 400, 'el código queda invalidado');
  await anon.post('/api/auth/recuperar', { usuario: 'luisa' });
  const nuevo = (await admin.get(`/api/usuarios/${fila.usuario_id}/codigo-recuperacion`)).datos.codigo;
  assert.equal((await anon.post('/api/auth/restablecer', { usuario: 'luisa', codigo: nuevo, nueva: 'NuevaClave2026' })).status, 200);
  await new Cliente().entrar('luisa', 'NuevaClave2026');
});

test('token de API: solo se guarda su huella', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const { datos } = await c.post('/api/configuracion/api-token');
  assert.match(datos.api_token, /^[a-f0-9]{64}$/);
  const cfg = (await c.get('/api/configuracion')).datos;
  assert.ok(!JSON.stringify(cfg).includes(datos.api_token));
  assert.equal(cfg.api_token_hash, undefined);
  const r = await fetch(`${await iniciar()}/api/webhooks/ping`, { headers: { 'X-Api-Token': datos.api_token } });
  assert.equal(r.status, 200);
  const malo = await fetch(`${await iniciar()}/api/webhooks/ping`, { headers: { 'X-Api-Token': 'x'.repeat(64) } });
  assert.equal(malo.status, 401);
});

test('archivos: se valida el contenido real y se bloquea el recorrido de rutas', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const falso = 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await c.post('/api/documentos', { archivo: falso, nombre: 'x.jpg' })).status, 400);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ok = await c.post('/api/documentos', { archivo: png, nombre: '<b>factura</b>.png' });
  assert.equal(ok.status, 201);
  assert.ok(!ok.datos.nombre.includes('<'));
  const f = await c.get(`/api/archivos/${ok.datos.ruta}`);
  assert.equal(f.status, 200);
  assert.match(f.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await c.get('/api/archivos/..%2F..%2F/palmira.db')).status, 404);
  assert.equal((await c.get('/api/archivos/2026/01/..%2F..%2F..%2Fpalmira.db')).status, 404);
});

test('inyección SQL en búsquedas no altera las consultas', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const total = (await c.get('/api/productos')).datos.total;
  const r = await c.get(`/api/productos?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(r.status, 200);
  assert.equal(r.datos.total, 0);
  assert.ok(total > 0);
  assert.equal((await c.get(`/api/clientes?q=${encodeURIComponent("'); DROP TABLE clientes; --")}`)).status, 200);
  assert.ok(getDb().prepare('SELECT COUNT(*) n FROM clientes').get().n > 0);
});

test('cuerpos demasiado grandes se rechazan fuera de las rutas de archivos', async () => {
  const c = new Cliente();
  await c.entrar('admin', CLAVES.admin);
  const r = await c.post('/api/clientes', { nombre: 'x', notas: 'a'.repeat(2 * 1024 * 1024) });
  assert.equal(r.status, 413);
});

test('cierre de sesión invalida el token en el servidor', async () => {
  const c = new Cliente();
  await c.entrar('carlos', CLAVES.carlos);
  const cookie = c.cookie;
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  c.cookie = cookie;
  assert.equal((await c.get('/api/ventas')).status, 401);
});

test('sesión vencida por inactividad', async () => {
  const c = new Cliente();
  await c.entrar('carlos', CLAVES.carlos);
  getDb().prepare("UPDATE sesiones SET ultimo_uso = '2000-01-01 00:00:00'").run();
  assert.equal((await c.get('/api/ventas')).status, 401);
});

test('contraseña temporal: obliga a cambiarla antes de modificar datos', async () => {
  const admin = new Cliente();
  await admin.entrar('admin', CLAVES.admin);
  const nuevo = await admin.post('/api/usuarios', { nombre: 'Temporal', usuario: 'temporal', rol: 'vendedor', clave: 'Provisional2026x' });
  assert.equal(nuevo.status, 201);
  const t = new Cliente();
  const login = await t.entrar('temporal', 'Provisional2026x');
  assert.equal(login.datos.usuario.debe_cambiar_clave, true);
  assert.equal((await t.get('/api/productos')).status, 200);
  const bloqueado = await t.post('/api/clientes', { nombre: 'X' });
  assert.equal(bloqueado.status, 403);
  assert.equal(bloqueado.datos.codigo, 'cambiar_clave');
  assert.equal((await t.post('/api/auth/cambiar-clave', { actual: 'Provisional2026x', nueva: 'Definitiva2026x' })).status, 200);
  assert.equal((await t.post('/api/clientes', { nombre: 'Ya puedo' })).status, 201);
});
