// Quién es administrador, en un solo lugar.
//
// Los archivos de api/ que empiezan con "_" NO son rutas: Vercel los ignora para el
// filesystem routing (y no cuentan contra el límite de funciones del plan), así que
// quedan como módulo importable.
//
// Antes esto estaba copiado en usuarios.js, ingresos.js y comisiones.js: tres veces la
// misma consulta al KV y tres copias del mismo BOOTSTRAP hardcodeado. Con el ingreso con
// Google hay una segunda forma de identificarse, y sumarla tres veces habría sido
// consagrar la duplicación — de paso, el día que se borre el bootstrap o se hasheen las
// contraseñas se toca acá y vale para los tres.
//
// Dos formas de identificarse, ambas válidas:
//   - {adminUser, adminPass}  el par de siempre, contra el KV.
//   - {adminToken}            un token del proveedor de identidad de Areben (el proyecto
//                             Supabase del dashboard), que se traduce a un usuario del KV
//                             por mail. Es el mismo token con el que se entra al monitor,
//                             a producción y al dashboard.

const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const KEY = 'cfg:usuarios';

// Proveedor de identidad. La key es la publishable/anon, pública por diseño (viaja en el
// browser en cualquier flujo de OAuth). El override por env permite mudar de proveedor
// sin deployar. La misma pareja está en monitor-areben/lib/identidad.ts.
const IDP_URL = process.env.IDP_SUPABASE_URL || 'https://tysdjzbaskfankmpreqe.supabase.co';
const IDP_KEY = process.env.IDP_SUPABASE_ANON_KEY || 'sb_publishable_He6-ikWyPxobbqg1AgrXng_Jw9bT5Iq';

const BOOTSTRAP = { 'Bruno Arevalo': 'BDI123456', 'Dario Arevalo': 'BDI123456' };

async function kvCmd(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  return d.result;
}

/** La config de usuarios del KV, o null si nunca se guardó. */
async function leerCfgUsuarios() {
  const raw = await kvCmd(['GET', KEY]);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Email de un token del proveedor, o null si el token no vale.
 *
 * Se le pregunta al proveedor en vez de verificar la firma localmente: es una llamada de
 * red por validación, pero estos endpoints ya hacían una al KV por request, así que no
 * cambia el modo de falla, y evita meter una dependencia de JWKS en funciones que hoy no
 * tienen ninguna. Contrapartida: si el proveedor se cae, el ingreso con Google deja de
 * andar (el de contraseña no depende de él).
 */
async function emailDelToken(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${IDP_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: IDP_KEY },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const email = String((d && d.email) || '').toLowerCase().trim();
    return email || null;
  } catch {
    return null;
  }
}

/** El usuario del KV con ese mail (case-insensitive). El mail es la única clave que cruza apps. */
function usuarioPorEmail(cfg, email) {
  if (!email || !cfg || !Array.isArray(cfg.users)) return null;
  return cfg.users.find(u => String(u.email || '').toLowerCase().trim() === email) || null;
}

/** El usuario del KV con ese nombre y esa contraseña. */
function usuarioPorPass(cfg, user, pass) {
  if (!user || !pass || !cfg || !Array.isArray(cfg.users)) return null;
  return cfg.users.find(u => u.name === user && u.pass === pass) || null;
}

/**
 * ¿Quien manda este request es administrador?
 *
 * `cfg` es opcional: si el llamador ya la leyó, se la pasa y evita una segunda consulta.
 * Sin token, el comportamiento es exactamente el de antes, bootstrap incluido.
 */
async function esAdmin(body, cfg) {
  const b = body || {};
  const config = cfg !== undefined ? cfg : await leerCfgUsuarios();

  if (b.adminToken) {
    const u = usuarioPorEmail(config, await emailDelToken(b.adminToken));
    return !!(u && u.admin);
  }
  if (config && Array.isArray(config.users)) {
    const u = usuarioPorPass(config, b.adminUser, b.adminPass);
    return !!(u && u.admin);
  }
  return !!(BOOTSTRAP[b.adminUser] && BOOTSTRAP[b.adminUser] === b.adminPass);
}

module.exports = { esAdmin, emailDelToken, usuarioPorEmail, usuarioPorPass, leerCfgUsuarios, BOOTSTRAP };
