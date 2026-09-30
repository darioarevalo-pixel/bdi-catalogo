// ---------------------------------------------------------------------------
// AMAZON SES, SIN DEPENDENCIAS
//
// Este repo no tiene package.json (no hay nada que instalar), así que el SDK de
// AWS no está. La API v2 de SES es un POST con JSON; lo único que pide es la
// firma "Signature V4", que son unas líneas de HMAC con `crypto`.
//
// Variables en Vercel: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
// (por defecto us-east-1) y, opcional, SES_CONFIGURATION_SET.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();

/** Llama a la API v2 de SES firmando con SigV4. Devuelve { status, data }. */
async function sesFetch(method, path, body) {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || 'us-east-1';
  if (!accessKey || !secretKey) throw new Error('sin credenciales de AWS');

  const host = 'email.' + region + '.amazonaws.com';
  const payload = body ? JSON.stringify(body) : '';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260930T120000Z
  const dia = amzDate.slice(0, 8);

  const headers = { 'content-type': 'application/json', host, 'x-amz-date': amzDate };
  const firmados = Object.keys(headers).sort();
  const canonico = [
    method, path, '',
    firmados.map(h => h + ':' + headers[h] + '\n').join(''),
    firmados.join(';'),
    sha256(payload),
  ].join('\n');
  const alcance = dia + '/' + region + '/ses/aws4_request';
  const aFirmar = ['AWS4-HMAC-SHA256', amzDate, alcance, sha256(canonico)].join('\n');
  const kFirma = hmac(hmac(hmac(hmac('AWS4' + secretKey, dia), region), 'ses'), 'aws4_request');
  const firma = crypto.createHmac('sha256', kFirma).update(aFirmar, 'utf8').digest('hex');

  const r = await fetch('https://' + host + path, {
    method,
    headers: Object.assign({}, headers, {
      authorization: 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + alcance +
        ', SignedHeaders=' + firmados.join(';') + ', Signature=' + firma,
    }),
    body: payload || undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/** Manda un mail. Devuelve { ok, id } o { ok:false, motivo }. Nunca tira. */
async function mandarMail({ from, to, subject, html, text, replyTo }) {
  try {
    const body = {
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    };
    if (replyTo) body.ReplyToAddresses = [replyTo];
    if (process.env.SES_CONFIGURATION_SET) body.ConfigurationSetName = process.env.SES_CONFIGURATION_SET;
    const r = await sesFetch('POST', '/v2/email/outbound-emails', body);
    if (r.status !== 200) return { ok: false, motivo: 'ses ' + r.status + ': ' + (r.data.message || r.data.Message || '') };
    return { ok: true, id: r.data.MessageId };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

module.exports = { sesFetch, mandarMail };
