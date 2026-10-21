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

const crypto = require('crypto');

const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const KEY = 'cfg:usuarios';

// Proveedor de identidad. La key es la publishable/anon, pública por diseño (viaja en el
// browser en cualquier flujo de OAuth). El override por env permite mudar de proveedor
// sin deployar. La misma pareja está en monitor-areben/lib/identidad.ts.
const IDP_URL = process.env.IDP_SUPABASE_URL || 'https://tysdjzbaskfankmpreqe.supabase.co';
const IDP_KEY = process.env.IDP_SUPABASE_ANON_KEY || 'sb_publishable_He6-ikWyPxobbqg1AgrXng_Jw9bT5Iq';

// Ya no hay usuarios de arranque hardcodeados. Había un `BOOTSTRAP` con
// {'Bruno Arevalo': 'BDI123456', 'Dario Arevalo': 'BDI123456'}, copiado en tres endpoints,
// que dejaba entrar como admin a cualquiera que abriera el repo. No hacía falta: las dos
// cuentas existen en el KV con admin, y entraban por su fila. Si algún día el KV quedara
// vacío, la salida es cargar un usuario a mano ahí, no una puerta en el código.

// ── Contraseñas ──────────────────────────────────────────────────────────────
// Se guardan hasheadas con scrypt (viene en Node, cero dependencias): salt propio por
// usuario y comparación en tiempo constante. Un hash NO se puede volver a leer, así que
// la pantalla de gestión dejó de mostrar contraseñas y pasó a "poner una nueva".
//
// `verificarPass` acepta además el formato viejo (texto plano) para no dejar afuera a
// nadie durante la transición: quien entra con una contraseña sin hashear valida bien y
// el login la re-guarda hasheada en el acto (ver `action:'login'` en usuarios.js). La
// migración ocurre sola, usuario por usuario, sin script y sin ventana en la que nadie
// pueda entrar. Cuando no quede ninguna en texto plano, este camino se puede borrar.
const PREFIJO_HASH = 'scrypt$';

function hashearPass(plano) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plano), salt, 64).toString('hex');
  return `${PREFIJO_HASH}${salt}$${hash}`;
}

function estaHasheada(guardada) {
  return typeof guardada === 'string' && guardada.startsWith(PREFIJO_HASH);
}

