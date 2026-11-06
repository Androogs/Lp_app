'use strict';
// TikTok Ads: adaptador con detección de credenciales. La Marketing API de TikTok requiere una app aprobada y el token de
// acceso del anunciante; mientras no se tengan, el módulo trabaja con captura manual. No se simula ningún dato.
const VARIABLES = ['TIKTOK_ADS_TOKEN', 'TIKTOK_ADS_ADVERTISER_ID'];

const configurado = () => VARIABLES.every((v) => !!(process.env[v] || '').trim());

module.exports = {
  clave: 'tiktok',
  nombre: 'TikTok Ads',
  variables: VARIABLES,
  instrucciones: [
    'Crear una app en TikTok for Business › Marketing API y solicitar acceso a los reportes (scope Reporting).',
    'Autorizar la cuenta publicitaria y obtener el access token de larga duración y el advertiser_id.',
    'Configurar TIKTOK_ADS_TOKEN y TIKTOK_ADS_ADVERTISER_ID en el servidor y reiniciar la aplicación.',
    'La lectura de campañas e inversión (endpoint /report/integrated/get) queda pendiente de implementar cuando el cliente entregue las credenciales.',
  ],
  configurado,
  async sincronizar() {
    if (!configurado()) return { estado: 'sin_credenciales', detalle: { mensaje: `Faltan las variables ${VARIABLES.join(' y ')}. Mientras tanto registra la inversión y las métricas a mano en cada campaña.` }, campanas_actualizadas: 0, metricas_insertadas: 0 };
    return { estado: 'error', detalle: { mensaje: 'Integración con TikTok Ads pendiente de implementar: las credenciales están configuradas pero la lectura de campañas aún no existe.' }, campanas_actualizadas: 0, metricas_insertadas: 0 };
  },
};
