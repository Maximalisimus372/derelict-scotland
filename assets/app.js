(function () {
  'use strict';

  var CAT = {
    fire:       { label: 'Fire',       color: '#e0562f' },
    storm:      { label: 'Storm',      color: '#4a9ec9' },
    derelict:   { label: 'Derelict',   color: '#b8a37e' },
    demolished: { label: 'Demolished', color: '#8a7f9c' },
    ruin:       { label: 'Ruin',       color: '#6f9c6a' }
  };

  var state = {
    sites: [],
    active: Object.keys(CAT),   // enabled categories
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
    count: document.getElementById('count'),
    updated: document.getElementById('updated'),
    sidebar: document.getElementById('sidebar'),
    toggle: document.getElementById('toggle-sidebar')
  };

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
        ' &middot; ' + esc(s.region) +
        (s.year ? ' &middot; ' + esc(s.year) : '') +
      '</p>' +
      '<p class="pop-body">' + esc(s.summary) + '</p>' +
      '<p class="pop-meta"><strong>Status:</strong> ' + esc(s.status) + '</p>';

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
      if (!q) return true;
      return (s.name + ' ' + s.region + ' ' + s.summary + ' ' + s.status + ' ' + s.category)
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
          '<span>' + esc(s.region) + '</span>' +
          (s.year ? '<span>' + esc(s.year) + '</span>' : '') +
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
      map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 12), { duration: .7 });
      markers[id].openPopup();
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

  function wire() {
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
      els.sidebar.classList.toggle('collapsed');
      setTimeout(function () { map.invalidateSize(); }, 280);
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
      if (data.meta && data.meta.updated) {
        els.updated.textContent = 'Dataset updated ' + data.meta.updated + ' · ' + state.sites.length + ' entries.';
      }
      buildMarkers();
      buildFilters();
      wire();
      render();
    })
    .catch(function (err) {
      els.list.innerHTML = '<li class="empty">Could not load data/sites.json (' + esc(err.message) +
        ').<br><br>If you opened this file directly from disk, run a local server instead:<br><code>python -m http.server 8000</code></li>';
    });

})();
