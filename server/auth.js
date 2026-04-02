'use strict';

const { Issuer, generators } = require('openid-client');
const crypto = require('crypto');
const config = require('./config');

let oidcClient = null;

async function initOidc() {
  if (!config.oidc.issuer) {
    console.warn('[auth] OIDC_ISSUER not set — admin login disabled');
    return;
  }
  try {
    const issuer = await Issuer.discover(config.oidc.issuer);
    oidcClient = new issuer.Client({
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      redirect_uris: [config.oidc.redirectUri],
      response_types: ['code'],
    });
    console.log('[auth] OIDC client ready, issuer:', issuer.issuer);
  } catch (err) {
    console.error('[auth] OIDC discovery failed:', err.message);
  }
}

function getOidcClient() {
  return oidcClient;
}

// Middleware: require Authelia login
function requireAdmin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}

// Middleware: require valid share-link session for a given slug
function requireShare(req, res, next) {
  const slug = req.params.slug || req.query.slug;
  if (!slug) return res.status(400).send('Missing slug');

  const db = require('./db');
  const link = db.getShareBySlug(slug);
  if (!link) return res.status(404).send('Link not found');

  if (link.expires_at && Date.now() > link.expires_at) {
    return res.status(410).send('Link expired');
  }

  // Admin always has access
  if (req.session && req.session.user) {
    req.shareLink = link;
    return next();
  }

  // No password required
  if (!link.password_hash) {
    req.shareLink = link;
    return next();
  }

  // Check share session
  const granted = req.session.shareAccess || {};
  if (granted[slug]) {
    req.shareLink = link;
    return next();
  }

  // Need password prompt
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ error: 'password_required' });
  }
  res.redirect(`/s/${slug}/unlock`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return attempt === hash;
}

function buildAuthUrl(req) {
  if (!oidcClient) return null;
  const state = generators.state();
  const nonce = generators.nonce();
  req.session.oidcState = state;
  req.session.oidcNonce = nonce;
  return oidcClient.authorizationUrl({
    scope: 'openid profile email',
    state,
    nonce,
  });
}

async function handleCallback(req) {
  if (!oidcClient) throw new Error('OIDC not configured');
  const params = oidcClient.callbackParams(req);
  const tokenSet = await oidcClient.callback(config.oidc.redirectUri, params, {
    state: req.session.oidcState,
    nonce: req.session.oidcNonce,
  });
  return tokenSet.claims();
}

module.exports = {
  initOidc, getOidcClient,
  requireAdmin, requireShare,
  hashPassword, verifyPassword,
  buildAuthUrl, handleCallback,
};
