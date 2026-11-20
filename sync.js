/* Household Hub sync: one shared household for two people, through Supabase.
   Loads after credit.js. Each phone keeps its full copy (works offline) and sends what changed.
   Every bill, debt, payment, cost, change and so on is its own record, so edits on two phones merge;
   when both edit the same record the later edit wins. Signatures and approvals are checked by the
   server: each person signs and approves only for themselves, and a signature is never removed.
   Settings for the connection live in config.js. Without them the app works as before, on this device only. */
(function () {
  const CFG = window.HUB_SYNC || {};
  const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  const KEYS = { base: 'hfh:sync:base', queue: 'hfh:sync:queue', meta: 'hfh:sync:meta', backup: 'hfh:backup:before-sync' };
  const COLLS = ['bills', 'debts', 'payments', 'actions', 'decisions', 'cash', 'accounts', 'sources', 'statements', 'misc', 'changes', 'credit', 'snapshots', 'activity'];
  const DOCS = {
    settings: { get: st => { const s = Object.assign({}, st.settings); delete s.me; return s; }, set: (st, v) => { st.settings = Object.assign({}, v, { me: st.settings.me }); } },
    agreements: { get: st => ({ list: st.agreements, version: st.agreeVersion || 1 }), set: (st, v) => { st.agreements = Array.isArray(v.list) ? v.list : []; st.agreeVersion = v.version || 1; } },
    market: { get: st => st.market || {}, set: (st, v) => { st.market = v || {}; } },
    opps: { get: st => st.opps || {}, set: (st, v) => { st.opps = v || {}; } },
    sent: { get: st => st.sent || {}, set: (st, v) => { st.sent = v || {}; } },
  };
  const GUARDED = ['approve-pay', 'decline-pay', 'approve-misc', 'decline-misc', 'sign-change', 'decline-change'];

  const read = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
  let M = read(KEYS.meta, {});          // { hid, slot, cursor, lastSync, email }
  let base = read(KEYS.base, {});       // key -> canonical JSON as last agreed with the server
  let Q = read(KEYS.queue, {});         // key -> { d: canonical JSON or null for a deletion, t: edited at }
  let B = null, user = null, unsub = null, pushing = false, pulling = false, applying = false, pushT = 0, pullT = 0;
  const ui2 = { step: 'email', email: '', busy: false, err: '', members: [], invites: [] };
  const persist = () => { write(KEYS.meta, M); write(KEYS.base, base); write(KEYS.queue, Q); };

  /* ---------- records ---------- */
  function canon(v) {
    if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  const keyOf = (c, r) => c === 'snapshots' ? r.m : (r.id || (r.id = uid()));
  function toMap(st) {
    const m = {};
    for (const c of COLLS) for (const r of st[c] || []) if (r && typeof r === 'object') m[c + '/' + keyOf(c, r)] = canon(r);
    for (const d in DOCS) m['doc/' + d] = canon(DOCS[d].get(st));
    return m;
  }
  function track() {
    state.settings.me = M.slot;
    const cur = toMap(state), t = new Date().toISOString(); let n = 0;
    for (const k in cur) if (base[k] !== cur[k]) { Q[k] = { d: cur[k], t }; n++; }
    for (const k in base) if (!(k in cur)) { Q[k] = { d: null, t }; n++; }
    base = cur; persist();
    if (n) schedulePush(400);
  }
  function applyRow(r, force) {
    const s = r.deleted || r.data == null ? null : canon(r.data);
    if (Q[r.key]) return false;                                   // a local edit is waiting to go up
    if (!force && (base[r.key] === s || (s === null && !(r.key in base)))) return false;
    const i = r.key.indexOf('/'), c = r.key.slice(0, i), id = r.key.slice(i + 1);
    if (c === 'doc') { if (!DOCS[id] || s === null) return false; DOCS[id].set(state, JSON.parse(s)); }
    else if (COLLS.includes(c)) {
      const arr = Array.isArray(state[c]) ? state[c] : (state[c] = []), j = arr.findIndex(x => x && keyOf(c, x) === id);
      if (s === null) { if (j >= 0) arr.splice(j, 1); }
      else { const obj = JSON.parse(s); if (j >= 0) arr[j] = obj; else if (c === 'activity') arr.unshift(obj); else arr.push(obj); }
    } else return false;
    if (s === null) delete base[r.key]; else base[r.key] = s;
    return true;
  }
  function settle() {
    state.activity.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    state.snapshots.sort((a, b) => String(a.m).localeCompare(String(b.m)));
    state = normalize(state); state.settings.me = M.slot;
    applying = true; try { save(); } finally { applying = false; }
    persist(); render();
  }

  /* ---------- talking to the server ---------- */
  const online = () => navigator.onLine !== false;
  const ready = () => B && user && M.hid && online();
  function schedulePush(ms) { clearTimeout(pushT); pushT = setTimeout(push, ms || 0); }
  function schedulePull(ms) { clearTimeout(pullT); pullT = setTimeout(pull, ms || 0); }
  async function push() {
    if (pushing || !ready()) return;
    const keys = Object.keys(Q); if (!keys.length) return;
    pushing = true; let changed = false; const problems = [];
    try {
      for (let i = 0; i < keys.length; i += 200) {
        const sent = {}, rows = keys.slice(i, i + 200).filter(k => Q[k]).map(k => { const q = Q[k]; sent[k] = q.t; return { key: k, data: q.d === null ? null : JSON.parse(q.d), deleted: q.d === null, edited_at: q.t }; });
        const res = await B.push(M.hid, rows);
        for (const r of res) {
          if (Q[r.key] && Q[r.key].t === sent[r.key]) delete Q[r.key];
          if (!r.ok && r.reason !== 'newer') problems.push(r.reason);
          const was = base[r.key]; delete base[r.key];             // take the server's copy as the agreed one
          if (applyRow(r, !r.ok)) { if (!r.ok || was !== base[r.key]) changed = true; }
        }
      }
      M.lastSync = new Date().toISOString(); M.error = '';
    } catch (e) { M.error = String(e.message || e); }
    finally { pushing = false; persist(); }
    if (changed) settle(); else refreshCard();
    if (problems.length) toast(problems[0]);
    if (Object.keys(Q).length && !M.error) schedulePush(1000);
  }
  async function pull() {
    if (pulling || !ready()) return;
    pulling = true; let changed = false;
    try {
      const since = M.cursor ? new Date(Date.parse(M.cursor.replace(/(\.\d{3})\d+/, '$1')) - 15000).toISOString() : '1970-01-01T00:00:00Z';
      let max = M.cursor || '';
      for (let from = 0; ; from += 1000) {
        const rows = await B.pull(M.hid, since, from, from + 999);
        for (const r of rows) { if (applyRow(r)) changed = true; if (r.updated_at > max) max = r.updated_at; }
        if (rows.length < 1000) break;
      }
      M.cursor = max || M.cursor; M.lastSync = new Date().toISOString(); M.error = '';
    } catch (e) { M.error = String(e.message || e); }
    finally { pulling = false; persist(); }
    if (changed) settle(); else refreshCard();
  }
  async function syncNow() { await push(); await pull(); await push(); }

  function start() {
    if (!B || !user || !M.hid) return;
    if (unsub) unsub();
    unsub = B.subscribe(M.hid, () => schedulePull(300));
    syncNow();
    loadMembers();
  }
  async function loadMembers() {
    try { ui2.members = await B.members(M.hid); ui2.invites = await B.invites(M.hid); refreshCard(); } catch (e) { /* shown on next sync */ }
  }
  function stop() { if (unsub) { unsub(); unsub = null; } }

  /* ---------- joining ---------- */
  function hasData() { return state.bills.length + state.debts.length + state.payments.length + state.misc.length > 0; }
  async function connect() {
    if (!B || !user) return refreshCard();
    try {
      let mem = await B.membership();
      if (!mem) { const h = await B.accept(); if (h) mem = await B.membership(); }
      if (!mem) { M = { email: user.email }; persist(); return refreshCard(); }
      if (M.hid === mem.household_id) { M.slot = mem.slot; persist(); return start(); }
      if (!hasData()) return join(mem);
      ask('Use your household on this phone?', `You are signed in as ${user.email}, in a household that already has data. This phone's own data is replaced by the shared household copy. A backup of this phone's data stays in this browser.`, 'Use household data', () => join(mem));
      refreshCard();
    } catch (e) { M.error = String(e.message || e); persist(); refreshCard(); }
  }
  function join(mem) {
    if (hasData()) write(KEYS.backup, { at: new Date().toISOString(), state });
    stop();
    const keepUi = state.settings.me;
    state = blankState(); state.settings.me = keepUi;
    M = { hid: mem.household_id, slot: mem.slot, email: user.email, cursor: null }; base = {}; Q = {};
    for (const c of COLLS) state[c] = [];
    state.agreements = []; state.settings.me = mem.slot;
    persist();
    applying = true; try { save(); } finally { applying = false; }
    render(); toast('Joined your household. Bringing in the shared data.');
    start();
  }
  async function create(slot) {
    ui2.busy = true; refreshCard();
    try {
      const h = await B.create(slot, `${S().p1} and ${S().p2}`);
      M = { hid: h, slot, email: user.email, cursor: null }; base = {}; Q = {};
      state.settings.me = slot;
      logAct('Started syncing', `Household created by ${S()[slot]}`);
      save();                                                  // queues everything on this phone
      toast('Household started. Uploading this phone\'s data.');
      start();
    } catch (e) { ui2.err = String(e.message || e); }
    ui2.busy = false; refreshCard();
  }
  async function disconnect(clear) {
    stop();
    try { if (B) await B.signOut(); } catch (e) { /* offline is fine */ }
    user = null; M = {}; base = {}; Q = {}; persist();
    if (clear) { state = blankState(); applying = true; try { save(); } finally { applying = false; } }
    ui2.step = 'email'; render();
    toast(clear ? 'Removed from this phone. The household copy is unchanged.' : 'Signed out. This phone keeps its copy but no longer syncs.');
  }

  /* ---------- the app hooks ---------- */
  const baseSave = save;
  save = function () { baseSave(); if (M.hid && !applying) track(); };

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]'); if (!a || !M.hid) return;
    const act = a.dataset.action, w = a.dataset.who;
    const halt = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (GUARDED.includes(act) && w && w !== M.slot) { halt(); return toast(`${who(w)} signs and approves on their own phone, signed in as themselves.`); }
    if (act === 'sample') { halt(); return toast('Sample data is off while this phone syncs with your household.'); }
    if (act === 'reset') { halt(); return ask('Remove the household from this phone?', 'This phone signs out and its copy is cleared. The shared household copy stays as it is for both of you.', 'Remove from this phone', () => disconnect(true), true); }
  }, true);

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]'); if (!a) return;
    switch (a.dataset.action) {
      case 'sync-send': return sendCode();
      case 'sync-verify': return verify();
      case 'sync-back': ui2.step = 'email'; ui2.err = ''; return refreshCard();
      case 'sync-create': return create(a.dataset.slot);
      case 'sync-join': return connect();
      case 'sync-now': return syncNow().then(() => toast(M.error ? 'Could not reach the server' : 'Up to date'));
      case 'sync-signout': return ask('Sign out on this phone?', 'This phone keeps its copy of your data, but stops syncing until you sign in again.', 'Sign out', () => disconnect(false));
      case 'sync-restore': { const b = read(KEYS.backup, null); if (!b) return; return ask('Bring back this phone\'s earlier data?', `Saved ${new Date(b.at).toLocaleString()}. This replaces what is on this phone${M.hid ? ' and in the household' : ''}.`, 'Bring it back', () => { const keepMe = S().me; state = normalize(b.state); state.settings.me = keepMe; rerender(); toast('Earlier data restored'); }, true); }
    }
  });
  document.addEventListener('submit', e => {
    if (e.target.id === 'sync-invite-form') { e.preventDefault(); return invite(); }
    if (e.target.id === 'sync-form') { e.preventDefault(); return ui2.step === 'code' ? verify() : sendCode(); }
  });
  async function sendCode() {
    const el = document.getElementById('sync-email'); const email = (el ? el.value : ui2.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui2.err = 'Enter a valid email'; return refreshCard(); }
    ui2.email = email; ui2.busy = true; ui2.err = ''; refreshCard();
    try { await B.sendCode(email); ui2.step = 'code'; } catch (e) { ui2.err = String(e.message || e); }
    ui2.busy = false; refreshCard();
    const c = document.getElementById('sync-code'); if (c) c.focus();
  }
  async function verify() {
    const el = document.getElementById('sync-code'); const code = (el ? el.value : '').replace(/\D/g, '');
    if (code.length < 6) { ui2.err = 'Enter the code from the email'; return refreshCard(); }
    ui2.busy = true; ui2.err = ''; refreshCard();
    try { user = await B.verify(ui2.email, code); ui2.step = 'email'; await connect(); } catch (e) { ui2.err = String(e.message || e); }
    ui2.busy = false; refreshCard();
  }
  async function invite() {
    const el = document.getElementById('sync-invite'); const email = (el ? el.value : '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { ui2.err = 'Enter their email'; return refreshCard(); }
    ui2.busy = true; ui2.err = ''; refreshCard();
    try { await B.invite(M.hid, email); await loadMembers(); toast(`Invited. ${email} signs in with that email to join.`); } catch (e) { ui2.err = String(e.message || e); }
    ui2.busy = false; refreshCard();
  }

  /* ---------- the Settings card ---------- */
  const when = iso => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  function status() {
    const n = Object.keys(Q).length;
    if (!online()) return ['s-warn', n ? `Offline. ${n} change${n === 1 ? '' : 's'} will send when you are back online.` : 'Offline. Changes send when you are back online.'];
    if (M.error) return ['s-warn', /fetch|network|load failed/i.test(M.error) ? `Could not reach the server.${n ? ` ${n} change${n === 1 ? '' : 's'} waiting; they send automatically.` : ' Trying again shortly.'}` : `Could not sync: ${M.error}`];
    if (n) return ['s-due', `Sending ${n} change${n === 1 ? '' : 's'}…`];
    return ['s-good', M.lastSync ? `Up to date · ${when(M.lastSync)}` : 'Connecting…'];
  }
  function cardBody() {
    const err = ui2.err ? `<div class="notice warn" style="margin:10px 0"><div class="small">${esc(ui2.err)}</div></div>` : '';
    const dis = ui2.busy ? 'disabled' : '';
    if (!CFG.url && !CFG.test) return `<p class="small muted" style="margin:0">Not set up yet. Once the household's Supabase project is connected (see SYNC.md), both of you sign in here and the app keeps your two phones in step.</p>`;
    if (!B) return `<p class="small muted" style="margin:0">${online() ? 'Loading…' : 'Offline. Sync starts when this phone is back online.'}</p>`;
    if (!user) {
      if (ui2.step === 'code') return `<form id="sync-form"><p class="small muted" style="margin-top:0">We emailed a code to <b>${esc(ui2.email)}</b>. Enter it here. It can take a minute to arrive.</p>
        <div class="fields"><div class="field"><label for="sync-code">Code</label><input id="sync-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></div></div>${err}
        <div class="row"><button class="btn primary" type="submit" ${dis}>Sign in</button><button class="btn" type="button" data-action="sync-back">Use another email</button></div></form>`;
      return `<form id="sync-form"><p class="small muted" style="margin-top:0">Sign in to share one household between your two phones. No password: we email you a code.</p>
        <div class="fields"><div class="field"><label for="sync-email">Your email</label><input id="sync-email" type="email" autocomplete="email" value="${esc(ui2.email)}" placeholder="name@example.com"></div></div>${err}
        <div class="row"><button class="btn primary" type="submit" ${dis}>Email me a code</button></div></form>`;
    }
    if (!M.hid) return `<p class="small muted" style="margin-top:0">Signed in as <b>${esc(user.email)}</b>. No household yet. If your partner already started one, ask them to invite this email, then tap Check for an invite. Otherwise start it here; this phone's data becomes the household's.</p>${err}
      <div class="row"><button class="btn primary" data-action="sync-create" data-slot="p1" ${dis}>Start it as ${esc(S().p1)}</button><button class="btn primary" data-action="sync-create" data-slot="p2" ${dis}>Start it as ${esc(S().p2)}</button><button class="btn" data-action="sync-join" ${dis}>Check for an invite</button></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-action="sync-signout">Sign out</button></div>`;
    const [cls, txt] = status(), other = M.slot === 'p1' ? 'p2' : 'p1';
    const partner = ui2.members.find(m => m.slot === other), inv = ui2.invites.find(i => i.slot === other);
    const backup = read(KEYS.backup, null);
    return `<p style="margin-top:0"><span class="pill ${cls}">${esc(txt)}</span></p>
      <ul class="list"><li><div class="main"><div class="title">${esc(S()[M.slot])}</div><div class="sub">${esc(user.email)} · this phone</div></div><div class="end"><span class="pill s-good">Signed in</span></div></li>
      <li><div class="main"><div class="title">${esc(S()[other])}</div><div class="sub">${partner ? esc(partner.email || '') : inv ? 'Invited: ' + esc(inv.email) : 'Not joined yet'}</div></div><div class="end"><span class="pill ${partner ? 's-good' : 's-due'}">${partner ? 'Joined' : inv ? 'Invited' : 'Waiting'}</span></div></li></ul>
      ${partner ? '' : `<form id="sync-invite-form"><div class="fields" style="margin-top:10px"><div class="field"><label for="sync-invite">Invite ${esc(S()[other])} by email</label><input id="sync-invite" type="email" autocomplete="off" value="${esc(inv ? inv.email : '')}" placeholder="name@example.com"></div></div>
        <div class="row"><button class="btn primary" type="submit" ${dis}>${inv ? 'Update invite' : 'Invite'}</button></div><p class="small muted">They open this app, sign in with that email in Settings, and join automatically.</p></form>`}${err}
      <p class="small muted">Only the two of you can open this household. Each of you signs and approves only as yourself; the server checks it.</p>
      <div class="row"><button class="btn" data-action="sync-now">Sync now</button><button class="btn" data-action="sync-signout">Sign out on this phone</button>${backup ? '<button class="btn sm" data-action="sync-restore">Restore this phone\'s earlier data</button>' : ''}</div>`;
  }
  const card = () => `<div class="card" id="sync-card" style="margin-bottom:16px"><h2>Sync between phones</h2><div id="sync-body">${cardBody()}</div></div>`;
  function refreshCard() {
    const el = document.getElementById('sync-body'); if (!el) return;
    const f = document.activeElement, id = f && f.id, val = f && f.value;
    el.innerHTML = cardBody();
    if (id && id.startsWith('sync-')) { const n = document.getElementById(id); if (n) { if (val != null && !n.value) n.value = val; n.focus(); } }
  }
  const baseSettings3 = VIEWS.settings;
  VIEWS.settings = () => {
    let html = baseSettings3();
    if (M.hid) html = html.replace('Everything stays in this browser. Nothing is sent anywhere. To share with your partner, export and send the file, or import theirs.', 'This phone keeps a full copy and syncs it with your household on Supabase. Only the two of you can read it. Export still makes a full backup file.');
    const i = html.indexOf('<div class="cols">');
    return i < 0 ? html + card() : html.slice(0, i) + card() + html.slice(i);
  };
  // the device owner is fixed by the sign-in
  document.addEventListener('change', e => { if (M.hid && e.target.matches && e.target.matches('[data-setting="me"]')) { e.target.value = M.slot; S().me = M.slot; toast('This phone belongs to whoever is signed in.'); } }, true);

  /* ---------- the Supabase connection ---------- */
  function supabaseBackend() {
    const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'hfh-auth' } });
    const out = r => { if (r.error) throw new Error(r.error.message); return r.data; };
    const toUser = s => s && s.user ? { uid: s.user.id, email: s.user.email } : null;
    return {
      async session() { return toUser(out(await sb.auth.getSession()).session); },
      onAuth(cb) { sb.auth.onAuthStateChange((ev, s) => cb(ev, toUser(s))); },
      async sendCode(email) { out(await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } })); },
      async verify(email, token) { return toUser(out(await sb.auth.verifyOtp({ email, token, type: 'email' })).session); },
      async signOut() { await sb.auth.signOut({ scope: 'local' }); },
      async membership() { const u = toUser(out(await sb.auth.getSession()).session); if (!u) return null; return out(await sb.from('hub_members').select('household_id,slot,email').eq('user_id', u.uid).order('joined_at').limit(1))[0] || null; },
      async members(h) { return out(await sb.from('hub_members').select('slot,email').eq('household_id', h)); },
      async invites(h) { return out(await sb.from('hub_invites').select('slot,email').eq('household_id', h)); },
      async create(slot, name) { return out(await sb.rpc('hub_create_household', { p_slot: slot, p_name: name })); },
      async invite(h, email) { return out(await sb.rpc('hub_invite', { h, p_email: email })); },
      async accept() { return out(await sb.rpc('hub_accept_invite')); },
      async push(h, rows) { return out(await sb.rpc('hub_push', { h, rows })); },
      async pull(h, since, a, b) { return out(await sb.from('hub_records').select('key,data,deleted,edited_at,updated_at').eq('household_id', h).gt('updated_at', since).order('updated_at').range(a, b)); },
      subscribe(h, cb) { const ch = sb.channel('hub-' + h).on('postgres_changes', { event: '*', schema: 'public', table: 'hub_records', filter: 'household_id=eq.' + h }, cb).subscribe(); return () => sb.removeChannel(ch); },
    };
  }

  async function boot(backend) {
    B = backend;
    try { user = await B.session(); } catch (e) { user = null; }
    if (B.onAuth) B.onAuth((ev, u) => {
      if (ev === 'SIGNED_IN' && u && !user) { user = u; connect(); }
      else if (ev === 'TOKEN_REFRESHED' && u) user = u;
      else if (ev === 'SIGNED_OUT') { user = null; stop(); refreshCard(); }
    });
    if (user) connect(); else refreshCard();
  }
  window.addEventListener('online', () => { if (!B) init(); else syncNow(); });
  window.addEventListener('offline', refreshCard);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && M.hid) syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible' && M.hid && ready()) syncNow(); }, 60000);

  let loading = false;
  function init() {
    if (CFG.test && window.HUB_TEST_BACKEND) return boot(window.HUB_TEST_BACKEND);
    if (!CFG.url || !CFG.key || loading) return;
    if (window.supabase && window.supabase.createClient) return boot(supabaseBackend());
    loading = true;
    const s = document.createElement('script'); s.src = LIB; s.crossOrigin = 'anonymous';
    s.onload = () => { loading = false; boot(supabaseBackend()); };
    s.onerror = () => { loading = false; refreshCard(); };
    document.head.appendChild(s);
  }
  window.hubSync = { get meta() { return M; }, get queue() { return Q; }, syncNow, canon, toMap };
  if (typeof route !== 'undefined' && route === 'settings') render();   // the first screen was drawn before this file loaded
  init();
})();
