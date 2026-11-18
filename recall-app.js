'use strict';
const $app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let S = { ...R.DEFAULTS };
let view = 'library';
let session = null;

function toast(msg, ms = 2600) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------------- library ---------------- */
async function renderLibrary() {
  view = 'library'; session = null;
  S = await R.getSettings();
  const now = Date.now(), today = R.dayStart(now);
  const [decks, sched, logs] = await Promise.all([R.db.getAll('decks'), R.db.getAll('sched'), R.db.getAll('revlog')]);

  // streak
  const days = new Set(logs.map(l => R.dayStart(l.time)));
  let streak = 0, d = today; if (!days.has(d)) d -= R.DAY;
  while (days.has(d)) { streak++; d -= R.DAY; }
  const reviewedToday = logs.filter(l => l.time >= today);

  // per-deck data
  const byDeck = {};
  for (const c of sched) (byDeck[c.deck] = byDeck[c.deck] || []).push(c);
  const introBy = {}, revBy = {};
  for (const l of reviewedToday) { if (l.prev === 2) revBy[l.deck] = (revBy[l.deck] || 0) + 1; }
  for (const c of sched) if (c.intro >= today) introBy[c.deck] = (introBy[c.deck] || 0) + 1;

  // tree
  const root = { children: new Map(), path: '', ids: [] };
  for (const dk of decks) {
    let node = root, path = '';
    for (const part of dk.name.split('::')) {
      path = path ? path + '::' + part : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), ids: [] });
      node = node.children.get(part); node.ids.push(dk.id);
    }
  }
  const collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));
  const rows = [];
  const walk = (node, depth) => {
    const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of kids) {
      const list = n.ids.flatMap(id => byDeck[id] || []);
      const cnt = R.countDeck(list, now, n.ids.reduce((s, id) => s + (introBy[id] || 0), 0), n.ids.reduce((s, id) => s + (revBy[id] || 0), 0), S);
      rows.push({ n, depth, cnt, total: list.length, hasKids: n.children.size > 0 });
      if (n.children.size && !collapsed.has(n.path)) walk(n, depth + 1);
    }
  };
  // ids of a node include descendants' decks (pushed along the path) so counts roll up
  walk(root, 0);

  const totalCards = sched.length;
  const html = [`<div class="view"><div class="bar"><h1>Recall</h1>
    <button class="iconbtn" id="b-settings" aria-label="Settings">⚙︎</button></div><div class="scroll">`];
  if (!decks.length) {
    html.push(`<div class="empty-state"><div style="font-size:54px">🗂️</div><h2>No decks yet</h2>
      <p>Import an Anki <b>.apkg</b> file to start studying. Everything stays on this device and works offline.</p>
      <button class="btn" id="b-import">Import deck</button>
      <p style="margin-top:18px;font-size:13px">Tip: in Anki choose File → Export → "Anki Deck Package (.apkg)". Include media for audio and images.</p></div>`);
  } else {
    html.push(`<div class="stats"><div class="stat"><b>${reviewedToday.length}</b><span>reviewed today</span></div>
      <div class="stat"><b>${streak}</b><span>day streak</span></div><div class="stat"><b>${totalCards}</b><span>total cards</span></div></div>
      <div class="cnthead"><span>New</span><span>Learn</span><span>Due</span></div><div class="decks">`);
    for (const r of rows) {
      const z = (v, cls) => `<i class="${cls}${v ? '' : ' z'}">${v}</i>`;
      html.push(`<div class="deck" style="padding-left:${8 + r.depth * 18}px">
        <button class="chev ${r.hasKids ? '' : 'empty'}" data-toggle="${esc(r.n.path)}">${collapsed.has(r.n.path) ? '▶' : '▼'}</button>
        <button class="name" data-study="${esc(r.n.path)}">${esc(r.n.name)}</button>
        <div class="cnt">${z(r.cnt.new, 'n')}${z(r.cnt.learn, 'l')}${z(r.cnt.due, 'd')}</div>
        <button class="more" data-del="${esc(r.n.path)}" aria-label="Deck options">⋯</button></div>`);
    }
    html.push('</div>');
  }
  html.push('</div>');
  if (decks.length) html.push('<button class="btn fab" id="b-import">＋ Import</button>');
  html.push('</div>');
  $app.innerHTML = html.join('');

  $app.querySelectorAll('[data-study]').forEach(b => b.onclick = () => startStudy(b.dataset.study));
  $app.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    const p = b.dataset.toggle; collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p);
    localStorage.setItem('collapsed', JSON.stringify([...collapsed])); renderLibrary();
  });
  $app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const p = b.dataset.del;
    const ids = decks.filter(x => x.name === p || x.name.startsWith(p + '::')).map(x => x.id);
    if (!confirm(`Delete "${p}" and its ${ids.reduce((s, id) => s + (byDeck[id] || []).length, 0)} cards, including your progress? This can't be undone.`)) return;
    await R.deleteDecks(ids); toast('Deck deleted'); renderLibrary();
  });
  const bi = document.getElementById('b-import'); if (bi) bi.onclick = () => document.getElementById('file').click();
  document.getElementById('b-settings').onclick = openSettings;
}

