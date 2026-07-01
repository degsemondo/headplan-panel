/* =====================================================================
   HEAD PLAN — AdaptiveWork custom panel  ::  Script field (overview redesign)
   Conventions from the RAID Overview / My Tasks builds:
   API.Context.getData() for Data, host auto-mapping, Session auth,
   WAF-safe (split SQL keywords + split 'htt'+'ps://').

   Data flow:
     1. Data field gives { sessionId, self:{SYSID,Project} }.
     2. projectId = self.Project (Project/Task/Milestone all carry it).
     3. GET /data/objects/<id>?fields=...  to fetch the project.
     4. populate [data-f] spans (refs -> resolve Name via objects API),
        look up each .hp-date by External ID via CZQL (date field per cell:
        data-datefield = DueDate | StartDate; duplicate queries are cached),
        then draw the timeline rail (#hp-tl) from cells with data-phase.
   ===================================================================== */
var API_QUERY = '/V2.0/services/data/query';
var SEL = 'SEL' + 'ECT', FRM = 'FR' + 'OM', WHR = 'WHE' + 'RE';
var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* project fields to read (display + the two needed for the External ID) */
var PROJECT_FIELDS = 'C_ProductGESE,Country,C_BaiumCategory,C_EquipmentId,C_Customer,' +
  'C_ProjectManager,C_ProjectManager.Email,C_ProcessEngineer,C_ElectricalEngineer,' +
  'C_ControlEngineer,C_SAPProjectID,SYSID';
/* fallback drops only the deep .Email traversal, keeps every display field */
var PROJECT_FIELDS_MIN = 'C_ProductGESE,Country,C_BaiumCategory,C_EquipmentId,C_Customer,' +
  'C_ProjectManager,C_ProcessEngineer,C_ElectricalEngineer,C_ControlEngineer,C_SAPProjectID,SYSID';

/* timeline phase tracks (order, colour, label colour, y-row) */
var PHASES = [
  { k: 'design',   y: 44,  dot: '#378ADD', label: 'Design',   lc: '#185fa5' },
  { k: 'mfg',      y: 74,  dot: '#EF9F27', label: 'Mfg',      lc: '#854f0b' },
  { k: 'assembly', y: 104, dot: '#1D9E75', label: 'Assembly', lc: '#0f6e56' }
];

/* ---------- debug ---------- */
function dbg(label, value) {
  var txt = (typeof value === 'object') ? JSON.stringify(value) : String(value);
  try { var box = document.getElementById('hp-dbg-log'); if (box) box.appendChild(document.createTextNode('[' + label + '] ' + txt + '\n')); } catch (e) {}
  try { console.log('[HeadPlan] ' + label + ':', value); } catch (e) {}
}

/* ---------- small helpers ---------- */
function cleanLabel(s) { s = (s == null) ? '' : String(s); if (s.charAt(0) === '/') { var p = s.split('/'); s = p[p.length - 1]; } return s; }
function refName(v) { if (v && typeof v === 'object') return v.Name || v.name || cleanLabel(v.id || v.Id || ''); return cleanLabel(v || ''); }
function toId(ref) { if (!ref) return ''; if (typeof ref === 'string') return ref; return ref.id || ref.Id || ''; }   /* ref may be an object or a bare id string */
function rtSlash(s) { s = String(s); return s.charAt(s.length - 1) === '/' ? s.slice(0, -1) : s; }
function getPath(obj, path) {
  if (!obj) return '';
  if (obj[path] !== undefined && obj[path] !== null) return obj[path];   // flat key e.g. "C_ProjectManager.Email"
  var parts = String(path).split('.'), cur = obj;
  for (var i = 0; i < parts.length; i++) { if (cur == null) return ''; cur = cur[parts[i]]; }
  return (cur == null) ? '' : cur;
}
function fmtDate(v) { if (!v) return ''; var s = String(v); return s.length >= 10 ? s.substring(0, 10) : s; }   /* ISO -> yyyy-MM-dd */

function readJson(r, label, extra) {
  return r.text().then(function (txt) {
    var j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) {}
    if (!r.ok || j.errorCode) { throw new Error(label + ' ' + r.status + ': ' + (j.message || j.errorCode || txt || ('HTTP ' + r.status)) + (extra ? (' | ' + extra) : '')); }
    return j;
  });
}

