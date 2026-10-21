/* Sydney Foundation Course Portal · access gate.
   Every published route is a small wrapper page plus an AES-256-GCM payload (.enc). This script
   authenticates against the private course service, asks it for the content key, decrypts the
   payload and then writes the original page into this very document, at this very URL, so every
   relative link, draft key, annotation ID, script, audio element and print control behaves exactly
   as it did before the site was encrypted. No iframe, no rewriting of the page itself.

   Two things this file must keep doing, both easy to break:

   Everything lives inside this function. document.open()/write() does not reset the window's global
   lexical environment, and the native pages declare their own top-level `const`/`let` (DATA, STORE,
   draft, saved, key). A global `const` here would collide with one of theirs and stop the page
   dead. Nothing below is declared outside this closure; the only thing added to the window is one
   property.

   The URL is never touched. No history.replaceState, no <base>, no query or hash rewriting: the
   redirect stubs read ?p=, the mock page reads #set-Sxx, the review and vocabulary pages route on
   their anchors, and the teacher preview is carried by ?tp=.

   What is NOT here, by design: the content key, the course code, any hash of it, and any teacher
   or record address. The key exists in the private backend config and, after a successful sign-in,
   in this tab's sessionStorage. The course code is a shared convenience gate: it keeps the learner's
   own answers and feedback out of a public repository and its history. It does not identify who is
   reading, and anyone the code is given to can read these pages. */