/* ---------------- import UI ---------------- */
async function doImport(files) {
  files = [...files].filter(f => /\.(apkg|colpkg|zip)$/i.test(f.name));
  if (!files.length) { toast('Please choose an .apkg file'); return; }
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = '<div class="sheet" style="text-align:center"><div class="spinner"></div><div id="imp-msg">Starting…</div></div>';
  document.body.appendChild(ov);
  const msg = (t) => { const e = document.getElementById('imp-msg'); if (e) e.textContent = t; };
  try {
    for (const f of files) {
      const r = await R.importApkg(f, (t) => msg(files.length > 1 ? `${f.name}\n${t}` : t));
      toast(`Imported ${r.cards} cards${r.media ? ` and ${r.media} media files` : ''}`, 3500);
    }
  } catch (e) {
    console.error(e); alert('Import failed: ' + (e.message || e));
  } finally { ov.remove(); if (view === 'library') renderLibrary(); }
}
document.getElementById('file').addEventListener('change', e => { const f = e.target.files; if (f.length) doImport(f); e.target.value = ''; });
(() => {
  const drop = document.createElement('div'); drop.className = 'drop'; drop.textContent = 'Drop .apkg to import'; document.body.appendChild(drop);
  let n = 0;
  addEventListener('dragenter', e => { e.preventDefault(); n++; drop.classList.add('on'); });
  addEventListener('dragleave', e => { e.preventDefault(); if (--n <= 0) { n = 0; drop.classList.remove('on'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); n = 0; drop.classList.remove('on'); if (e.dataTransfer.files.length) doImport(e.dataTransfer.files); });
})();

/* ---------------- settings ---------------- */
async function openSettings() {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
  const used = est ? `${(est.usage / 1048576).toFixed(1)} MB used` : '';
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet"><h2>Settings</h2>
    <label class="field"><span>New cards / day</span><input type="number" id="s-new" min="0" value="${S.newPerDay}"></label>
    <label class="field"><span>Max reviews / day</span><input type="number" id="s-rev" min="0" value="${S.revPerDay}"></label>
    <label class="field"><span>Learning steps<small>minutes</small></span><input type="text" id="s-steps" value="${S.steps.join(' ')}"></label>
    <label class="field"><span>Relearning steps<small>minutes</small></span><input type="text" id="s-relearn" value="${S.relearn.join(' ')}"></label>
    <label class="field"><span>Autoplay audio</span><input type="checkbox" id="s-auto" ${S.autoplay ? 'checked' : ''}></label>
    <div class="field"><span>Storage<small>${used}</small></span><button class="btn ghost" id="s-persist">Keep data</button></div>
    <div style="color:var(--muted);font-size:12px;margin-top:12px">Recall version ${R.VERSION}</div>
    <div class="row"><button class="btn ghost" id="s-cancel">Cancel</button><button class="btn" id="s-save">Save</button></div></div>`;
  document.body.appendChild(ov);
  const parse = (v, fb) => { const a = v.split(/[\s,]+/).map(Number).filter(x => x > 0); return a.length ? a : fb; };
  ov.querySelector('#s-cancel').onclick = () => ov.remove();
  ov.querySelector('#s-persist').onclick = async () => {
    const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
    toast(ok ? 'Storage will be kept' : 'Browser declined. Adding the app to your home screen helps.');
  };
  ov.querySelector('#s-save').onclick = async () => {
    S = { newPerDay: Math.max(0, +ov.querySelector('#s-new').value || 0), revPerDay: Math.max(0, +ov.querySelector('#s-rev').value || 0),
      steps: parse(ov.querySelector('#s-steps').value, [1, 10]), relearn: parse(ov.querySelector('#s-relearn').value, [10]), autoplay: ov.querySelector('#s-auto').checked };
    await R.db.put('meta', S, 'settings'); ov.remove(); renderLibrary();
  };
}

/* ---------------- study ---------------- */
async function startStudy(path) {
  S = await R.getSettings();
  const decks = (await R.db.getAll('decks')).filter(d => d.name === path || d.name.startsWith(path + '::'));
  const ids = new Set(decks.map(d => d.id));
  const sched = (await R.db.getAll('sched')).filter(c => ids.has(c.deck));
  const today = R.dayStart();
  const logs = (await R.db.revlogSince(today)).filter(l => ids.has(l.deck));
  session = {
    path, ids, cards: new Map(sched.map(c => [c.id, c])),
    introduced: sched.filter(c => c.intro >= today).length,
    reviewed: logs.filter(l => l.prev === 2).length,
    answered: logs.length, extraNew: 0, undo: null, cur: null, showing: 'q', t0: 0,
  };
  view = 'study'; nextCard();
}

function pickNext() {
  const now = Date.now(), end = R.dayStart(now) + R.DAY - 1;
  let learn = null, learnAhead = null, rev = null, nw = null;
  let nL = 0, nR = 0, nN = 0;
  for (const c of session.cards.values()) {
    if (c.state === 0) { nN++; if (!nw || c.seq < nw.seq) nw = c; }
    else if (c.state === 2) { if (c.due <= end) { nR++; if (!rev || c.due < rev.due || (c.due === rev.due && c.seq < rev.seq)) rev = c; } }
    else if (c.due <= end) {
      nL++;
      if (c.due <= now) { if (!learn || c.due < learn.due) learn = c; }
      else if (c.due <= now + 20 * 60000) { if (!learnAhead || c.due < learnAhead.due) learnAhead = c; }
    }
  }
  const newLeft = Math.max(0, S.newPerDay + session.extraNew - session.introduced);
  const revLeft = Math.max(0, S.revPerDay - session.reviewed);
  const counts = { new: Math.min(nN, newLeft), learn: nL, due: Math.min(nR, revLeft), totalNew: nN };
  let card = learn || (revLeft > 0 ? rev : null) || (newLeft > 0 ? nw : null) || learnAhead;
  return { card, counts };
}

async function nextCard() {
  const { card, counts } = pickNext();
  if (!card) { return renderDone(counts); }
  session.cur = card; session.showing = 'q'; session.t0 = Date.now();
  renderStudyFrame(counts);
  await showSide('q');
}

function studyShell(counts) {
  const cur = session.cur;
  const k = cur ? (cur.state === 0 ? 'n' : cur.state === 2 ? 'd' : 'l') : '';
  return `<div class="view"><div class="sbar"><button class="iconbtn" id="s-back" aria-label="Back">←</button>
    <div class="title">${esc(session.path.split('::').pop())}</div>
    <button class="iconbtn" id="s-undo" aria-label="Undo" ${session.undo ? '' : 'disabled'}>↶</button></div>
    <div class="scnt"><span style="color:var(--new)" class="${k === 'n' ? 'cur' : ''}">${counts.new}</span>
    <span style="color:var(--learn)" class="${k === 'l' ? 'cur' : ''}">${counts.learn}</span>
    <span style="color:var(--due)" class="${k === 'd' ? 'cur' : ''}">${counts.due}</span></div>`;
}

function renderStudyFrame(counts) {
  $app.innerHTML = studyShell(counts) + `<div class="cardwrap"><iframe id="cf" sandbox="allow-same-origin" title="Card"></iframe></div>
    <div class="actions" id="actions"></div></div>`;
  document.getElementById('s-back').onclick = renderLibrary;
  document.getElementById('s-undo').onclick = undo;
}

function cardDoc(body, css) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `<!doctype html><html class="${dark ? 'night_mode' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body{margin:0}.rc-wrap{min-height:calc(100vh - 36px);display:flex;flex-direction:column;justify-content:center}body{box-sizing:border-box;padding:18px 16px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:20px;text-align:center;color:${dark ? '#e8efed' : '#14201e'};background:transparent;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}audio,video{max-width:100%}hr{width:100%;border:0;border-top:1px solid ${dark ? '#334' : '#d5dbd9'}}
  .cloze{font-weight:700;color:#2563eb}.typeans{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;max-width:100%}
  details.hint summary{color:#2563eb;cursor:pointer}</style><style>${css}</style></head>
  <body class="card ${dark ? 'nightMode night_mode' : ''}"><div class="rc-wrap"><div>${body}</div></div></body></html>`;
}

const cache = { models: new Map() };
async function showSide(side) {
  const c = session.cur; if (!c) return;
  session.showing = side;
  const content = await R.db.get('cards', c.id);
  if (!content) { session.cards.delete(c.id); return nextCard(); }
  let css = cache.models.get(content.mid);
  if (css === undefined) { const m = await R.db.get('models', content.mid); css = await R.resolveCss((m && m.css) || '', content.imp); cache.models.set(content.mid, css); }
  const html = await R.resolveHtml(side === 'q' ? content.q : content.a, content.imp);
  if (session.cur !== c) return;
  const f = document.getElementById('cf'); if (!f) return;
  f.onload = () => {
    const doc = f.contentDocument; if (!doc) return;
    doc.addEventListener('keydown', onKey);
    if (side === 'a') { const a = doc.getElementById('answer'); if (a) a.scrollIntoView(); }
    if (S.autoplay) {
      let au = null;
      if (side === 'q') au = doc.querySelector('audio');
      else { const a = doc.getElementById('answer'); au = a ? [...doc.querySelectorAll('audio')].find(x => a.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) : null; }
      if (au) au.play().catch(() => {});
    }
  };
  f.srcdoc = cardDoc(html, css);
  const act = document.getElementById('actions');
  if (side === 'q') {
    act.innerHTML = '<button class="btn big" id="show">Show answer</button>';
    document.getElementById('show').onclick = () => showSide('a');
  } else {
    const now = Date.now(); const labels = [1, 2, 3, 4].map(r => R.previewLabel(c, r, now, S));
    const names = ['Again', 'Hard', 'Good', 'Easy'];
    act.innerHTML = `<div class="rate">${[1, 2, 3, 4].map((r, i) => `<button class="r${r}" data-r="${r}">${names[i]}<small>${labels[i]}</small></button>`).join('')}</div>`;
    act.querySelectorAll('button').forEach(b => b.onclick = () => answer(+b.dataset.r));
  }
}

async function answer(rating) {
  const c = session.cur; if (!c || session.showing !== 'a') return;
  const now = Date.now(); const prev = { ...c };
  const n = R.schedule(c, rating, now, S);
  session.cards.set(c.id, n);
  if (prev.state === 0) session.introduced++;
  if (prev.state === 2) session.reviewed++;
  session.answered++;
  await R.db.put('sched', n);
  const key = await R.db.add('revlog', { card: c.id, deck: c.deck, time: now, rating, prev: prev.state, ivl: n.ivl, ms: now - session.t0 });
  session.undo = { prev, key };
  nextCard();
}

async function undo() {
  const u = session.undo; if (!u) return;
  session.cards.set(u.prev.id, u.prev);
  await R.db.put('sched', u.prev); await R.db.del('revlog', u.key);
  if (u.prev.state === 0) session.introduced--;
  if (u.prev.state === 2) session.reviewed--;
  session.answered--; session.undo = null;
  const { counts } = pickNext();
  session.cur = u.prev; session.showing = 'q';
  renderStudyFrame(counts); await showSide('q');
}

function renderDone(counts) {
  session.cur = null;
  const more = counts.totalNew > 0;
  $app.innerHTML = studyShell(counts) + `<div class="done"><div class="big">🎉</div><h2>All done for now</h2>
    <p>${session.answered ? `You reviewed ${session.answered} card${session.answered === 1 ? '' : 's'} today.` : 'Nothing is due in this deck right now.'}</p>
    ${more ? `<button class="btn big" id="more" style="margin-bottom:10px">Study 10 more new cards</button>` : ''}
    <button class="btn ghost big" id="home">Back to decks</button></div></div>`;
  document.getElementById('s-back').onclick = renderLibrary; document.getElementById('home').onclick = renderLibrary;
  document.getElementById('s-undo').onclick = undo;
  if (more) document.getElementById('more').onclick = () => { session.extraNew += 10; nextCard(); };
}

function onKey(e) {
  if (view !== 'study' || !session || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && e.target.tagName === 'INPUT' && e.key !== 'Enter') return;
  if (session.cur && session.showing === 'q' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); showSide('a'); }
  else if (session.cur && session.showing === 'a') {
    if (e.key >= '1' && e.key <= '4') answer(+e.key);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(3); }
  }
  if ((e.key === 'z' || e.key === 'Z') && session.undo) undo();
}
document.addEventListener('keydown', onKey);

/* ---------------- boot ---------------- */
(async () => {
  try { await R.db.open(); await renderLibrary(); }
  catch (e) { $app.innerHTML = `<div class="empty-state"><h2>Storage unavailable</h2><p>${esc(e.message || e)}<br>Private browsing can block local storage.</p></div>`; }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      // remove service workers left behind by earlier versions of this app
      for (const reg of await navigator.serviceWorker.getRegistrations()) {
        const w = reg.active || reg.waiting || reg.installing;
        if (w && !w.scriptURL.endsWith('recall-sw.js')) await reg.unregister();
      }
    } catch (err) { /* ignore */ }
    navigator.serviceWorker.register('recall-sw.js').catch(() => {});
  }
})();