function verificarPass(plano, guardada) {
  if (!plano || !guardada) return false;
  if (!estaHasheada(guardada)) return String(guardada) === String(plano); // formato viejo
  const [, salt, hash] = String(guardada).split('$');
  if (!salt || !hash) return false;
  const esperado = Buffer.from(hash, 'hex');
  const calculado = crypto.scryptSync(String(plano), salt, esperado.length);
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

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

// ── El freno a probar contraseñas ────────────────────────────────────────────
// Hasta el 21-oct este login contestaba sin límite: con un programa se podían probar miles de
// claves por minuto contra un usuario, y los que entran con contraseña son justo los puestos
// compartidos (Depósito, Local, bdilocal), los que manejan la Caja.
//
// Se cuentan las contraseñas DISTINTAS que fallaron para un usuario, ⛔ los intentos: el Monitor
// manda la credencial en CADA request, así que una compu con la clave vieja guardada falla cientos
// de veces seguidas — pero siempre con la misma, y eso suma 1. Adivinar exige claves distintas.
// Va por usuario y ⛔ por IP: cuando el pedido viene del Monitor, la IP que se ve acá es la de
// Vercel, la misma para todo el equipo.
//
// El precio: quien conozca un nombre de usuario puede trabarlo `FRENO_SEG` errando a propósito.
// Es la contraparte de no dejar adivinar, y dura 15 minutos.
const FRENO_DISTINTAS = 10;
const FRENO_SEG = 15 * 60;

const claveFreno = user => String(user).slice(0, 80);
const huella = pass => crypto.createHash('sha256').update(String(pass)).digest('hex').slice(0, 16);

/** ¿Este usuario está frenado? Si el KV no contesta, ⛔ frena: el login sigue igual que antes. */
async function frenado(user, ns = 'login') {
  try {
    return !!(await kvCmd(['GET', `${ns}:freno:${claveFreno(user)}`]));
  } catch {
    return false;
  }
}

/** Anota una contraseña fallida; a la `FRENO_DISTINTAS`-ésima distinta, frena al usuario. */
async function anotarFallo(user, pass, ns = 'login') {
  const k = claveFreno(user);
  try {
    // Ya anotada (la compu con la clave vieja): nada más que hacer, y son 2 consultas y ⛔ 5.
    if (!(await kvCmd(['SADD', `${ns}:fallos:${k}`, huella(pass)]))) return;
    await kvCmd(['EXPIRE', `${ns}:fallos:${k}`, FRENO_SEG]);
    const distintas = await kvCmd(['SCARD', `${ns}:fallos:${k}`]);
    if (distintas >= FRENO_DISTINTAS) {
      await kvCmd(['SET', `${ns}:freno:${k}`, '1', 'EX', FRENO_SEG]);
      await kvCmd(['DEL', `${ns}:fallos:${k}`]);
      console.warn(`[${ns}] frenado ${FRENO_SEG / 60} min: ${distintas} contraseñas distintas fallidas`);
    }
  } catch {
    /* que un tropiezo del contador ⛔ tire el login */
  }
}

/**
 * El usuario del KV con ese nombre, si la contraseña verifica y ⛔ está frenado.
 *
 * Frenado, contesta `null` SIN mirar la contraseña: si la mirara, el que prueba claves igual
 * se enteraría de cuál era la buena.
 */
async function usuarioPorPass(cfg, user, pass) {
  if (!user || !pass || !cfg || !Array.isArray(cfg.users)) return null;
  if (await frenado(user)) return null;
  const u = cfg.users.find(x => x.name === user);
  if (u && verificarPass(pass, u.pass)) return u;
  await anotarFallo(user, pass);
  return null;
}

/**
 * ¿El request trae la contraseña del panel (`x-admin-password`, la de `ADMIN_PASSWORD` en Vercel)?
 *
 * Es una clave fija, sin usuario, y hasta el 21-oct se comparaba sin límite en config, pedido y
 * proxy. Ahora pasa por el mismo freno que el login: 10 claves DISTINTAS fallidas en 15 min frenan
 * EL PANEL 15 min, y frenado contesta false sin mirar la clave. El precio es el mismo que el del
 * login —quien quiera puede trabar el panel 15 min—; ⛔ por IP porque la IP se puede cambiar.
 * Sin el header no cuenta nada: la mayoría de los requests son de la tienda y no lo traen.
 */
async function claveDelPanelOk(req) {
  const pass = req.headers['x-admin-password'];
  const buena = process.env.ADMIN_PASSWORD || '';
  if (!buena || !pass) return false;
  if (await frenado('clave', 'panel')) return false;
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  if (crypto.timingSafeEqual(h(pass), h(buena))) return true;
  await anotarFallo('clave', pass, 'panel');
  return false;
}

/**
 * La FILA del KV de quien manda este request (por token o por usuario+contraseña), o null.
 *
 * Trae el usuario entero —`admin`, `acceso`, `funcion`— y no solo un booleano, porque hay
 * endpoints que ya no se contestan con "¿es admin?": Ingresos, por ejemplo, distingue entre poner
 * el nombre comercial de un diseño y manejar la importación. Antes eso no se podía preguntar sin
 * volver a leer el KV a mano.
 *
 * `cfg` es opcional: si el llamador ya la leyó, se la pasa y evita una segunda consulta.
 */
async function usuarioDe(body, cfg) {
  const b = body || {};
  const config = cfg !== undefined ? cfg : await leerCfgUsuarios();
  return b.adminToken
    ? usuarioPorEmail(config, await emailDelToken(b.adminToken))
    : await usuarioPorPass(config, b.adminUser, b.adminPass);
}

/**
 * ¿Quien manda este request es administrador?
 *
 * `cfg` es opcional: si el llamador ya la leyó, se la pasa y evita una segunda consulta.
 * Sin token, el comportamiento es exactamente el de antes, bootstrap incluido.
 */
async function esAdmin(body, cfg) {
  const u = await usuarioDe(body, cfg);
  return !!(u && u.admin);
}

/**
 * ¿Tiene tildado el sub-permiso `key` en `store`? (`'ingresos.editar'`).
 *
 * ⚠️ Es el equivalente de `puedeSub` del monitor (`lib/permisos.core.js`), que NO se puede
 * importar desde acá: son dos deploys distintos. La equivalencia se sostiene porque los SUB
 * permisos nunca se heredan de la función —`ACCESO_POR_FUNCION` expande áreas a claves de sección,
 * nunca a subclaves—, así que para un `x.y` "admin o tilde explícita" es exactamente lo mismo que
 * `puedeSub`. Si algún día la función empezara a dar subs, esto se queda corto y hay que volver.
 * La exclusión negativa (`-clave`) se respeta igual que allá.
 */
function tieneSub(u, store, key) {
  if (!u) return false;
  if (u.admin) return true;
  const acc = (u.acceso && u.acceso[store]) || {};
  return !!acc[key] && !acc['-' + key];
}

module.exports = {
  esAdmin,
  claveDelPanelOk,
  usuarioDe,
  tieneSub,
  emailDelToken,
  usuarioPorEmail,
  usuarioPorPass,
  leerCfgUsuarios,
  hashearPass,
  estaHasheada,
  verificarPass,
};
