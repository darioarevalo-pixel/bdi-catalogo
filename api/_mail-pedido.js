// ---------------------------------------------------------------------------
// LOS MAILS DE UN PEDIDO
//
// Pedido de Darío (30-9-2026): que a cada cliente le llegue un mail con la
// compra que hizo, y a nosotros un aviso de que entró un pedido. Salen por
// Amazon SES (ver _ses.js). Siempre SES: es la decisión de Bruno.
//
// Variables en Vercel:
//   · las de AWS de _ses.js → sin ellas no se manda nada (y el pedido sigue igual).
//   · MAIL_FROM       → quién firma. Por defecto BDI Accesorios <info@bdiaccesorios.com.ar>.
//                       El usuario de AWS SOLO puede mandar desde esa dirección.
//   · MAIL_REPLY_TO   → opcional: a dónde va si el cliente contesta.
//
// Qué sale y a quién lo decide el PANEL (Configuración): `mailCliente`,
// `mailAviso` y `mailAvisoA` (las direcciones del aviso, separadas por coma).
// PEDIDOS_AVISO_A en Vercel es sólo el respaldo si el panel no tiene ninguna.
//
// Los renglones van AGRUPADOS POR PRODUCTO: un pedido mayorista son muchos
// colores del mismo modelo, y una foto por renglón hacía un mail interminable
// con la misma foto repetida.
// ---------------------------------------------------------------------------
const SES = require('./_ses.js');

const MAIL_FROM = process.env.MAIL_FROM || 'BDI Accesorios <info@bdiaccesorios.com.ar>';