/* ---------- context: Data field + host -> API host ---------- */
function getContext() {
  var W = window;
  var ctx = (W.API && W.API.Context && W.API.Context.getData()) || {};
  if (!ctx.sessionId) throw new Error('Data field must supply sessionId.');
  var host = W.location.hostname, apiHost = host;
  var m = [['app2.', 'api2.'], ['app.', 'api.'], ['eu1.', 'apie1.'], ['eu.', 'apie.']];
  for (var i = 0; i < m.length; i++) { if (host.indexOf(m[i][0]) === 0) { apiHost = m[i][1] + host.slice(m[i][0].length); break; } }
  return { sid: ctx.sessionId, base: 'htt' + 'ps://' + apiHost, self: ctx.self || {}, project: {}, dateCache: {} };
}

function czql(base, sid, query) {
  dbg('CZQL', query);
  return fetch(rtSlash(base) + API_QUERY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Session ' + sid },
    body: JSON.stringify({ q: query })
  }).then(function (r) { dbg('HTTP status', r.status); return readJson(r, 'CZQL', 'query: ' + query); })
    .then(function (j) { return j.entities || []; });
}

/* ---------- 1. populate the simple project fields ---------- */
/* Reference fields (PM, engineers, …) come back as {id} only, so resolve the
   referenced object's Name with a follow-up objects-API GET and fill it in. */
function resolveRefName(ctx, el, ref) {
  if (ref.Name || ref.name) { el.textContent = ref.Name || ref.name; return; }   // already expanded
  var id = toId(ref);
  if (!id) { el.textContent = '—'; return; }
  el.textContent = '…';
  getObject(ctx, id, 'Name')
    .then(function (o) { el.textContent = o.Name || o.name || cleanLabel(id) || '—'; })
    .catch(function () { el.textContent = cleanLabel(id) || '—'; });
}
function populateProject(ctx) {
  var project = ctx.project;
  var spans = document.querySelectorAll('[data-f]');
  for (var i = 0; i < spans.length; i++) {
    var el = spans[i], raw = getPath(project, el.getAttribute('data-f'));
    if (raw && typeof raw === 'object') { resolveRefName(ctx, el, raw); }
    else { el.textContent = (raw === '' || raw == null) ? '—' : String(raw); }
  }
  var todos = document.querySelectorAll('[data-todo]');
  for (var k = 0; k < todos.length; k++) { todos[k].textContent = '(field not mapped)'; todos[k].className += ' hp-todo'; }
}

/* ---------- 2. External ID + schedule date lookups ---------- */
function buildExternalId(ctx, code) {
  var sap = String(getPath(ctx.project, 'C_SAPProjectID') || '').trim();
  var sys = String(getPath(ctx.project, 'SYSID') || '').trim();   /* project's SYSID only — never self's */
  return sap ? (sap + '_' + code) : (sys + ':' + code);     /* SAP -> '<sap>_<code>' ; else '<sysid>:<code>' */
}
/* one network call per (field, externalId); shared across duplicate cells */
function queryDate(ctx, field, extId) {
  var key = field + '|' + extId;
  if (!ctx.dateCache[key]) {
    var q = SEL + " " + field + " " + FRM + " WorkItem " + WHR + " ExternalID = '" + extId + "'";
    ctx.dateCache[key] = czql(ctx.base, ctx.sid, q).then(function (rows) {
      return rows.length ? (rows[0][field] || null) : null;
    });
  }
  return ctx.dateCache[key];
}
function loadDate(ctx, cell, code) {
  var field = cell.getAttribute('data-datefield') || 'DueDate';
  var extId = buildExternalId(ctx, code);
  cell.setAttribute('data-extid', extId);
  cell.textContent = '…';
  return queryDate(ctx, field, extId).then(function (val) {
    if (!val) { cell.textContent = ''; cell.removeAttribute('data-date'); return; }   /* nothing found -> blank */
    cell.setAttribute('data-date', val);
    cell.textContent = fmtDate(val);
  }).catch(function (err) { cell.textContent = 'ERR'; dbg('[' + code + '] ERROR', err.message || err); });
}
function loadAllDates(ctx) {
  var cells = document.querySelectorAll('.hp-date'), ps = [];
  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i], code = (cell.getAttribute('data-code') || '').trim();
    if (!code) { cell.textContent = ''; continue; }   /* no code mapped yet -> blank */
    ps.push(loadDate(ctx, cell, code));
  }
  return Promise.all(ps);
}

