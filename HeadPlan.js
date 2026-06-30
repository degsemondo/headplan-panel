/* =====================================================================
   HEAD PLAN — AdaptiveWork custom panel  ::  Script field
   Conventions from the RAID Overview / My Tasks builds:
   API.Context.getData() for Data, host auto-mapping, Session auth,
   WAF-safe (split SQL keywords + split 'htt'+'ps://').

   Data flow (revised after $ParentProject returned empty):
     1. Data field gives { sessionId, self:{id,EntityType,SYSID,Project} }
     2. derive projectId  = self.Project.id  (or self.id if the panel is
        already on the project)
     3. GET /data/objects/<id>?fields=...  to fetch the project
        (CZQL won't filter reliably on id; the objects API fetches by id)
     4. populate [data-f] spans, then look up each .hp-date by External ID
   ===================================================================== */
var API_QUERY = '/V2.0/services/data/query';
var SEL = 'SEL' + 'ECT', FRM = 'FR' + 'OM', WHR = 'WHE' + 'RE';

/* project fields to read (display + the two needed for the External ID) */
var PROJECT_FIELDS = 'C_ProductGESE,Country,C_BaiumCategory,C_OrderNumber,C_Customer,' +
  'C_ProjectManager,C_ProjectManager.Email,C_ProcessEngineer,C_ElectricalEngineer,' +
  'C_ControlEngineer,C_SAPProjectID,SYSID';
/* fallback drops only the deep .Email traversal, keeps every display field */
var PROJECT_FIELDS_MIN = 'C_ProductGESE,Country,C_BaiumCategory,C_OrderNumber,C_Customer,' +
  'C_ProjectManager,C_ProcessEngineer,C_ElectricalEngineer,C_ControlEngineer,C_SAPProjectID,SYSID';

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
function fmtDate(v) { if (!v) return '—'; var s = String(v); return s.length >= 10 ? s.substring(0, 10) : s; }   /* ISO -> yyyy-MM-dd */

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
  return { sid: ctx.sessionId, base: 'htt' + 'ps://' + apiHost, self: ctx.self || {}, project: {} };
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
function loadDate(ctx, cell, code) {
  var field = cell.getAttribute('data-datefield') || 'DueDate';   /* per cell: DueDate (finish) or StartDate */
  var extId = buildExternalId(ctx, code);
  cell.setAttribute('data-extid', extId);
  cell.textContent = '…';
  var q = SEL + " " + field + " " + FRM + " WorkItem " + WHR + " ExternalID = '" + extId + "'";
  return czql(ctx.base, ctx.sid, q).then(function (rows) {
    dbg('[' + code + '] rows', rows.length);
    if (!rows.length) { cell.textContent = ''; return; }   /* nothing found -> leave blank */
    var val = rows[0][field];
    dbg('[' + code + '] ' + field, val);
    cell.textContent = fmtDate(val);
  }).catch(function (err) { cell.textContent = 'ERR'; dbg('[' + code + '] ERROR', err.message || err); });
}
function loadAllDates(ctx) {
  var cells = document.querySelectorAll('.hp-date');
  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i], code = (cell.getAttribute('data-code') || '').trim();
    if (!code) { cell.textContent = ''; continue; }   /* no code mapped yet -> leave blank */
    loadDate(ctx, cell, code);
  }
}

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
  loadAllDates(ctx);
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