/** Formato mínimo razonable; el que manda de verdad es el proveedor. */
function mailValido(m) {
  return typeof m === 'string' && m.length <= 200 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(m);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pesos(n) {
  const v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString('es-AR');
}

// La foto guardada es la ORIGINAL (puede pesar 600 KB). Se achica con el mismo
// optimizador del catálogo, pero en JPG: Outlook no muestra WebP. Mismos
// dominios permitidos que el catálogo (index.html, DOMINIOS_FOTO): otro
// dominio va tal cual.
const DOMINIOS_FOTO = ['mitiendanube.com', 'user-sheet.s3.sa-east-1.amazonaws.com'];
function fotoChica(src) {
  if (!src || typeof src !== 'string' || !/^https?:\/\//.test(src)) return '';
  let host;
  try { host = new URL(src).hostname.toLowerCase(); } catch (e) { return ''; }
  if (!DOMINIOS_FOTO.some(d => host === d || host.endsWith('.' + d))) return src;
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(src.replace(/^https?:\/\//, '')) +
    '&w=128&h=128&fit=cover&output=jpg&q=75';
}

/** Junta los renglones por producto, en el orden en que aparecen. */
function agrupar(items) {
  const grupos = [];
  const porNombre = {};
  items.forEach(i => {
    const n = String(i.nombre || '');
    if (!porNombre[n]) { porNombre[n] = { nombre: n, img: '', variantes: [], unidades: 0, importe: 0 }; grupos.push(porNombre[n]); }
    const g = porNombre[n];
    const cant = Number(i.cantidad) || 0;
    if (!g.img && i.img) g.img = i.img;
    g.variantes.push({ nombre: i.variante || '', cantidad: cant });
    g.unidades += cant;
    g.importe += (Number(i.precio) || 0) * cant;
  });
  return grupos;
}

const C = { tinta: '#1a1a1a', gris: '#6b6b6b', linea: '#e6e6e6', fondo: '#f4f4f4', acento: '#111111' };

function filaProducto(g) {
  const foto = fotoChica(g.img);
  const variantes = g.variantes
    .map(v => (v.nombre ? esc(v.nombre) + ' ×' + v.cantidad : '×' + v.cantidad))
    .join(' &nbsp;·&nbsp; ');
  return '<tr>' +
    '<td width="72" valign="top" style="padding:12px 12px 12px 0;border-bottom:1px solid ' + C.linea + '">' +
      (foto
        ? '<img src="' + esc(foto) + '" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border-radius:6px;object-fit:cover;background:' + C.fondo + '">'
        : '<div style="width:64px;height:64px;border-radius:6px;background:' + C.fondo + '"></div>') +
    '</td>' +
    '<td valign="top" style="padding:12px 0;border-bottom:1px solid ' + C.linea + ';font-size:14px;color:' + C.tinta + '">' +
      '<div style="font-weight:bold;margin-bottom:4px">' + esc(g.nombre) + '</div>' +
      '<div style="color:' + C.gris + ';font-size:13px;line-height:1.5">' + variantes + '</div>' +
    '</td>' +
    '<td valign="top" align="right" style="padding:12px 0 12px 12px;border-bottom:1px solid ' + C.linea + ';font-size:14px;color:' + C.tinta + ';white-space:nowrap">' +
      '<div style="font-weight:bold">' + pesos(g.importe) + '</div>' +
      '<div style="color:' + C.gris + ';font-size:12px">' + g.unidades + ' u.</div>' +
    '</td>' +
  '</tr>';
}

function renglonTotal(etiqueta, valor, fuerte) {
  const estilo = fuerte ? 'font-size:17px;font-weight:bold;padding-top:10px' : 'font-size:14px;color:' + C.gris;
  return '<tr><td style="' + estilo + '">' + etiqueta + '</td><td align="right" style="' + estilo + '">' + valor + '</td></tr>';
}

/**
 * El cuerpo compartido. `interno` agrega lo que el cliente no ve: teléfono con
 * link a WhatsApp y lo que se le cayó del carrito por stock.
 */
function armarCuerpo(pedido, link, logo, interno) {
  const items = Array.isArray(pedido.items) ? pedido.items : [];
  const grupos = agrupar(items);
  const unidades = grupos.reduce((s, g) => s + g.unidades, 0);
  const cupon = pedido.cupon || null;
  const descuento = cupon && cupon.descuento ? Number(cupon.descuento) : 0;
  const nombre = String(pedido.cliente || '').trim().split(/\s+/)[0];

  const titulo = interno
    ? 'Entró un pedido: ' + esc(pedido.cliente || 'sin nombre')
    : '¡Recibimos tu pedido' + (nombre ? ', ' + esc(nombre) : '') + '!';
  const bajada = interno
    ? ''
    : '<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:' + C.tinta + '">Ya lo tenemos. Te vamos a escribir por WhatsApp para coordinar el pago y la entrega.</p>';

  let bloqueInterno = '';
  if (interno) {
    const tel = String(pedido.telefono || '').replace(/\D/g, '');
    const wa = tel ? 'https://wa.me/' + (tel.startsWith('54') ? tel : '549' + tel) : '';
    bloqueInterno =
      '<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:14px;background:' + C.fondo + ';border-radius:8px"><tr><td style="padding:14px 16px;line-height:1.7">' +
        '<b>Cliente:</b> ' + esc(pedido.cliente) + '<br>' +
        '<b>Teléfono:</b> ' + (wa ? '<a href="' + esc(wa) + '" style="color:' + C.acento + '">' + esc(pedido.telefono) + '</a> (WhatsApp)' : esc(pedido.telefono)) + '<br>' +
        '<b>Email:</b> ' + esc(pedido.email || '—') +
      '</td></tr></table>';
    const falt = Array.isArray(pedido.faltantes) ? pedido.faltantes : [];
    if (falt.length) {
      bloqueInterno +=
        '<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:13px;background:#fff4e5;border-radius:8px"><tr><td style="padding:14px 16px;line-height:1.6">' +
          '<b>Se le cayó del carrito por stock (' + falt.length + '):</b><br>' +
          falt.map(f => '· ' + esc(f.nombre) + (f.variante ? ' — ' + esc(f.variante) : '') +
            ' (pidió ' + (Number(f.pedido) || 0) + ', había ' + (Number(f.disponible) || 0) + ')').join('<br>') +
        '</td></tr></table>';
    }
  }

  const boton = link
    ? '<table cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="background:' + C.acento + ';border-radius:6px">' +
        '<a href="' + esc(link) + '" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px">' +
        (interno ? 'Abrir el pedido' : 'Ver mi pedido') + '</a></td></tr></table>'
    : '';

  const totales =
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;color:' + C.tinta + '">' +
      (descuento
        ? renglonTotal('Subtotal', pesos(pedido.subtotal)) +
          renglonTotal('Cupón ' + esc(cupon.codigo), '−' + pesos(descuento))
        : '') +
      (cupon && cupon.tipo === 'envio' ? renglonTotal('Envío bonificado (' + esc(cupon.codigo) + ')', '') : '') +
      renglonTotal('Total', pesos(pedido.total), true) +
    '</table>';

  const datos =
    '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;font-size:14px;color:' + C.tinta + ';border-top:1px solid ' + C.linea + '"><tr><td style="padding-top:14px;line-height:1.7">' +
      '<b>Pago:</b> ' + esc(pedido.pago) + '<br>' +
      '<b>Entrega:</b> ' + esc(pedido.entrega) +
      (pedido.obs ? '<br><b>Observaciones:</b> ' + esc(pedido.obs) : '') +
    '</td></tr></table>';

  const pie = interno
    ? ''
    : '<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:' + C.gris + '">Si hay que corregir algo del pedido (por ejemplo, por stock), el link se actualiza solo. Guardalo: está disponible durante 90 días.</p>';

  return '<!doctype html><html><body style="margin:0;padding:0;background:' + C.fondo + '">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:' + C.fondo + '"><tr><td align="center" style="padding:24px 12px">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;font-family:Arial,Helvetica,sans-serif">' +
      '<tr><td align="center" style="padding:24px 24px 8px">' +
        (logo ? '<img src="' + esc(logo) + '" alt="BDI Accesorios" width="120" height="72" style="display:block;width:120px;height:72px">' : '<b>BDI Accesorios</b>') +
      '</td></tr>' +
      '<tr><td style="padding:16px 24px 28px">' +
        '<h1 style="margin:0 0 6px;font-size:22px;color:' + C.tinta + '">' + titulo + '</h1>' +
        '<p style="margin:0 0 18px;font-size:14px;color:' + C.gris + '">Pedido N° <b style="color:' + C.tinta + '">' + esc(pedido.id) + '</b> · ' +
          grupos.length + (grupos.length === 1 ? ' producto' : ' productos') + ' · ' + unidades + ' unidades</p>' +
        bajada + bloqueInterno + boton +
        '<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ' + C.linea + '">' +
          grupos.map(filaProducto).join('') +
        '</table>' +
        totales + datos + pie +
      '</td></tr>' +
    '</table>' +
    '<p style="margin:14px 0 0;font-size:11px;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif">BDI Accesorios · Catálogo mayorista</p>' +
    '</td></tr></table></body></html>';
}

function armarTexto(pedido, link, interno) {
  const grupos = agrupar(Array.isArray(pedido.items) ? pedido.items : []);
  return (interno ? 'Entró un pedido: ' + (pedido.cliente || '') + '\nTeléfono: ' + (pedido.telefono || '') + '\nEmail: ' + (pedido.email || '') + '\n\n'
                  : '¡Recibimos tu pedido!\n\n') +
    'Pedido N° ' + pedido.id + '\n\n' +
    grupos.map(g => '· ' + g.nombre + ' — ' + g.variantes.map(v => (v.nombre ? v.nombre + ' x' : 'x') + v.cantidad).join(', ') + ' — ' + pesos(g.importe)).join('\n') +
    '\n\nTotal: ' + pesos(pedido.total) + '\nPago: ' + (pedido.pago || '') + '\nEntrega: ' + (pedido.entrega || '') +
    (pedido.obs ? '\nObservaciones: ' + pedido.obs : '') +
    (link ? '\n\n' + (interno ? 'Abrir el pedido: ' : 'Ver mi pedido: ') + link : '') +
    (interno ? '' : '\n\nTe vamos a escribir por WhatsApp para coordinar.');
}

/** El mail del cliente: { asunto, html, texto }. */
function armarMail(pedido, link, logo) {
  return {
    asunto: 'Recibimos tu pedido N° ' + pedido.id + ' — BDI Accesorios',
    html: armarCuerpo(pedido, link, logo, false),
    texto: armarTexto(pedido, link, false),
  };
}

/** El aviso interno: el asunto se lee sin abrir el mail. */
function armarAviso(pedido, link, logo) {
  const unidades = (Array.isArray(pedido.items) ? pedido.items : []).reduce((s, i) => s + (Number(i.cantidad) || 0), 0);
  return {
    asunto: '🛒 Nuevo pedido N° ' + pedido.id + ' — ' + (pedido.cliente || 'sin nombre') + ' — ' + pesos(pedido.total) + ' (' + unidades + ' u.)',
    html: armarCuerpo(pedido, link, logo, true),
    texto: armarTexto(pedido, link, true),
  };
}

/** Manda el mail al cliente. Devuelve { ok } o { ok:false, motivo }. Nunca tira. */
async function mandarMailPedido(pedido, link, logo) {
  if (!mailValido(pedido.email)) return { ok: false, motivo: 'mail inválido' };
  const { asunto, html, texto } = armarMail(pedido, link, logo);
  return SES.mandarMail({
    from: MAIL_FROM, to: pedido.email, subject: asunto, html, text: texto,
    replyTo: process.env.MAIL_REPLY_TO || '',
  });
}

/** A quién le llega el aviso interno. */
function destinatariosAviso(delPanel) {
  const lista = (s) => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(mailValido);
  const panel = lista(delPanel);
  return panel.length ? panel : lista(process.env.PEDIDOS_AVISO_A);
}

/** Manda el aviso interno. Si no hay a quién, no hace nada. Nunca tira. */
async function mandarAvisoPedido(pedido, link, logo, delPanel) {
  const a = destinatariosAviso(delPanel);
  if (!a.length) return { ok: false, motivo: 'sin destinatarios' };
  const { asunto, html, texto } = armarAviso(pedido, link, logo);
  const r = await Promise.all(a.map(to => SES.mandarMail({
    from: MAIL_FROM, to, subject: asunto, html, text: texto,
    // Contestar el aviso le escribe al cliente.
    replyTo: mailValido(pedido.email) ? pedido.email : '',
  })));
  const mal = r.filter(x => !x.ok);
  return mal.length ? { ok: false, motivo: mal.map(x => x.motivo).join(' | ') } : { ok: true };
}

module.exports = { mailValido, armarMail, armarAviso, mandarMailPedido, mandarAvisoPedido };
