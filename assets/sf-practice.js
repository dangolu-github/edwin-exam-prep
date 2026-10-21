/* Sydney Foundation Course Portal · shared practice-page helpers.
   Two things only, both local to the browser: a namespaced draft store, and an annotation toggle.
   Nothing here sends anything anywhere, and nothing here knows an answer. */
(function (global) {
  'use strict';

  // One JSON object per page namespace, so a draft survives topic switches, filtering and reload.
  // Namespaces are SF02-only; no other portal's keys are read or written.
  function store(namespace) {
    if (namespace.indexOf('sf02-') !== 0) throw new Error('draft namespace must start with sf02-');
    var cache = null;
    function all() {
      if (cache) return cache;
      try { cache = JSON.parse(global.localStorage.getItem(namespace) || '{}'); } catch (e) { cache = {}; }
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
      return cache;
    }
    function flush() {
      try { global.localStorage.setItem(namespace, JSON.stringify(all())); } catch (e) { /* private mode */ }
    }
    return {
      get: function (field) { var v = all()[field]; return v === undefined ? '' : v; },
      set: function (field, value) {
        var data = all();
        if (value === '' || value === false || value === null || value === undefined) delete data[field];
        else data[field] = value;
        flush();
      },
      all: all
    };
  }

  // Binds every [data-sf-field] under `root` to the store: restores on render, saves on change.
  // Checkboxes and radios keep their checked state; everything else keeps its value.
  function bindFields(root, draft) {
    root.querySelectorAll('[data-sf-field]').forEach(function (el) {
      var field = el.getAttribute('data-sf-field');
      if (el.type === 'radio') {
        if (draft.get(field) === el.value) el.checked = true;
        el.addEventListener('change', function () { if (el.checked) draft.set(field, el.value); });
      } else if (el.type === 'checkbox') {
        var chosen = draft.get(field) || [];
        if (Array.isArray(chosen) && chosen.indexOf(el.value) >= 0) el.checked = true;
        el.addEventListener('change', function () {
          var now = draft.get(field);
          now = Array.isArray(now) ? now.slice() : [];
          var at = now.indexOf(el.value);
          if (el.checked && at < 0) now.push(el.value);
          if (!el.checked && at >= 0) now.splice(at, 1);
          draft.set(field, now.length ? now : '');
          // These pages have no <form>, so the count must be refreshed unconditionally.
          updateCount(el.closest('[data-choice-group]'));
        });
      } else {
        var saved = draft.get(field);
        if (saved) el.value = saved;
        el.addEventListener('input', function () { draft.set(field, el.value); });
      }
    });
    root.querySelectorAll('[data-choice-group]').forEach(updateCount);
  }

  // For a "choose THREE" group: says how many of the required number are selected. It reports the
  // count the source asks for; it never says whether a selection is right.
  function updateCount(group) {
    if (!group) return;
    var need = Number(group.getAttribute('data-require') || 0);
    var status = group.querySelector('[data-choice-count]');
    if (!need || !status) return;
    var picked = group.querySelectorAll('input[type=checkbox]:checked').length;
    status.textContent = picked + ' / ' + need + ' selected';
    status.classList.toggle('over', picked > need);
  }

  // Shows or hides annotation styling only. The words, the question requirements and every learner
  // answer stay on the page in both states; only the highlighting and the teaching hints go.
  function annotationToggle(options) {
    var button = document.getElementById(options.buttonId);
    var root = options.root || document.body;
    var key = options.storageKey;
    if (!button) return;
    function apply(off) {
      root.classList.toggle('annotations-off', off);
      button.setAttribute('aria-pressed', String(!off));
      button.textContent = off ? (options.showLabel || '显示标注 Show annotations')
                               : (options.hideLabel || '隐藏标注 Hide annotations');
      (options.alsoHide || []).forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) { el.hidden = off; });
      });
    }
    var off = false;
    try { off = global.localStorage.getItem(key) === 'off'; } catch (e) { off = false; }
    apply(off);
    button.addEventListener('click', function () {
      off = !off;
      try { global.localStorage.setItem(key, off ? 'off' : 'on'); } catch (e) { /* not remembered */ }
      apply(off);
    });
  }

  // A labelled show/hide for one region, with the button always stating the current state.
  // The region is resolved by id on every apply, never captured once: the page it serves re-renders
  // its region on a topic switch, and a captured node would leave the live region's state stale.
  function regionToggle(options) {
    var button = document.getElementById(options.buttonId);
    if (!button || !document.getElementById(options.regionId)) return;
    function apply(open) {
      var region = document.getElementById(options.regionId);
      if (region) region.hidden = !open;
      button.setAttribute('aria-pressed', String(open));
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? (options.openLabel || '隐藏') : (options.closedLabel || '显示');
      if (options.wideWhenClosed) document.body.classList.toggle(options.wideWhenClosed, !open);
    }
    var open = options.defaultOpen !== false;
    try {
      var saved = global.localStorage.getItem(options.storageKey);
      if (saved !== null) open = saved === 'open';
    } catch (e) { /* use the default */ }
    apply(open);
    button.addEventListener('click', function () {
      open = !open;
      try { global.localStorage.setItem(options.storageKey, open ? 'open' : 'closed'); } catch (e) { /* not remembered */ }
      apply(open);
    });
  }

  global.SFPractice = { store: store, bindFields: bindFields, annotationToggle: annotationToggle,
    regionToggle: regionToggle, updateCount: updateCount };
})(window);