(function (global) {
  'use strict';

  // Written by backend/tools/write_site_config.mjs. Empty means "fail closed": the gate says the
  // material cannot be opened rather than pretending there is nothing to protect.
  var SERVICE_URL = 'https://script.google.com/macros/s/AKfycbzpIlJzwZvcr6Xp2ImgFFEHFUdWgxHsgAFSDerzEnQc0ZWh0eKtabn8GbuYzKdagXxI/exec';

  var ACCESS_KEY = 'sf02-access-v1';        // sessionStorage: this tab's token + content key
  var PREVIEW_KEY = 'sf02-tp';              // sessionStorage: this tab is a teacher preview
  var DEVICE_KEY = 'sf02-device-v1';        // localStorage: signed, expiring trusted-device credential
  var DEVICE_ID_KEY = 'sf02-device-id-v1';  // localStorage: opaque per-browser id, for rate limiting
  var TIMEOUT_MS = 20000;
  var SKEW_MS = 30000;                      // treat a token as spent this long before it expires

  var RETRY_MESSAGE = 'The course service could not be reached. Please try again.';

  var cfg = null;

  // ---------------------------------------------------------------- small helpers

  function configured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(SERVICE_URL);
  }

  function readLocal(k) { try { return global.localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function writeLocal(k, v) { try { global.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function dropLocal(k) { try { global.localStorage.removeItem(k); } catch (e) { /* nothing kept */ } }
  function readSession(k) { try { return global.sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function writeSession(k, v) { try { global.sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // Whatever this tab last recorded, fresh or not. Identity and freshness are separate questions:
  // an expired preview sign-in is still a preview sign-in, and forgetting that is how a teacher's
  // tab quietly becomes the learner's.
  function rawAccess() {
    try {
      var a = JSON.parse(readSession(ACCESS_KEY) || 'null');
      return a && a.t ? a : null;
    } catch (e) { return null; }
  }

  // Usable right now: has a key and is not within SKEW_MS of expiry.
  function readAccess() {
    var a = rawAccess();
    if (!a || !a.k || !(Number(a.e) > Date.now() + SKEW_MS)) return null;
    return a;
  }
  function writeAccess(a) { writeSession(ACCESS_KEY, JSON.stringify(a)); }
  function dropAccess() { try { global.sessionStorage.removeItem(ACCESS_KEY); } catch (e) { /* nothing kept */ } }

  function hex(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // An opaque id for this browser profile. It is not derived from anything about the reader; it only
  // lets the service count failed sign-ins per browser instead of only in total.
  function deviceId() {
    var id = readLocal(DEVICE_ID_KEY);
    if (/^g-[a-f0-9]{16}$/.test(id)) return id;
    var bytes = new Uint8Array(8);
    global.crypto.getRandomValues(bytes);
    id = 'g-' + hex(bytes);
    writeLocal(DEVICE_ID_KEY, id);
    return id;
  }

  // An explicit ?tp= in this URL. `present` is true whenever the parameter appears at all, even
  // malformed, so a broken preview link fails closed instead of quietly opening the page as the
  // learner and letting a later hand-in be filed as real work.
  function urlPreview() {
    var search = String(global.location.search || '');
    if (!/[?&]tp=/.test(search)) return { present: false, token: '' };
    var m = /[?&]tp=(\d{10}\.[a-f0-9]{40})(?:&|$)/.exec(search);
    return { present: true, token: m ? m[1] : '' };
  }

  function bytesFromBase64Url(b64u) {
    var b64 = String(b64u).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = global.atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Resolves to the parsed reply, or to null when there was no usable answer at all (network
  // failure, timeout, an HTML error page). null means "we do not know", never "refused".
  function post(body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return global.fetch(SERVICE_URL, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { global.clearTimeout(timer); return r.text(); },
      function (e) { global.clearTimeout(timer); throw e; })
      .then(function (text) { try { return JSON.parse(text); } catch (e) { return null; } },
        function () { return null; });
  }

  // ---------------------------------------------------------------- the visible gate

  function el(id) { return global.document.getElementById(id); }

  function status(heading, detail, bad) {
    var box = el('sfGateStatus');
    if (!box) return;
    box.className = 'status' + (bad ? ' bad' : '');
    box.textContent = '';
    var h = global.document.createElement('h2');
    h.textContent = heading;
    var p = global.document.createElement('p');
    p.textContent = detail;
    box.appendChild(h);
    box.appendChild(p);
  }

  function showForm(message, bad) {
    var form = el('sfGateForm');
    if (form) form.hidden = false;
    status(message || 'Course code', 'Enter the course code your teacher gave you.', Boolean(bad));
    var input = el('sfGateCode');
    if (input) { input.disabled = false; try { input.focus(); } catch (e) { /* not focusable yet */ } }
    var button = el('sfGateSubmit');
    if (button) button.disabled = false;
  }

  function hideForm() {
    var form = el('sfGateForm');
    if (form) form.hidden = true;
  }

  function busy(message) {
    var button = el('sfGateSubmit');
    if (button) button.disabled = true;
    var input = el('sfGateCode');
    if (input) input.disabled = true;
    status('Opening', message || 'One moment.');
  }

  // A teacher preview that cannot be honoured. The course-code form is deliberately not offered: a
  // preview link must either open as the preview or not open at all.
  function previewFailed(detail) {
    hideForm();
    status('This preview link cannot be opened',
      detail || 'Open the learner page again from the teacher workspace.', true);
  }

  // ---------------------------------------------------------------- authentication

  function keepAccess(result, identity) {
    var access = {
      t: String(result.accessToken || ''),
      k: String(result.contentKey || ''),
      e: Number(result.expiresAt || 0),
      i: String(result.identity || identity || 'learner')
    };
    if (!access.t || !access.k || !(access.e > Date.now())) return null;
    writeAccess(access);
    if (result.deviceCredential) writeLocal(DEVICE_KEY, String(result.deviceCredential));
    return access;
  }

  // A trusted device never stores the course code. It stores a signed credential that expires on its
  // own and stops working the moment the course's access generation is raised.
  //
  // The credential is thrown away only when the service says, in so many words, that it has rejected
  // it. Anything else — no reply, a timeout, an HTML error page, a server error — resolves to
  // {outage:true} and leaves the credential in place. Treating an outage as a rejection would sign a
  // learner out of their own trusted device because their connection dropped for a moment.
  function renew() {
    var credential = readLocal(DEVICE_KEY);
    if (!credential) return Promise.resolve(null);
    return post({ action: 'renewAccess', deviceCredential: credential })
      .then(function (j) {
        if (j && j.ok) return keepAccess(j, 'learner');
        if (j && j.reason === 'device-invalid') { dropLocal(DEVICE_KEY); return null; }
        return { outage: true };
      });
  }

  // Never falls back to a learner sign-in: a preview session stays a preview session or fails.
  function authorizePreview(token) {
    return post({ action: 'authorizeAccess', previewToken: token })
      .then(function (j) {
        if (j && j.ok) return keepAccess(j, 'preview');
        if (j && j.reason === 'preview-invalid') return { invalid: true };
        return { outage: true };
      });
  }

  function authorizeCode(code, remember) {
    return post({ action: 'authorizeAccess', password: code, deviceId: deviceId(), remember: Boolean(remember) });
  }

  // ---------------------------------------------------------------- decrypt and hand over

  function openPage(access) {
    busy();
    var raw;
    try { raw = bytesFromBase64Url(access.k); } catch (e) { raw = null; }
    if (!raw || raw.length !== 32) {
      dropAccess();
      return status('This material cannot be opened yet', 'Please reload the page and sign in again.', true);
    }
    var payload;
    return global.fetch(cfg.payload, { cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        payload = new Uint8Array(buf);
        if (payload.length < 29) throw new Error('short payload');
        return global.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
      })
      .then(function (ck) {
        return global.crypto.subtle.decrypt({
          name: 'AES-GCM', iv: payload.subarray(0, 12),
          // The route is authenticated but not encrypted, so a payload served under another route
          // cannot be decrypted here.
          additionalData: new TextEncoder().encode(cfg.aad),
          tagLength: 128
        }, ck, payload.subarray(12));
      })
      .then(function (plain) {
        var html = new TextDecoder('utf-8', { fatal: true }).decode(plain);
        // The page is its own complete document and it belongs at this URL, so it replaces this
        // document instead of sitting in a frame: relative links, draft and annotation storage keys,
        // its own scripts, its audio and its print control all stay exactly as written.
        global.document.open();
        global.document.write(html);
        global.document.close();
      })
      .catch(function (err) {
        var network = err && (err.name === 'TypeError' || /http |short payload/.test(String(err.message)));
        if (network) {
          return status('This page could not be loaded', 'Please check your connection and try again.', true);
        }
        // A decrypt failure after a valid sign-in means the stored key no longer fits this payload.
        dropAccess();
        status('This material cannot be opened yet', 'Please reload the page and sign in again.', true);
      });
  }

  // ---------------------------------------------------------------- flow

  function signIn() {
    var input = el('sfGateCode');
    var code = input ? String(input.value || '') : '';
    var box = el('sfGateRemember');
    if (!code) return showForm('Course code', false);
    busy('Checking the course code.');
    authorizeCode(code, box ? box.checked : false).then(function (j) {
      if (input) input.value = '';
      if (j && j.ok) {
        var access = keepAccess(j, 'learner');
        if (access) { hideForm(); return openPage(access); }
        return showForm(RETRY_MESSAGE, true);
      }
      // Only an answer that actually says "wrong code" is reported as a wrong code. A missing or
      // unreadable reply is a service problem and must not be blamed on what the learner typed.
      if (j && j.reason === 'rate-limited') {
        return showForm('Too many attempts. Please wait a few minutes and try again.', true);
      }
      if (j && j.reason === 'code-invalid') {
        return showForm('That course code is not right. Please check it and try again.', true);
      }
      showForm(RETRY_MESSAGE, true);
    });
  }

  function wire() {
    var form = el('sfGateForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); signIn(); });
  }

  // The order here is the whole point. An explicit ?tp= is resolved and recorded *before* any cached
  // learner sign-in is considered, because the native pages that follow do not all load the hand-in
  // helper: once the teacher navigates on from this page, the only record that this tab is a preview
  // is what was persisted here. Getting this backwards lets a teacher's click be filed as the
  // learner's real work.
  function start() {
    var island = el('sfGateConfig');
    if (!island) return;
    try { cfg = JSON.parse(island.textContent); } catch (e) { cfg = null; }
    if (!cfg || !cfg.payload || !cfg.aad) {
      return status('This page is not ready', 'Please tell your teacher that this page did not open.', true);
    }
    wire();
    if (!(global.crypto && global.crypto.subtle)) {
      return status('This browser cannot open the material',
        'Please use a current browser and open the page over https.', true);
    }
    if (!configured()) {
      return status('This page is not ready', 'Please tell your teacher that this page did not open.', true);
    }

    var url = urlPreview();
    if (url.present && !url.token) {
      return previewFailed('This link carries a teacher preview token that is not valid.');
    }
    if (url.token) writeSession(PREVIEW_KEY, url.token);

    // Preview intent is read from the raw record, not from a usable token, and it is settled before
    // any learner path is considered. A preview tab whose token has aged out is renewed as a preview
    // or not at all: it is never renewed from the learner's trusted-device credential, because the
    // learner's credential would hand back a learner identity and the teacher's next click would be
    // filed as the learner's real work.
    var previewToken = readSession(PREVIEW_KEY);
    var raw = rawAccess();
    var previewIntent = Boolean(previewToken) || Boolean(raw && raw.i === 'preview');

    if (previewIntent) {
      var live = readAccess();
      if (live && live.i === 'preview') return openPage(live);
      if (!previewToken) {
        return previewFailed('This teacher preview has expired. Open the learner page again from the '
          + 'teacher workspace.');
      }
      busy('Opening the teacher preview.');
      return authorizePreview(previewToken).then(function (a) {
        if (a && a.t) return openPage(a);
        if (a && a.outage) return previewFailed(RETRY_MESSAGE);
        previewFailed();
      });
    }

    var cached = readAccess();
    if (cached && cached.i !== 'preview') return openPage(cached);

    busy();
    renew().then(function (a) {
      if (a && a.t) return openPage(a);
      if (a && a.outage) return showForm(RETRY_MESSAGE, true);
      showForm();
    });
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.SFPortalGate = { isConfigured: configured, accessKey: ACCESS_KEY, deviceKey: DEVICE_KEY, previewKey: PREVIEW_KEY };
})(window);