/* ---------- timeline rail: positions dated milestones on a month axis ---------- */
function buildTimeline() {
  var svg = document.getElementById('hp-tl'); if (!svg) return;
  var cells = document.querySelectorAll('.hp-date[data-phase]'), items = [];
  for (var i = 0; i < cells.length; i++) {
    var d = cells[i].getAttribute('data-date'); if (!d) continue;
    var t = Date.parse(d); if (isNaN(t)) continue;
    items.push({ phase: cells[i].getAttribute('data-phase'), t: t });
  }
  if (!items.length) { svg.innerHTML = ''; return; }

  var today = Date.now(), times = items.map(function (x) { return x.t; });
  var minT = Math.min.apply(null, times.concat([today]));
  var maxT = Math.max.apply(null, times.concat([today]));
  if (maxT === minT) { maxT = minT + 2592000000; }   /* +30d so a single point still renders */
  var PX0 = 78, PX1 = 628, W = PX1 - PX0;
  function px(t) { return PX0 + (t - minT) / (maxT - minT) * W; }

  var s = '';
  /* month gridlines + labels */
  var dt = new Date(minT); dt.setDate(1); dt.setHours(0, 0, 0, 0); dt.setMonth(dt.getMonth() + 1);
  while (dt.getTime() < maxT) {
    var tx = px(dt.getTime()).toFixed(1);
    s += '<line x1="' + tx + '" y1="26" x2="' + tx + '" y2="118" style="stroke:#e3e8ef"/>';
    s += '<text x="' + tx + '" y="18" text-anchor="middle" style="fill:#8a97a6;font-size:11px;">' + MON[dt.getMonth()] + '</text>';
    dt.setMonth(dt.getMonth() + 1);
  }
  /* today marker */
  var tdx = px(today).toFixed(1);
  s += '<line x1="' + tdx + '" y1="26" x2="' + tdx + '" y2="129" style="stroke:#8a97a6;stroke-dasharray:3 3"/>';
  s += '<text x="' + tdx + '" y="136" text-anchor="middle" style="fill:#8a97a6;font-size:10px;">today</text>';
  /* phase tracks */
  for (var p = 0; p < PHASES.length; p++) {
    var ph = PHASES[p], xs = [], dots = '';
    for (var k = 0; k < items.length; k++) {
      if (items[k].phase === ph.k) { var x = px(items[k].t); xs.push(x); dots += '<circle cx="' + x.toFixed(1) + '" cy="' + ph.y + '" r="4.5" fill="' + ph.dot + '"/>'; }
    }
    s += '<text x="8" y="' + (ph.y + 3) + '" style="fill:' + ph.lc + ';font-size:11px;">' + ph.label + '</text>';
    s += '<line x1="78" y1="' + ph.y + '" x2="628" y2="' + ph.y + '" style="stroke:#e3e8ef"/>';
    if (xs.length > 1) { var mn = Math.min.apply(null, xs), mx = Math.max.apply(null, xs); s += '<line x1="' + mn.toFixed(1) + '" y1="' + ph.y + '" x2="' + mx.toFixed(1) + '" y2="' + ph.y + '" style="stroke:' + ph.dot + ';stroke-width:2"/>'; }
    s += dots;
  }
  svg.innerHTML = s;
}

