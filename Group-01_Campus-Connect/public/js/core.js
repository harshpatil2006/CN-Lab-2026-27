/* Campus Connect: shared code (helpers, API calls, live connection, login, page frame). */
(function () {
  'use strict';
  const CC = (window.CC = { pages: {}, cleanup: null });
  const S = (CC.S = {
    me: null, config: { maxUploadMb: 20, allowedExtensions: [] }, users: new Map(), totalStudents: 0, onlineCount: 0,
    convs: [], msgs: new Map(), activeCid: null, route: { name: '', param: null }, conn: 'wait', connText: 'Connecting', transport: '', rtt: null, typing: new Map(),
  });

  // ---------- tiny helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  Object.assign(CC, { $, $$, esc });

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    network: '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2v4.3M12 11.5l-5.7 5.6M12 11.5l5.7 5.6"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    clip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10 18a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5"/>',
    download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
    upload: '<path d="M12 16V5"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M18 14.8c2 .6 3.4 2.3 3.4 4.7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    signal: '<path d="M4 18a11 11 0 0 1 0-12M8 15a6.5 6.5 0 0 1 0-6M12 12h.01M16 9a6.5 6.5 0 0 1 0 6M20 6a11 11 0 0 1 0 12"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5.5-5.5L6 20"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  };
  const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  const LOGO = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="11" fill="#2F6DF6"/><circle cx="12" cy="20" r="3.4" fill="#fff"/><circle cx="28" cy="12" r="3.4" fill="#fff" opacity=".9"/><circle cx="28" cy="28" r="3.4" fill="#fff" opacity=".9"/><path d="M12 20L28 12M12 20L28 28" stroke="#fff" stroke-width="2" opacity=".7" stroke-linecap="round"/></svg>';
  Object.assign(CC, { icon, LOGO });

  const AV_COLORS = ['#3b6fe0', '#1f9d8a', '#7a5af0', '#c0562b', '#b0488e', '#2f8f4e', '#3a86a8'];
  function avatar(name, id, online, cls = '') {
    const parts = String(name || '?').trim().split(/\s+/);
    const ini = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    return `<span class="av ${cls}" style="background:${AV_COLORS[Math.abs(Number(id) || 0) % AV_COLORS.length]}" aria-hidden="true">${esc(ini)}${online ? '<i class="on"></i>' : ''}</span>`;
  }
  const groupAvatar = (cls = '') => `<span class="av grp ${cls}" aria-hidden="true">${icon('users')}</span>`;
  Object.assign(CC, { avatar, groupAvatar });

  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function fmtShort(ts) {
    const d = new Date(ts), n = new Date();
    if (same(d, n)) return fmtTime(ts);
    if (same(d, new Date(n.getTime() - 86400000))) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function dayLabel(ts) {
    const d = new Date(ts), n = new Date();
    if (same(d, n)) return 'Today';
    if (same(d, new Date(n.getTime() - 86400000))) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }
  const extOf = (n) => (String(n).includes('.') ? String(n).split('.').pop().toLowerCase() : '');
  Object.assign(CC, { fmtTime, fmtShort, dayLabel, ago, fmtBytes, fmtDur, extOf });

  // ---------- small event bus so pages can listen to live updates ----------
  const subs = {};
  CC.on = (evt, fn) => { (subs[evt] = subs[evt] || new Set()).add(fn); return () => subs[evt].delete(fn); };
  CC.emit = (evt, data) => { (subs[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); };

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  CC.toast = toast;

  function modal(html) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    const first = $('input,select,button', scrim); if (first) first.focus();
    return { el: scrim.firstElementChild, close };
  }
  CC.modal = modal;

  // ---------- talking to the server (HTTP) ----------
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(path, init); } catch (_) { throw Object.assign(new Error('Cannot reach the server. Check your internet connection.'), { network: true }); }
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      if (res.status === 401 && !opts.quiet401) { CC.showAuth(); }
      throw Object.assign(new Error((data && data.error) || 'Something went wrong.'), { status: res.status, errors: data && data.errors });
    }
    return data;
  }
  CC.api = api;

  // Upload one file over HTTP so we can show real progress.
  CC.upload = (cid, file, caption, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/conversations/${cid}/files`);
    const fd = new FormData();
    fd.append('caption', caption || '');
    fd.append('file', file);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || (xhr.status === 413 ? 'That file is too large.' : 'The upload failed.')));
    };
    xhr.onerror = () => reject(new Error('The connection dropped during the upload. Check your network and try again.'));
    xhr.send(fd);
  });

  CC.checkFile = (file) => {
    if (!file) return 'Choose a file first.';
    if (file.size === 0) return 'That file is empty.';
    if (file.size > S.config.maxUploadMb * 1048576) return `That file is ${fmtBytes(file.size)}. The limit is ${S.config.maxUploadMb} MB.`;
    if (S.config.allowedExtensions.length && !S.config.allowedExtensions.includes(extOf(file.name))) return 'This file type is not allowed. Use a PDF, image, Office or text document, code file, or ZIP.';
    return null;
  };

  // ---------- data kept in the browser while you use the app ----------
  CC.loadUsers = async () => {
    const d = await api('/api/users');
    S.users = new Map(d.users.map((u) => [u.id, u]));
    S.totalStudents = d.totalStudents; S.onlineCount = d.onlineCount;
  };
  CC.loadConvs = async () => {
    const d = await api('/api/conversations');
    S.convs = d.conversations;
    updateBadges();
    CC.emit('convs');
  };
  CC.convTitle = (c) => c.name;
  CC.findConv = (id) => S.convs.find((c) => c.id === id);
  function updateBadges() {
    const n = S.convs.reduce((a, c) => a + c.unread, 0);
    const b = $('#navBadge');
    if (b) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = n === 0; }
    document.title = n ? `(${n}) Campus Connect` : 'Campus Connect';
  }
  CC.updateBadges = updateBadges;

  // ---------- the live connection (Socket.IO) ----------
  let pingTimer = null, wasDown = false;
  function setConn(state, text) {
    S.conn = state; S.connText = text;
    const p = $('#connPill');
    if (p) {
      p.className = `pill ${state}`;
      p.innerHTML = `<span class="led"></span><span class="lbl">${esc(text)}</span>${S.rtt != null && state === 'ok' ? `<span class="num">${S.rtt} ms</span>` : ''}`;
    }
    CC.emit('conn');
  }
  const transportLabel = (t) => (t === 'websocket' ? 'WebSocket' : t ? 'HTTP long-polling' : '');
  function refreshPill() { if (S.conn === 'ok') setConn('ok', `Connected · ${transportLabel(S.transport)}`); }

  function startSocket() {
    if (CC.socket) return;
    wasDown = false;
    const s = (CC.socket = io({ reconnectionDelayMax: 5000 }));
    const bindTransport = () => {
      const eng = s.io.engine;
      S.transport = eng.transport.name;
      eng.on('upgrade', (t) => { S.transport = t.name; refreshPill(); });
    };
    s.on('connect', async () => {
      bindTransport();
      setConn('ok', `Connected · ${transportLabel(S.transport)}`);
      if (wasDown) {
        toast('Back online. Catching up on anything you missed.', 'ok');
        wasDown = false;
        try { await Promise.all([CC.loadUsers(), CC.loadConvs()]); CC.emit('resync'); } catch (_) { /* shown by api() */ }
      }
      clearInterval(pingTimer);
      const ping = () => {
        const t0 = performance.now();
        s.timeout(3000).emit('net:ping', (err) => { if (err) return; S.rtt = Math.round(performance.now() - t0); S.conn === 'ok' && refreshPill(); });
      };
      ping();
      pingTimer = setInterval(ping, 4000);
    });
    s.on('disconnect', (reason) => {
      if (CC.socket !== s) return;
      wasDown = true; S.rtt = null;
      clearInterval(pingTimer);
      if (reason === 'io server disconnect') { setConn('bad', 'Signed out'); api('/api/me', { quiet401: true }).then((d) => { if (d.user) s.connect(); else CC.showAuth(); }).catch(() => CC.showAuth()); }
      else setConn('wait', 'Connection lost. Reconnecting');
    });
    s.on('connect_error', (err) => {
      if (CC.socket !== s) return;
      wasDown = true;
      if (err && err.message === 'unauthorized') { CC.showAuth(); return; }
      setConn('wait', 'Cannot reach the server. Retrying');
    });
    s.io.on('reconnect_attempt', (n) => setConn('wait', `Reconnecting (try ${n})`));
    s.on('net:probe', (cb) => { if (typeof cb === 'function') cb(); });

    s.on('presence', (p) => {
      const u = S.users.get(p.userId);
      if (u) { u.online = p.online; if (p.lastSeen) u.lastSeen = p.lastSeen; }
      S.onlineCount = p.onlineCount;
      for (const c of S.convs) for (const m of c.members) if (m.id === p.userId) m.online = p.online;
      CC.emit('presence', p);
    });
    s.on('user:new', (d) => { if (d.user.id !== S.me.id) S.users.set(d.user.id, d.user); S.totalStudents = d.totalStudents; CC.emit('users'); });
    s.on('conversation:new', () => { CC.loadConvs().catch(() => {}); });
    s.on('conversation:read', (d) => { const c = CC.findConv(d.conversationId); if (c) { c.unread = 0; updateBadges(); CC.emit('convs'); } });
    s.on('message:new', (m) => CC.onNewMessage(m));
    s.on('typing', (t) => {
      const prev = S.typing.get(t.conversationId); if (prev) clearTimeout(prev.timer);
      if (t.typing) S.typing.set(t.conversationId, { name: t.name, timer: setTimeout(() => { S.typing.delete(t.conversationId); CC.emit('typing', t.conversationId); }, 3500) });
      else S.typing.delete(t.conversationId);
      CC.emit('typing', t.conversationId);
    });
    s.on('activity:new', (a) => CC.emit('activity', a));
    s.on('monitor:snapshot', (snap) => CC.emit('monitor', snap));
    s.on('monitor:pulse', (p) => CC.emit('pulse', p));
  }

  CC.onNewMessage = async (m) => {
    let conv = CC.findConv(m.conversationId);
    if (!conv) { try { await CC.loadConvs(); } catch (_) { return; } conv = CC.findConv(m.conversationId); if (!conv) return; }
    const cache = S.msgs.get(m.conversationId);
    if (cache && !cache.items.some((x) => x.id === m.id)) cache.items.push(m);
    conv.last = { id: m.id, text: m.file ? `File: ${m.file.name}` : m.body, senderId: m.sender.id, createdAt: m.createdAt };
    S.convs.sort((a, b) => (b.last ? b.last.createdAt : b.createdAt) - (a.last ? a.last.createdAt : a.createdAt));
    const mine = m.sender.id === S.me.id;
    const viewing = S.route.name === 'chats' && S.activeCid === m.conversationId && document.visibilityState === 'visible';
    if (mine) conv.unread = 0;
    else if (viewing) { conv.unread = 0; CC.socket.emit('conversation:read', { conversationId: m.conversationId, upTo: m.id }); }
    else { conv.unread += 1; toast(`${m.sender.displayName}: ${m.file ? `sent ${m.file.name}` : m.body.slice(0, 80)}`); }
    updateBadges();
    CC.emit('message', m);
    CC.emit('convs');
  };

  // ---------- login and sign-up screen ----------
  function showAuth(mode = 'login') {
    if (CC.socket) { CC.socket.disconnect(); CC.socket = null; }
    clearInterval(pingTimer);
    if (CC.cleanup) { CC.cleanup(); CC.cleanup = null; }
    S.me = null; S.convs = []; S.msgs = new Map(); S.users = new Map(); S.rtt = null; S.conn = 'wait';
    document.title = 'Campus Connect';
    $('#root').innerHTML = `
      <div class="auth">
        <section class="auth-art">
          <div>
            <div class="brand">${LOGO}<span>Campus Connect</span></div>
            <h1>Connect. Chat. Share.</h1>
            <p class="lead">Find your classmates, talk in real time and send notes, slides and assignments without leaving campus.</p>
            <div class="path" aria-hidden="true">
              <div class="node"><span class="dot">${icon('users')}</span>You</div><span class="link run"></span>
              <div class="node srv"><span class="dot">${icon('network')}</span>Campus Connect</div><span class="link run"></span>
              <div class="node"><span class="dot">${icon('users')}</span>Classmate</div>
            </div>
            <ul class="auth-points">
              <li>Chat one to one or in groups, with unread counts and typing hints</li>
              <li>Send files that only the people in the chat can download</li>
              <li>Watch the live connection numbers on the Network page</li>
            </ul>
          </div>
          <p class="auth-note">Built for a Computer Networks project. Use a demo account only and never your real college password.</p>
        </section>
        <section class="auth-form">
          <div class="auth-card">
            <h2 id="authTitle"></h2>
            <p class="muted" id="authSub"></p>
            <div class="tabs" role="tablist"><button type="button" data-mode="login" role="tab">Sign in</button><button type="button" data-mode="register" role="tab">Create account</button></div>
            <form id="authForm" novalidate></form>
            <div class="callout">${icon('bell')}<span>Demo accounts only. Pick a new password that you do not use anywhere else.</span></div>
          </div>
        </section>
      </div>`;
    const render = (m) => {
      const reg = m === 'register';
      $('#authTitle').textContent = reg ? 'Create your account' : 'Welcome back';
      $('#authSub').textContent = reg ? 'It takes a few seconds.' : 'Sign in to see your chats and files.';
      $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      $('#authForm').innerHTML = `
        ${reg ? '<div class="field"><label for="fName">Full name</label><input class="input" id="fName" autocomplete="name" maxlength="50"><div class="err" data-for="displayName"></div></div>' : ''}
        <div class="field"><label for="fUser">Username</label><input class="input" id="fUser" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" ${reg ? 'placeholder="letters, numbers, dots, underscores"' : ''}><div class="err" data-for="username"></div></div>
        <div class="field"><label for="fPass">Password</label><input class="input" id="fPass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" ${reg ? 'placeholder="at least 8 characters"' : ''}><div class="err" data-for="password"></div></div>
        <div class="err" id="formErr" role="alert" style="margin-bottom:10px"></div>
        <button class="btn primary" style="width:100%;min-height:46px" id="authGo">${reg ? 'Create account' : 'Sign in'}</button>`;
      $('#fUser').focus();
    };
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => render(b.dataset.mode)));
    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const reg = $('.tabs .on').dataset.mode === 'register';
      $$('.err').forEach((x) => { x.textContent = ''; });
      $$('.input').forEach((x) => x.classList.remove('bad'));
      const btn = $('#authGo'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const body = { username: $('#fUser').value, password: $('#fPass').value };
        if (reg) body.displayName = $('#fName').value;
        const d = await api(reg ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body, quiet401: true });
        await CC.start(d.user);
      } catch (err) {
        btn.disabled = false; btn.textContent = reg ? 'Create account' : 'Sign in';
        $('#formErr').textContent = err.errors ? '' : err.message;
        if (err.errors) for (const [k, v] of Object.entries(err.errors)) { const el = $(`.err[data-for="${k}"]`); if (el) el.textContent = v; }
      }
    });
    render(mode);
  }
  CC.showAuth = showAuth;

  // ---------- page frame after sign-in ----------
  const NAV = [['dashboard', 'Dashboard', 'home'], ['chats', 'Chats', 'chat'], ['files', 'Files', 'file'], ['network', 'Network', 'network'], ['activity', 'Activity', 'activity']];

  function buildShell() {
    $('#root').innerHTML = `
      <div class="shell">
        <aside class="rail">
          <div class="brand">${LOGO}<span>Campus Connect</span></div>
          <nav class="nav" aria-label="Main">
            ${NAV.map(([k, label, ic]) => `<a href="#/${k}" data-nav="${k}">${icon(ic)}<span>${label}</span>${k === 'chats' ? '<span class="badge" id="navBadge" hidden>0</span>' : ''}</a>`).join('')}
          </nav>
          <div class="me">${avatar(S.me.displayName, S.me.id, true, 'sm')}<div class="who"><b>${esc(S.me.displayName)}</b><span class="muted small">@${esc(S.me.username)}</span></div>
            <button class="btn icon ghost" id="logoutBtn" title="Sign out" aria-label="Sign out">${icon('logout')}</button></div>
        </aside>
        <div class="main">
          <header class="top">
            <div class="search"><label class="sr" for="gsearch">Search</label>${icon('search')}<input class="input" id="gsearch" placeholder="Search students, chats, files and messages" autocomplete="off"><div class="results" id="results" hidden></div></div>
            <div class="pill wait" id="connPill"><span class="led"></span><span class="lbl">Connecting</span></div>
            <button class="btn icon ghost" id="logoutBtn2" title="Sign out" aria-label="Sign out" style="display:none">${icon('logout')}</button>
          </header>
          <main id="view" tabindex="-1"></main>
        </div>
      </div>`;
    const out = async () => { try { await api('/api/auth/logout', { method: 'POST', quiet401: true }); } catch (_) { /* ignore */ } showAuth(); };
    $('#logoutBtn').addEventListener('click', out);
    wireSearch();
    if (matchMedia('(max-width: 860px)').matches) { const b = $('#logoutBtn2'); b.style.display = ''; b.addEventListener('click', out); }
  }

  function wireSearch() {
    const input = $('#gsearch'), box = $('#results');
    let timer = null, seq = 0;
    const hide = () => { box.hidden = true; };
    document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hide(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); input.blur(); } });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const term = input.value.trim();
      if (term.length < 2) return hide();
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const r = await api(`/api/search?q=${encodeURIComponent(term)}`);
          if (my !== seq) return;
          const sec = (title, items) => (items.length ? `<h4>${title}</h4>${items.join('')}` : '');
          const html = [
            sec('Students', r.users.map((u) => `<button data-u="${u.id}">${avatar(u.displayName, u.id, u.online, 'sm')}<span><b>${esc(u.displayName)}</b><br><span class="muted small">@${esc(u.username)}</span></span></button>`)),
            sec('Chats', r.conversations.map((c) => `<button data-c="${c.id}">${c.kind === 'group' ? groupAvatar('sm') : avatar(c.name, c.id, false, 'sm')}<span>${esc(c.name)}</span></button>`)),
            sec('Files', r.files.map((f) => `<button data-f="${f.id}">${`<span class="fileico" style="width:30px;height:30px">${icon('file')}</span>`}<span>${esc(f.name)}<br><span class="muted small">${fmtBytes(f.size)}</span></span></button>`)),
            sec('Messages', r.messages.map((m) => `<button data-c="${m.conversationId}"><span>${esc(m.body.slice(0, 90))}<br><span class="muted small">${esc(m.senderName)} · ${fmtShort(m.createdAt)}</span></span></button>`)),
          ].join('');
          box.innerHTML = html || '<div class="empty"><b>No matches</b>Try a different name or word.</div>';
          box.hidden = false;
        } catch (_) { /* api() already reported */ }
      }, 250);
    });
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      hide(); input.value = '';
      if (b.dataset.u) await CC.openDirect(Number(b.dataset.u));
      else if (b.dataset.c) location.hash = `#/chats/${b.dataset.c}`;
      else if (b.dataset.f) location.href = `/api/files/${b.dataset.f}`;
    });
  }

  CC.openDirect = async (userId) => {
    try {
      const d = await api('/api/conversations', { method: 'POST', body: { kind: 'direct', userId } });
      if (!CC.findConv(d.conversation.id)) await CC.loadConvs();
      location.hash = `#/chats/${d.conversation.id}`;
    } catch (err) { toast(err.message, 'bad'); }
  };

  // ---------- simple router (the part after # decides the page) ----------
  function route() {
    if (!S.me) return;
    const [, name = 'dashboard', param] = location.hash.split('/');
    const page = CC.pages[name] ? name : 'dashboard';
    S.route = { name: page, param: param ? Number(param) : null };
    $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === page));
    if (CC.cleanup) { try { CC.cleanup(); } catch (_) { /* ignore */ } CC.cleanup = null; }
    const view = $('#view');
    view.className = page === 'chats' ? 'flush' : '';
    view.scrollTop = 0;
    CC.cleanup = CC.pages[page](view, S.route.param) || null;
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.route.name === 'chats' && S.activeCid && CC.socket) {
      const c = CC.findConv(S.activeCid);
      if (c && c.unread) { c.unread = 0; CC.socket.emit('conversation:read', { conversationId: c.id }); updateBadges(); CC.emit('convs'); }
    }
  });

  CC.start = async (user) => {
    S.me = user;
    let cfg = null;
    try { cfg = await api('/api/me', { quiet401: true }); } catch (_) { /* keep defaults */ }
    if (cfg) S.config = cfg.config;
    buildShell();
    await Promise.all([CC.loadUsers().catch(() => {}), CC.loadConvs().catch(() => {})]);
    startSocket();
    if (!location.hash || location.hash === '#') location.hash = '#/dashboard';
    route();
  };

  async function boot() {
    try {
      const d = await api('/api/me', { quiet401: true });
      S.config = d.config;
      if (d.user) await CC.start(d.user); else showAuth('login');
    } catch (_) { showAuth('login'); }
  }
  CC.boot = boot;
})();
