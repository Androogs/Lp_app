'use strict';
// Google Ads: adaptador con detección de credenciales. La API de Google Ads exige developer token aprobado, cliente OAuth y
// refresh token del cliente; mientras no se tengan, el módulo trabaja con captura manual. No se simula ningún dato.
const VARIABLES = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'];

const configurado = () => VARIABLES.every((v) => !!(process.env[v] || '').trim());

module.exports = {
  clave: 'google',
  nombre: 'Google Ads',
  variables: VARIABLES,
  instrucciones: [
    'Solicitar un developer token en Google Ads › Herramientas › Centro de API (requiere cuenta de administrador / MCC).',
    'Crear un proyecto en Google Cloud con la API de Google Ads habilitada y credenciales OAuth 2.0 (cliente de escritorio).',
    'Generar el refresh token del usuario que administra la cuenta publicitaria.',
    'Configurar GOOGLE_ADS_DEVELOPER_TOKEN y GOOGLE_ADS_CUSTOMER_ID (sin guiones) en el servidor y reiniciar la aplicación.',
    'La lectura de campañas e inversión (GAQL sobre campaign y metrics) queda pendiente de implementar cuando el cliente entregue las credenciales.',
  ],
  configurado,
  async sincronizar() {
    if (!configurado()) return { estado: 'sin_credenciales', detalle: { mensaje: `Faltan las variables ${VARIABLES.join(' y ')}. Mientras tanto registra la inversión y las métricas a mano en cada campaña.` }, campanas_actualizadas: 0, metricas_insertadas: 0 };
    return { estado: 'error', detalle: { mensaje: 'Integración con Google Ads pendiente de implementar: las credenciales están configuradas pero la lectura de campañas aún no existe.' }, campanas_actualizadas: 0, metricas_insertadas: 0 };
  },
};