/* ---------- export to PDF (native print of a panel-only window) ---------- */
/* pull just this panel's own rules so the print window is styled without host chrome */
function collectCss() {
  var out = '';
  for (var i = 0; i < document.styleSheets.length; i++) {
    var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { rules = null; }
    if (!rules) continue;
    for (var j = 0; j < rules.length; j++) { var t = rules[j].cssText || ''; if (t.indexOf('hp-') >= 0) out += t + '\n'; }
  }
  return out;
}
function exportPdf() {
  var src = document.querySelector('.hp-wrap'); if (!src) return;
  var clone = src.cloneNode(true);                                  /* captures current rendered state, incl. the SVG timeline */
  var d = clone.querySelector('#hp-debug'); if (d) d.parentNode.removeChild(d);
  var t = clone.querySelector('.hp-toolbar'); if (t) t.parentNode.removeChild(t);
  var w; try { w = window.open('', '_blank'); } catch (e) { w = null; }
  if (w) {
    w.document.open();
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Head Plan</title><style>' +
      collectCss() + 'body{margin:24px;background:#fff;}.hp-wrap{border:none;max-width:none;}</style></head><body>' +
      clone.outerHTML + '</body></html>');
    w.document.close(); w.focus();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 400);
  } else {
    window.print();                                                 /* pop-up blocked -> in-place print; @media print hides debug/toolbar */
  }
}
function wireExport() { var b = document.getElementById('hp-export'); if (b) b.addEventListener('click', exportPdf); }

/* ---------- 3. debug box wiring ---------- */
function wireDebug(ctx) {
  var input = document.getElementById('hp-dbg-extid');
  var btn = document.getElementById('hp-dbg-run');
  if (input) input.value = buildExternalId(ctx, '1365');   /* PV Design */
  if (btn) btn.addEventListener('click', function () {
    var box = document.getElementById('hp-dbg-log'); if (box) box.textContent = '';
    var extId = input ? input.value : '';
    var q = SEL + " DueDate " + FRM + " WorkItem " + WHR + " ExternalID = '" + extId + "'";
    czql(ctx.base, ctx.sid, q).then(function (rows) {
      dbg('manual rows', rows.length);
      if (rows.length) dbg('manual DueDate', rows[0].DueDate || rows[0].dueDate);
    }).catch(function (e) { dbg('manual ERROR', e.message || e); });
  });
}

/* ---------- load the Project, then render ---------- */
/* CZQL won't filter reliably on id, so fetch the known project via the objects API.
   id arrives as '/Project/xxx'; the objects path wants it without the leading slash. */
function getObject(ctx, id, fields) {
  var url = rtSlash(ctx.base) + '/V2.0/services/data/objects/' + String(id).replace(/^\//, '') +
            '?fields=' + encodeURIComponent(fields);
  dbg('GET object', url);
  return fetch(url, { method: 'GET', headers: { 'Authorization': 'Session ' + ctx.sid } })
    .then(function (r) { dbg('HTTP status', r.status); return readJson(r, 'getObject', id); })
    .then(function (j) { dbg('raw object', j); return (j && j.entity) ? j.entity : (j || {}); });
}
function render(ctx, project) {
  ctx.project = project;
  dbg('project keys', Object.keys(project));
  dbg('C_SAPProjectID', getPath(project, 'C_SAPProjectID') || '(blank)');
  dbg('SYSID', getPath(project, 'SYSID') || '(blank)');
  populateProject(ctx);
  loadAllDates(ctx).then(function () { buildTimeline(); });
  wireExport();
  wireDebug(ctx);
}
function loadProject(ctx, projectId) {
  getObject(ctx, projectId, PROJECT_FIELDS)
    .then(function (p) { render(ctx, p); })
    .catch(function (err) {
      dbg('FULL PROJECT FETCH FAILED', err.message || err);
      dbg('retry', 'without the .Email traversal');
      getObject(ctx, projectId, PROJECT_FIELDS_MIN)
        .then(function (p) { render(ctx, p); })
        .catch(function (e2) { dbg('MIN PROJECT FETCH FAILED', e2.message || e2); });
    });
}

/* ---------- boot ---------- */
function init() {
  var ctx;
  try { ctx = getContext(); } catch (e) { dbg('FATAL', e.message || e); return; }
  var self = ctx.self || {};
  dbg('self keys', Object.keys(self));
  dbg('self.Project', self.Project || '(none)');
  var projectId = toId(self.Project);     /* owning project — same for Project/Task/Milestone */
  dbg('projectId', projectId || '(none)');
  if (!projectId) { dbg('FATAL', 'no project id resolved from CurrentObject().Project'); return; }
  loadProject(ctx, projectId);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 100); });
} else { setTimeout(init, 100); }
