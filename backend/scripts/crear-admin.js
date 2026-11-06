'use strict';
// Crea (o restablece) un usuario administrador desde la terminal.
//   npm run crear-admin                         → pregunta usuario, nombre y contraseña (oculta)
//   npm run crear-admin -- --usuario=ana --nombre="Ana Pérez"   (la contraseña se pide oculta o se lee de PALMIRA_CLAVE)
// Si el usuario ya existe, se le asigna la contraseña nueva, rol administrador y se desbloquea.
const readline = require('node:readline');
const { getDb, cerrarDb } = require('../server/db');
const seg = require('../server/seguridad');
const { ahora } = require('../server/util');

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : ''; };

function preguntar(texto, oculto = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) rl._writeToOutput = (s) => { if (s.includes(texto)) process.stdout.write(s); else process.stdout.write('*'); };
    rl.question(texto, (r) => { rl.close(); if (oculto) process.stdout.write('\n'); resolve(r.trim()); });
  });
}

(async () => {
  const usuario = (arg('usuario') || await preguntar('Usuario (ej. admin): ')).toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) throw new Error('Usuario inválido: usa letras sin tilde, números, punto o guion (mínimo 3).');
  const nombre = arg('nombre') || await preguntar('Nombre completo: ') || 'Administrador';
  let clave = process.env.PALMIRA_CLAVE || '';
  if (!clave) {
    clave = await preguntar('Contraseña: ', true);
    const repetir = await preguntar('Repite la contraseña: ', true);
    if (clave !== repetir) throw new Error('Las contraseñas no coinciden.');
  }
  seg.validarFortaleza(clave, { usuario });
  const db = getDb();
  const hash = seg.hashClaveSync(clave);
  const existe = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario);
  if (existe) {
    db.prepare("UPDATE usuarios SET password_hash = ?, rol = 'admin', activo = 1, intentos_fallidos = 0, bloqueado_hasta = NULL, clave_cambiada_en = ? WHERE id = ?").run(hash, ahora(), existe.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(existe.id);
    console.log(`Usuario "${usuario}" actualizado como administrador con la contraseña nueva.`);
  } else {
    db.prepare("INSERT INTO usuarios(nombre, usuario, password_hash, rol, tipo_comercial, clave_cambiada_en) VALUES (?,?,?,'admin','empleador',?)").run(nombre.slice(0, 120), usuario, hash, ahora());
    console.log(`Administrador "${usuario}" creado.`);
  }
  require('../server/services/productos').asegurarCategorias(db);
  cerrarDb();
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
