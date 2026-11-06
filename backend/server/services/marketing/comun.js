'use strict';
// Escritura compartida por los adaptadores: campañas que representan a una campaña externa y métricas sincronizadas.
// Así todos graban igual y se cumple la regla "una fila por campaña y día; la sincronización prima sobre la captura manual".
const { ahora, slug } = require('../../util');

// Crea o actualiza la campaña asociada a (plataforma, id_externo). Devuelve { id, creada }.
function upsertCampanaExterna(db, { plataforma, id_externo, nombre, estado, objetivo, fecha_inicio, fecha_fin }) {
  const existente = db.prepare('SELECT id FROM campanas WHERE plataforma = ? AND id_externo = ?').get(plataforma, String(id_externo));
  const nom = String(nombre || `Campaña ${id_externo}`).slice(0, 160);
  if (existente) {
    db.prepare('UPDATE campanas SET nombre = ?, estado = COALESCE(?, estado), objetivo = COALESCE(?, objetivo), fecha_inicio = COALESCE(?, fecha_inicio), fecha_fin = COALESCE(?, fecha_fin), actualizado_en = ? WHERE id = ?')
      .run(nom, estado || null, objetivo || null, fecha_inicio || null, fecha_fin || null, ahora(), existente.id);
    return { id: existente.id, creada: false };
  }
  // utm_campaign único a partir del nombre; si ya existe, se le añade el id externo.
  let utm = slug(nom) || `camp-${id_externo}`;
  if (db.prepare('SELECT 1 FROM campanas WHERE utm_campaign = ?').get(utm)) utm = `${utm}-${slug(String(id_externo))}`.slice(0, 120);
  const r = db.prepare(`INSERT INTO campanas(nombre, plataforma, objetivo, estado, fecha_inicio, fecha_fin, utm_source, utm_medium, utm_campaign, id_externo, observaciones)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(nom, plataforma, objetivo || null, estado || 'activa', fecha_inicio || null, fecha_fin || null, plataforma, 'cpc', utm, String(id_externo), `Creada por la sincronización con ${plataforma} el ${ahora()}`);
  return { id: Number(r.lastInsertRowid), creada: true };
}

// Inserta o reemplaza la métrica sincronizada de una campaña y un día (origen 'sincronizacion').
function upsertMetricaSincronizada(db, campanaId, fecha, { impresiones = null, alcance = null, clics = null, gasto = 0, conversaciones = null, resultados = null } = {}) {
  db.prepare(`INSERT INTO campana_metricas(campana_id, fecha, impresiones, alcance, clics, gasto, conversaciones, resultados, origen, creado_en)
              VALUES (?,?,?,?,?,?,?,?,'sincronizacion',?)
              ON CONFLICT(campana_id, fecha, origen) DO UPDATE SET impresiones = excluded.impresiones, alcance = excluded.alcance, clics = excluded.clics, gasto = excluded.gasto, conversaciones = excluded.conversaciones, resultados = excluded.resultados, creado_en = excluded.creado_en`)
    .run(campanaId, fecha, impresiones, alcance, clics, Math.max(0, Math.round(Number(gasto) || 0)), conversaciones, resultados, ahora());
}

module.exports = { upsertCampanaExterna, upsertMetricaSincronizada };
