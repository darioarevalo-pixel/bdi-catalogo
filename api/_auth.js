// ¿Quien manda este request es alguien del padrón de Areben?
//
// Es el hermano de `_admin.js` un escalón más abajo: `esAdmin` sin la última línea. Existe
// porque los endpoints que escriben en TiendaNube NO son operaciones de administrador — la
// Tabla de talles y las fotos las carga cualquiera con función de marketing, y el sync lo
// disparan los puestos de Depósito y Local. Cerrarlos con `esAdmin` cerraría el agujero
// rompiendo cinco pantallas del monitor.
//
// Los archivos de api/ que empiezan con "_" NO son rutas: Vercel los ignora para el filesystem
// routing y no cuentan contra el límite de 12 funciones del plan. Eso acá no es un detalle: el
// repo está justo en 12, y un archivo con nombre normal frena TODOS los deploys sin error
// visible (sigue sirviendo la versión anterior mientras los commits nuevos mueren).
//
// De dónde saca la credencial, en orden:
//   1. El header `x-monitor-auth`: base64 de un JSON {token} o {user,pass}. Es el sobre que el
//      monitor ya arma en lib/api-fetch.ts, y es el único camino que sirve para los GET y para
//      los POST sin body (el "aplicar categorías" del monitor manda un POST pelado).
//   2. El body, con los mismos nombres que usa `_admin.js` (adminUser/adminPass/adminToken):
//      es el patrón que ya usan comisiones.js, ingresos.js y usuarios.js.

const { emailDelToken, leerCfgUsuarios, usuarioPorEmail, usuarioPorPass } = require('./_admin');

// ── Caché en memoria ─────────────────────────────────────────────────────────
// Sin esto, cada escritura suma una consulta al KV y —si entró con Google— una llamada de red
// al proveedor de identidad. La carga de fotos sube en loop y las categorías se asignan en
// lotes, o sea decenas de POST seguidos. En serverless el módulo sobrevive entre invocaciones
// tibias, así que un caché corto corta casi todo ese costo sin retener nada por mucho tiempo.
const TTL_CFG_MS = 10_000;
const TTL_TOKEN_MS = 5 * 60_000;

let cfgCache = null; // { at, valor }
const tokenCache = new Map(); // token → { at, email }

async function cfgUsuarios() {
  const ahora = Date.now();
  if (cfgCache && ahora - cfgCache.at < TTL_CFG_MS) return cfgCache.valor;
  const valor = await leerCfgUsuarios();
  cfgCache = { at: ahora, valor };
  return valor;
}

async function emailCacheado(token) {
  const ahora = Date.now();
  const hit = tokenCache.get(token);
  if (hit && ahora - hit.at < TTL_TOKEN_MS) return hit.email;
  const email = await emailDelToken(token);
  // Un token que no vale también se cachea: si no, un cliente roto martillaría al proveedor.
  tokenCache.set(token, { at: ahora, email });
  if (tokenCache.size > 200) tokenCache.clear();
  return email;
}

// ── Lectura de la credencial ─────────────────────────────────────────────────

/** Decodifica el sobre base64 del header del monitor. Devuelve {} si no vino o no se entiende. */
function delHeader(req) {
  const raw = req && req.headers && req.headers['x-monitor-auth'];
  if (!raw) return {};
  try {
    const json = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

/** Los tres campos posibles, mirando header y body, con los dos juegos de nombres. */
function credencialDe(req) {
  const h = delHeader(req);
  const b = (req && req.body) || {};
  return {
    token: h.token || h.adminToken || b.token || b.adminToken || null,
    user: h.user || h.adminUser || b.user || b.adminUser || null,
    pass: h.pass || h.adminPass || b.pass || b.adminPass || null,
  };
}

// ── El portero ───────────────────────────────────────────────────────────────

/**
 * El usuario del padrón que manda este request, o `null`. **No exige `admin`**: alcanza con
 * estar en la nómina, que es exactamente el nivel que corresponde acá.
 */
async function usuarioValido(req) {
  const { token, user, pass } = credencialDe(req);
  if (!token && !(user && pass)) return null;
  try {
    const cfg = await cfgUsuarios();
    if (!cfg) return null;
    if (token) {
      const email = await emailCacheado(token);
      return email ? usuarioPorEmail(cfg, email) : null;
    }
    return usuarioPorPass(cfg, user, pass);
  } catch (e) {
    // El portero le suma a estos endpoints una dependencia que antes no tenían (el KV, y el
    // proveedor de identidad si entró con Google). Si alguno se cae, no puede reventar el
    // handler con un 500 crudo: se contesta que no se pudo verificar. Cierra —nadie escribe en
    // la tienda sin poder identificarse— pero lo dice, en vez de parecer un bug del endpoint.
    console.error('[auth] no se pudo verificar la credencial:', (e && e.message) || e);
    return null;
  }
}

/**
 * Guard de una línea para los handlers, al estilo de `exigirUsuario` del monitor.
 *
 * `MODO_AVISO` es el puente entre los dos repos: mientras esté prendido, una llamada sin
 * credencial se REGISTRA pero pasa. Sirve para confirmar en los logs que no quedó ninguna
 * pantalla sin actualizar antes de empezar a rechazar de verdad — así el corte no depende de
 * que nos hayamos acordado de todos los llamadores. Se apaga con AUTH_MODO_AVISO=0.
 */
const MODO_AVISO = process.env.AUTH_MODO_AVISO !== '0';

async function exigirUsuario(req, res, queEs) {
  const u = await usuarioValido(req);
  if (u) return u;
  const ruta = (req && req.url) || '?';
  if (MODO_AVISO) {
    console.warn(`[auth] SIN CREDENCIAL (modo aviso, se deja pasar) — ${req && req.method} ${ruta}${queEs ? ` · ${queEs}` : ''}`);
    return { name: '(sin credencial)', _modoAviso: true };
  }
  console.warn(`[auth] RECHAZADO — ${req && req.method} ${ruta}${queEs ? ` · ${queEs}` : ''}`);
  res.status(403).json({ error: 'No se pudo verificar tu sesión del Monitor. Volvé a entrar y probá de nuevo.' });
  return null;
}

module.exports = { usuarioValido, exigirUsuario, MODO_AVISO };
