'use strict';
// Historial de auditoría: quién hizo qué, cuándo y con qué datos.

function registrar(db, usuario, accion, entidad, entidadId, detalle, ip) {
  db.prepare('INSERT INTO auditoria(usuario_id, usuario_nombre, accion, entidad, entidad_id, detalle, ip) VALUES (?,?,?,?,?,?,?)')
    .run(usuario ? usuario.id : null, usuario ? usuario.nombre : 'sistema', accion, entidad, entidadId == null ? null : String(entidadId), detalle == null ? null : JSON.stringify(detalle), ip || null);
}

function listar(db, { entidad, entidad_id, usuario_id, desde, hasta, limite = 200 } = {}) {
  const cond = [];
  const params = [];
  if (entidad) { cond.push('entidad = ?'); params.push(entidad); }
  if (entidad_id) { cond.push('entidad_id = ?'); params.push(String(entidad_id)); }
  if (usuario_id) { cond.push('usuario_id = ?'); params.push(usuario_id); }
  if (desde) { cond.push('fecha >= ?'); params.push(desde + ' 00:00:00'); }
  if (hasta) { cond.push('fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const filas = db.prepare(`SELECT * FROM auditoria ${where} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(Number(limite) || 200, 1000));
  for (const f of filas) { try { f.detalle = f.detalle ? JSON.parse(f.detalle) : null; } catch { /* texto plano */ } }
  return filas;
}

module.exports = { registrar, listar };
