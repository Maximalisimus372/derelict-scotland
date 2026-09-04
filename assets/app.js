(function () {
  'use strict';

  var CAT = {
    fire:       { label: 'Fire',        color: '#e0562f' },
    storm:      { label: 'Storm',       color: '#4a9ec9' },
    derelict:   { label: 'Derelict',    color: '#b8a37e' },
    demolished: { label: 'Demolished',  color: '#8a7f9c' },
    ruin:       { label: 'Ruin',        color: '#6f9c6a' },
    village:    { label: 'Depopulated', color: '#57a99a' }
  };

  var TYPES = {};   // filled from data.meta.types

  // how likely you are to run into a fence, a camera or a person
  var ACCESS = {
    open:      { color: '#6f9c6a' },
    private:   { color: '#b8a37e' },
    secured:   { color: '#d9822b' },
    patrolled: { color: '#e0562f' },
    gone:      { color: '#7a7069' }
  };
  var ACCESS_LABEL = {};   // filled from data.meta.access

  var state = {
    sites: [],
    active: Object.keys(CAT),   // enabled categories
    type: '',                   // '' = all types
    access: '',                 // '' = any access status
    query: '',
    sort: 'recent',
    selected: null
  };

  var markers = {};   // id -> L.Marker
  var map, layer;

  var els = {
    list: document.getElementById('list'),
    search: document.getElementById('search'),
    filters: document.getElementById('filters'),
    sort: document.getElementById('sort'),
    type: document.getElementById('type'),
    access: document.getElementById('access'),
    accessNote: document.getElementById('access-note'),
    count: document.getElementById('count'),
    updated: document.getElementById('updated'),
    sidebar: document.getElementById('sidebar'),
    toggle: document.getElementById('toggle-sidebar'),
    handle: document.getElementById('sheet-handle'),
    summary: document.getElementById('sheet-summary')
  };

  function isMobile() {
    return window.matchMedia('(max-width: 760px)').matches;
  }

  // collapsed on mobile = sheet parked at the bottom; on desktop = sidebar slid out
  function setCollapsed(on) {
    els.sidebar.classList.toggle('collapsed', on);
    els.handle.setAttribute('aria-expanded', String(!on));
    setTimeout(function () { map.invalidateSize(); }, 300);
  }

  function accessBadge(s) {
    var a = ACCESS[s.access];
    if (!a) return '';
    return '<span class="access" style="--access-color:' + a.color + '">' +
             esc(ACCESS_LABEL[s.access] || s.access) +
           '</span>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- map ----------

  function initMap() {
    map = L.map('map', { zoomControl: false }).setView([56.8, -4.2], 6);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }

  function pinIcon(cat, selected) {
    var color = (CAT[cat] || {}).color || '#999';
    return L.divIcon({
      className: '',
      html: '<div class="pin' + (selected ? ' sel' : '') + '" style="background:' + color + '"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }

  function popupHtml(s) {
    var cat = CAT[s.category] || { label: s.category, color: '#999' };
    var html =
      '<h3 class="pop-title">' + esc(s.name) + '</h3>' +
      '<p class="pop-meta">' +
        '<span class="tag" style="color:' + cat.color + '">' + esc(cat.label) + '</span>' +
        ' &middot; ' + esc(TYPES[s.type] || s.type) +
        ' &middot; ' + esc(s.region) +
        (s.year ? ' &middot; ' + esc(s.year) : '') +
      '</p>' +
      '<p class="pop-body">' + esc(s.summary) + '</p>' +
      '<p class="pop-meta"><strong>Status:</strong> ' + esc(s.status) + '</p>' +
      '<p class="pop-access">' + accessBadge(s) +
        (s.accessNote ? '<span class="access-why">' + esc(s.accessNote) + '</span>' : '') +
      '</p>';

    if (s.source) {
      html += '<p class="pop-src">Source: <a href="' + esc(s.source) + '" target="_blank" rel="noopener noreferrer">' +
              esc(s.sourceName || s.source) + '</a></p>';
    }
    if (s.confidence === 'approximate') {
      html += '<span class="pop-flag">Location approximate — pinned to the site area, not an exact address.</span>';
    }
    return html;
  }

  function buildMarkers() {
    state.sites.forEach(function (s) {
      var m = L.marker([s.lat, s.lng], { icon: pinIcon(s.category, false), title: s.name });
      m.bindPopup(popupHtml(s));
      m.on('click', function () { select(s.id, false); });
      markers[s.id] = m;
    });
  }

  // ---------- filtering ----------

  function visible() {
    var q = state.query.trim().toLowerCase();
    var out = state.sites.filter(function (s) {
      if (state.active.indexOf(s.category) === -1) return false;
      if (state.type && s.type !== state.type) return false;
      if (state.access && s.access !== state.access) return false;
      if (!q) return true;
      return (s.name + ' ' + s.region + ' ' + s.summary + ' ' + s.status + ' ' +
              s.category + ' ' + s.type + ' ' + (TYPES[s.type] || '') + ' ' +
              s.access + ' ' + (ACCESS_LABEL[s.access] || '') + ' ' + (s.accessNote || ''))
        .toLowerCase().indexOf(q) !== -1;
    });

    if (state.sort === 'name') {
      out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else if (state.sort === 'region') {
      out.sort(function (a, b) { return a.region.localeCompare(b.region) || a.name.localeCompare(b.name); });
    } else {
      out.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
    }
    return out;
  }

  function render() {
    var items = visible();

    layer.clearLayers();
    items.forEach(function (s) { layer.addLayer(markers[s.id]); });

    els.count.textContent = items.length + ' of ' + state.sites.length + ' sites shown';
    els.summary.textContent = items.length === state.sites.length
      ? items.length + ' sites'
      : items.length + ' of ' + state.sites.length + ' sites';

    if (!items.length) {
      els.list.innerHTML = '<li class="empty">Nothing matches those filters.</li>';
      return;
    }

    els.list.innerHTML = items.map(function (s) {
      var cat = CAT[s.category] || { label: s.category, color: '#999' };
      return '<li data-id="' + esc(s.id) + '"' + (s.id === state.selected ? ' class="active"' : '') + '>' +
        '<p class="item-title">' + esc(s.name) + '</p>' +
        '<div class="item-meta">' +
          '<span class="tag" style="color:' + cat.color + '">' +
            '<span class="dot" style="background:' + cat.color + '"></span>' + esc(cat.label) +
          '</span>' +
          '<span>' + esc(TYPES[s.type] || s.type) + '</span>' +
          '<span>' + esc(s.region) + '</span>' +
          (s.year ? '<span>' + esc(s.year) + '</span>' : '') +
          accessBadge(s) +
        '</div>' +
      '</li>';
    }).join('');
  }

  function select(id, fly) {
    state.selected = id;
    var s = state.sites.find(function (x) { return x.id === id; });
    if (!s) return;

    Object.keys(markers).forEach(function (k) {
      markers[k].setIcon(pinIcon(
        state.sites.find(function (x) { return x.id === k; }).category,
        k === id
      ));
    });

    if (fly) {
      var go = function () {
        map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 12), { duration: .7 });
        markers[id].openPopup();
      };
      // on a phone the sheet covers the map, so park it first
      if (isMobile()) {
        setCollapsed(true);
        setTimeout(go, 300);
      } else {
        go();
      }
    }

    Array.prototype.forEach.call(els.list.children, function (li) {
      li.classList.toggle('active', li.dataset.id === id);
    });
  }

  // ---------- controls ----------

  function buildFilters() {
    els.filters.innerHTML = Object.keys(CAT).map(function (key) {
      var c = CAT[key];
      var n = state.sites.filter(function (s) { return s.category === key; }).length;
      return '<button class="chip on" data-cat="' + key + '" style="--chip-color:' + c.color + '" aria-pressed="true">' +
        '<span class="dot"></span>' + esc(c.label) + ' <span>' + n + '</span></button>';
    }).join('');

    els.filters.addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      var cat = btn.dataset.cat;
      var i = state.active.indexOf(cat);
      if (i === -1) state.active.push(cat); else state.active.splice(i, 1);
      btn.classList.toggle('on', i === -1);
      btn.setAttribute('aria-pressed', String(i === -1));
      render();
    });
  }

  // an "all" option plus one per value actually present, with its count.
  // byCount keeps the type list ordered by size; access keeps its own order,
  // which runs from freely accessible to actively guarded.
  function fillSelect(el, field, labels, allLabel, byCount) {
    var counts = {};
    state.sites.forEach(function (s) { counts[s[field]] = (counts[s[field]] || 0) + 1; });

    var keys = Object.keys(labels).filter(function (k) { return counts[k]; });
    if (byCount) {
      keys.sort(function (a, b) { return counts[b] - counts[a] || labels[a].localeCompare(labels[b]); });
    }

    el.innerHTML = '<option value="">' + esc(allLabel) + ' (' + state.sites.length + ')</option>' +
      keys.map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(labels[k]) + ' (' + counts[k] + ')</option>';
      }).join('');
  }

  function wire() {
    els.type.addEventListener('change', function () {
      state.type = els.type.value;
      render();
    });

    els.access.addEventListener('change', function () {
      state.access = els.access.value;
      render();
    });

    els.search.addEventListener('input', function () {
      state.query = els.search.value;
      render();
    });

    els.sort.addEventListener('change', function () {
      state.sort = els.sort.value;
      render();
    });

    els.list.addEventListener('click', function (e) {
      var li = e.target.closest('li[data-id]');
      if (li) select(li.dataset.id, true);
    });

    els.toggle.addEventListener('click', function () {
      setCollapsed(!els.sidebar.classList.contains('collapsed'));
    });

    els.handle.addEventListener('click', function () {
      setCollapsed(!els.sidebar.classList.contains('collapsed'));
    });

    // keep the sheet from getting stuck in a state that only makes sense
    // on the other layout when the device is rotated or the window resized
    var wasMobile = isMobile();
    window.addEventListener('resize', function () {
      var now = isMobile();
      if (now !== wasMobile) {
        wasMobile = now;
        setCollapsed(now);
      } else {
        map.invalidateSize();
      }
    });
  }

  // ---------- boot ----------

  initMap();

  fetch('data/sites.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      state.sites = data.sites || [];
      TYPES = (data.meta && data.meta.types) || {};
      ACCESS_LABEL = (data.meta && data.meta.access) || {};
      if (data.meta && data.meta.accessNote) {
        els.accessNote.textContent = data.meta.accessNote;
      }
      if (data.meta && data.meta.updated) {
        els.updated.textContent = 'Dataset updated ' + data.meta.updated + ' · ' + state.sites.length + ' entries.';
      }
      buildMarkers();
      buildFilters();
      fillSelect(els.type, 'type', TYPES, 'All types', true);
      fillSelect(els.access, 'access', ACCESS_LABEL, 'Any access status', false);
      wire();
      render();
      // phones open on the map, with the list parked at the bottom edge
      if (isMobile()) els.sidebar.classList.add('collapsed');
    })
    .catch(function (err) {
      els.list.innerHTML = '<li class="empty">Could not load data/sites.json (' + esc(err.message) +
        ').<br><br>If you opened this file directly from disk, run a local server instead:<br><code>python -m http.server 8000</code></li>';
    });

})();
