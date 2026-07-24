// Shared authentication module for Netlify Functions
// Single source of truth for token generation & verification

const crypto = require('crypto');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_EMAILS = ADMIN_EMAIL.split(',').map(e => e.toLowerCase().trim()).filter(e => e);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOKEN_EXPIRY_HOURS = 24 * 30; // 30 days

let _warnedPasswordSecret = false;

function getTokenSecret() {
  const secret =
    process.env.CMS_TOKEN_SECRET ||
    process.env.TOKEN_SECRET ||
    ADMIN_PASSWORD;

  if (
    !process.env.CMS_TOKEN_SECRET &&
    !process.env.TOKEN_SECRET &&
    ADMIN_PASSWORD &&
    !_warnedPasswordSecret
  ) {
    _warnedPasswordSecret = true;
    console.warn(
      '[auth] CMS_TOKEN_SECRET/TOKEN_SECRET non impostati: uso ADMIN_PASSWORD come secret token (compat). ' +
      'Imposta CMS_TOKEN_SECRET dedicato in produzione.'
    );
  }

  return secret || '';
}

// Compat export: valore risolto al require — preferire getTokenSecret() a runtime
const TOKEN_SECRET = getTokenSecret();

function generateToken(email) {
  const secret = getTokenSecret();
  const payload = {
    email: email,
    exp: Date.now() + (TOKEN_EXPIRY_HOURS * 60 * 60 * 1000)
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payloadBase64).digest('hex');
  return `${payloadBase64}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  const secret = getTokenSecret();

  const expectedSignature = crypto.createHmac('sha256', secret).update(payloadBase64).digest('hex');

  // Confronta firme in modo timing-safe
  try {
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.log('Token signature mismatch');
      return null;
    }
  } catch (_) {
    console.log('Token signature mismatch');
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
    if (payload.exp && payload.exp < Date.now()) {
      console.log('Token expired');
      return null;
    }
    return payload.email;
  } catch (e) {
    console.log('Token parse error:', e.message);
    return null;
  }
}

/**
 * Confronta password in modo timing-safe.
 * Se lunghezze diverse → false senza timingSafeEqual (che richiede equal length).
 */
function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

function verifyLogin(email, password) {
  if (!email || !password) return null;
  const emailLower = email.toLowerCase().trim();
  if (!ADMIN_EMAILS.includes(emailLower)) return null;
  if (!safeEqualString(password, ADMIN_PASSWORD)) return null;
  return emailLower;
}

module.exports = {
  generateToken,
  verifyToken,
  verifyLogin,
  getTokenSecret,
  ADMIN_EMAILS,
  TOKEN_SECRET
};
