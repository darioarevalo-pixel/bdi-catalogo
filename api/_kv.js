// Lectura/escritura de la config del catálogo en el KV.
//
// Vivía suelta adentro de config.js. La sacamos acá porque ahora el proxy también
// necesita leer la config (para descontar los topes de stock antes de crear una
// venta) y no queremos dos copias de las mismas 8 líneas desincronizándose.
//
// Los archivos de api/ que empiezan con "_" NO son rutas: Vercel los ignora para el
// filesystem routing y no cuentan contra el límite de 12 funciones del plan Hobby
// (el repo está justo en 12). Ver la nota larga en _auth.js.

const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const CONFIG_KEY = process.env.CONFIG_KEY || 'catalog-config';

// ---------------------------------------------------------------------------
// UN ERROR DEL KV TIENE QUE PARECER UN ERROR
//
// Hasta el 3-8-2026 acá se hacía `return r.json()` sin mirar si la respuesta había
// venido bien. El KV puede contestar un error (token vencido, límite del plan,
// Upstash caído) y ese error se leía como si fuera un dato válido. Como el error de
// Upstash viene en `{ error: ... }` y nunca en `{ result: ... }`, quien llamaba
// entendía cualquier falla como "no hay nada guardado", que es otra cosa muy
// distinta. Las cuatro consecuencias medidas:
//
//  · `tomarTurno` leía el error como "el turno está ocupado" y se quedaba
//    reintentando los 8 segundos completos antes de rendirse. Con el KV con
//    problemas, TODOS los pedidos se arrastraban 8 s de más.
//  · El proxy leía "sin config" y se quedaba SIN TOPES y sin excepciones de
//    precio, en silencio y sin dejar rastro en el registro.
//  · El panel decía "✓ Guardado" sin haber guardado nada: config.js daba por buena
//    la respuesta de `kvSet` y contestaba `{ ok: true }`.
//  · Se apagaba el control de "otra sesión guardó en el medio" (config.js compara
//    contra el `updatedAt` guardado; si esa lectura falla y devuelve null, no hay
//    contra qué comparar y se guarda encima de lo del otro).
//
// La distinción que SÍ hay que mantener es la de siempre: `null` significa "el KV
// no está configurado" (y entonces se sigue como antes, sin trabar a nadie); una
// excepción significa "el KV está y contestó mal". Los que llaman ya saben qué
// hacer con cada caso: todos tienen su try/catch con un valor seguro. Lo único que
// les faltaba era enterarse.
async function respuesta(r, que) {
  const texto = await r.text();
  let d = null;
  try { d = texto ? JSON.parse(texto) : null; } catch { /* no vino JSON */ }
  if (!r.ok || d === null || d.error) {
    const detalle = (d && d.error) || texto.slice(0, 200) || '(sin cuerpo)';
    // Se avisa también acá y no solo donde se llama: config.js tiene dos `catch`
    // vacíos a propósito (el catálogo sigue andando sin config) y sin esta línea
    // una falla del KV no dejaría rastro en ningún lado.
    console.error(`[kv] ${que} falló (HTTP ${r.status}): ${detalle}`);
    throw new Error(`El almacén de datos no respondió bien (${r.status})`);
  }
  return d;
}

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${CONFIG_KEY}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const d = await respuesta(r, `GET ${CONFIG_KEY}`);
  return d.result ? JSON.parse(d.result) : null;
}

// Un comando suelto contra el KV (formato de Upstash: ["SET", clave, valor, ...]).
// Devuelve `null` —y NO revienta— cuando el KV no está configurado, para que quien
// llama pueda distinguir "el KV no está" de "el KV contestó que no".
// Si el KV SÍ está y la respuesta viene mal, tira excepción (ver la nota de arriba).
async function kvCmd(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return respuesta(r, String((cmd && cmd[0]) || 'comando').toUpperCase());
}

async function kvSet(value) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV no configurado');
  return kvCmd(['SET', CONFIG_KEY, JSON.stringify(value)]);
}

module.exports = { kvGet, kvSet, kvCmd };
