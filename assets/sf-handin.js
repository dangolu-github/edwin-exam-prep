/* Sydney Foundation Course Portal · hand-in helper.
   Sends a finished practice set to the course service and waits for its receipt. There is no second
   destination: if the service cannot be reached, send() rejects, the page keeps the draft and the
   request ID, and nothing is marked as submitted. The learner page shows only a receipt or a retry
   message — never an answer, a mark or a key.

   Since the 2026-10 move to the gated site the service accepts a hand-in only from a reader who has
   signed in, so every call carries the access token the gate put in this tab's sessionStorage. When
   that token has aged out, the helper renews it — as the learner from the trusted-device credential,
   or as the teacher's preview from the preview token, and never the one in place of the other. It
   never holds, asks for or stores the course code.

   Teacher preview is sticky and is decided three ways, in this order: an explicit ?tp= in the URL,
   the preview token this tab recorded earlier, and the identity signed into the access token itself.
   A page reached by navigating on from a preview link has none of the first in its URL, so without
   the other two a teacher's click would be filed as the learner's real work. In a preview session no
   submission-origin lookup is made at all: the teacher's own city and device are not evidence about
   the learner. */
(function (global) {
  'use strict';
  // Written by backend/tools/write_site_config.mjs after the student deployment exists. While it is
  // empty every send() fails closed rather than pretending the work was received.
  var SERVICE_URL = 'https://script.google.com/macros/s/AKfycbzpIlJzwZvcr6Xp2ImgFFEHFUdWgxHsgAFSDerzEnQc0ZWh0eKtabn8GbuYzKdagXxI/exec';
  var REQUEST_PREFIX = 'sf02-handin-request:';
  var PREVIEW_KEY = 'sf02-tp';
  var ACCESS_KEY = 'sf02-access-v1';
  var DEVICE_KEY = 'sf02-device-v1';
  var TIMEOUT_MS = 25000;
  var SKEW_MS = 30000;

  // ---------------------------------------------------------------- storage

  function readSession(k) { try { return global.sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function writeSession(k, v) { try { global.sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ---------------------------------------------------------------- preview identity

  // `present` is true whenever ?tp= appears at all, even malformed, so a broken preview link refuses
  // the hand-in instead of letting it through as production work.
  function urlPreview() {
    var search = String(global.location.search || '');
    if (!/[?&]tp=/.test(search)) return { present: false, token: '' };
    var m = /[?&]tp=(\d{10}\.[a-f0-9]{40})(?:&|$)/.exec(search);
    return { present: true, token: m ? m[1] : '' };
  }

  // Whatever this tab last recorded, fresh or not. Identity and freshness are separate questions:
  // an expired preview sign-in is still a preview sign-in.
  function rawAccess() {
    try {
      var a = JSON.parse(readSession(ACCESS_KEY) || 'null');
      return a && a.t ? a : null;
    } catch (e) { return null; }
  }

  // Usable right now.
  function storedAccess() {
    var a = rawAccess();
    return a && Number(a.e) > Date.now() + SKEW_MS ? a : null;
  }

  // The identity of this tab, whether or not the current URL still carries ?tp=.
  //   { broken: true }                  an explicit but malformed ?tp= — refuse everything
  //   { preview: true, token: '…' }     a preview session, with a token to renew from
  //   { preview: true, token: '' }      a preview session whose token is still usable
  //   { preview: true, expired: true }  a preview session with nothing left to renew from — refuse
  //   { preview: false }                an ordinary learner session
  function session() {
    var url = urlPreview();
    if (url.present && !url.token) return { broken: true, preview: true, token: '' };
    if (url.token) writeSession(PREVIEW_KEY, url.token);
    var stored = readSession(PREVIEW_KEY);
    if (stored) return { preview: true, token: stored };
    // Read from the raw record, so an aged-out preview is still recognised as a preview. With no
    // preview token to renew from, this session has no way back in and must refuse rather than fall
    // through to the learner's trusted-device credential.
    var raw = rawAccess();
    if (raw && raw.i === 'preview') {
      var live = storedAccess();
      if (live && live.i === 'preview') return { preview: true, token: '' };
      return { preview: true, token: '', expired: true };
    }
    return { preview: false, token: '' };
  }

  function isPreview() {
    return Boolean(session().preview);
  }

  function keepAccess(result) {
    try {
      var current = JSON.parse(readSession(ACCESS_KEY) || 'null') || {};
      var next = {
        t: String(result.accessToken || ''),
        k: String(result.contentKey || current.k || ''),
        e: Number(result.expiresAt || 0),
        i: String(result.identity || 'learner')
      };
      if (!next.t || !(next.e > Date.now())) return null;
      writeSession(ACCESS_KEY, JSON.stringify(next));
      return next;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- transport

  function randomId() {
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // One request ID per unfinished hand-in, kept until it is confirmed, so a retry is never stored twice.
  function requestId(key) {
    try {
      var saved = global.localStorage.getItem(REQUEST_PREFIX + key);
      if (/^[a-f0-9]{32}$/.test(saved || '')) return saved;
      var id = randomId();
      global.localStorage.setItem(REQUEST_PREFIX + key, id);
      return id;
    } catch (e) { return randomId(); }
  }
  function forget(key) { try { global.localStorage.removeItem(REQUEST_PREFIX + key); } catch (e) { /* nothing kept */ } }

  function timedFetch(url, options) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return global.fetch(url, Object.assign({ credentials: 'omit', signal: ctrl ? ctrl.signal : undefined }, options))
      .then(function (r) { clearTimeout(timer); return r.text(); }, function (e) { clearTimeout(timer); throw e; })
      .then(function (text) { try { return JSON.parse(text); } catch (e) { return null; } });
  }

  function call(body) {
    return timedFetch(SERVICE_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
    });
  }

  // Renews within the session's own identity. A preview session is never renewed from the learner's
  // trusted-device credential, and the credential is dropped only when the service says it has
  // rejected it — not because a request failed.
  function accessToken(s) {
    var access = storedAccess();
    if (access && (s.preview ? access.i === 'preview' : access.i !== 'preview')) {
      return Promise.resolve(access.t);
    }
    if (s.preview) {
      // Never the device credential here, whatever state the preview session is in.
      if (!s.token) return Promise.resolve('');
      return call({ action: 'authorizeAccess', previewToken: s.token }).then(function (j) {
        if (j && j.ok) { var a = keepAccess(j); return a ? a.t : ''; }
        return '';
      }, function () { return ''; });
    }
    var credential = '';
    try { credential = global.localStorage.getItem(DEVICE_KEY) || ''; } catch (e) { credential = ''; }
    if (!credential) return Promise.resolve('');
    return call({ action: 'renewAccess', deviceCredential: credential }).then(function (j) {
      if (j && j.ok) { var a = keepAccess(j); return a ? a.t : ''; }
      if (j && j.reason === 'device-invalid') {
        try { global.localStorage.removeItem(DEVICE_KEY); } catch (e) { /* nothing kept */ }
      }
      return '';
    }, function () { return ''; });
  }

  // If the POST answer could not be read, the hand-in may still have been stored. Ask for the receipt
  // under the same request ID before reporting a failure. The assignment goes with it because the
  // service scopes a receipt by assignment and by environment, not by request ID alone. It travels in
  // the request body, so no token is ever put in a URL.
  function confirmReceipt(opts, id, token, s) {
    return call({
      action: 'getReceipt', requestId: id, assignmentId: opts.assignmentId,
      accessToken: token, previewToken: s.token || ''
    })
      .then(function (j) { return j && j.ok && j.found && j.result && j.result.receiptId ? j.result : null; })
      .catch(function () { return null; });
  }

  function configured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(SERVICE_URL);
  }

  // ---------------------------------------------------------------- submission origin
  // Teacher-only evidence, collected at submit time. The existing learner pages are published
  // byte-for-byte and carry no script tag for it, so this helper loads it from beside itself. A
  // missing, blocked or slow collector must never block or fail a hand-in, and nothing it returns is
  // ever shown on this page. It is not loaded or called at all in a teacher preview session.

  function originScriptUrl() {
    var doc = global.document;
    if (!doc) return '';
    var me = doc.currentScript;
    if (!me && doc.querySelectorAll) {
      var all = doc.querySelectorAll('script[src*="sf-handin.js"]');
      me = all && all.length ? all[all.length - 1] : null;
    }
    var src = (me && me.src) || '';
    if (!/sf-handin\.js(\?|#|$)/.test(src)) return '';
    return src.replace(/[?#].*$/, '').replace(/sf-handin\.js$/, 'submission-origin.js');
  }

  var ORIGIN_URL = originScriptUrl();
  var originLoad = null;

  function loadOrigin() {
    if (originLoad) return originLoad;
    if (global.PortalSubmissionOrigin) {
      originLoad = Promise.resolve(global.PortalSubmissionOrigin);
      return originLoad;
    }
    var head = global.document && (global.document.head || global.document.documentElement);
    if (!ORIGIN_URL || !head || !head.appendChild) {
      originLoad = Promise.resolve(null);
      return originLoad;
    }
    originLoad = new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; resolve(global.PortalSubmissionOrigin || null); } }
      var s = global.document.createElement('script');
      s.src = ORIGIN_URL;
      s.async = true;
      s.onload = finish;
      s.onerror = function () { if (!done) { done = true; resolve(null); } };
      setTimeout(finish, 6000);
      head.appendChild(s);
    });
    return originLoad;
  }

  function origin(s) {
    if (s.preview) return Promise.resolve(null);
    return loadOrigin().then(function (collector) {
      if (!collector || typeof collector.collect !== 'function') return null;
      return new Promise(function (resolve) {
        var done = false;
        function finish(value) { if (!done) { done = true; resolve(value || null); } }
        setTimeout(function () { finish(null); }, 5000);
        try {
          Promise.resolve(collector.collect()).then(finish, function () { finish(null); });
        } catch (e) { finish(null); }
      });
    }, function () { return null; });
  }

  // ---------------------------------------------------------------- sending

  // opts: key, assignmentId, answers {itemId: value}, notes {itemId: value}.
  // Resolves only with a server receipt: { ok, via: 'service', receiptId, duplicate }.
  function send(opts) {
    if (!configured()) return Promise.reject(new Error('The hand-in service is not configured yet.'));
    var s = session();
    // A link that says it is a teacher preview but carries an unusable token is refused outright,
    // and so is a preview session with nothing left to renew from. Nothing is sent, so nothing can
    // be filed under the wrong identity. The draft and the request ID are untouched, as on any other
    // failed send.
    if (s.broken) return Promise.reject(new Error('This teacher preview link is not valid.'));
    if (s.expired) return Promise.reject(new Error('This teacher preview has expired. Open the learner page again from the teacher workspace.'));
    var id = requestId(opts.key);
    var token = '';
    return accessToken(s).then(function (t) {
      token = t;
      return origin(s);
    }).then(function (submissionOrigin) {
      var body = {
        action: 'submit', requestId: id, assignmentId: opts.assignmentId,
        answers: opts.answers || {}, notes: opts.notes || {}, clientTime: new Date().toISOString(),
        page: global.location.pathname + global.location.hash, previewToken: s.token || '',
        accessToken: token
      };
      if (submissionOrigin) body.submissionOrigin = submissionOrigin;
      return call(body).catch(function () { return null; });
    })
      .then(function (j) { return j && j.ok && j.receiptId ? j : confirmReceipt(opts, id, token, s); })
      .then(function (receipt) {
        if (!receipt || !receipt.receiptId) throw new Error('The service did not confirm this hand-in.');
        forget(opts.key);
        return { ok: true, via: 'service', receiptId: receipt.receiptId, duplicate: Boolean(receipt.duplicate) };
      });
  }

  // The lookup is warmed only on a page that can actually hand work in, only once a sign-in is
  // already in place, and never in a teacher preview session.
  function warmOrigin() {
    var s = session();
    if (s.preview || s.broken || !storedAccess()) return;
    loadOrigin().then(function (collector) {
      if (collector && typeof collector.warm === 'function') { try { collector.warm(); } catch (e) { /* best effort */ } }
    });
  }

  function showPreviewNote() {
    var s = session();
    if (!s.preview || global.document.getElementById('sfPreviewNote')) return;
    var note = global.document.createElement('div');
    note.id = 'sfPreviewNote';
    note.setAttribute('role', 'note');
    note.textContent = s.broken ? 'Teacher preview link is not valid: hand-ins from this page are refused.'
      : s.expired ? 'Teacher preview has expired: hand-ins from this page are refused.'
        : 'Teacher preview: hand-ins from this page are saved as tests.';
    note.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99;max-width:calc(100% - 24px);padding:8px 12px;border-radius:10px;background:#faf0d9;color:#84570f;font:700 13px/1.4 Arial,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.15)';
    global.document.body.appendChild(note);
  }

  function ready() { showPreviewNote(); warmOrigin(); }

  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', ready);
    else ready();
  }
  global.SFPortalHandin = { send: send, isPreview: isPreview, isConfigured: configured };
})(window);
