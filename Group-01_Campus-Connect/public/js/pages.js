/* Campus Connect: the pages (dashboard, chats, files, network monitor, activity). */
(function () {
  'use strict';
  const { S, $, $$, esc, icon, avatar, groupAvatar, api, toast, fmtTime, fmtShort, dayLabel, ago, fmtBytes, fmtDur, extOf } = CC;
  const AV = ['#3b6fe0', '#1f9d8a', '#7a5af0', '#c0562b', '#b0488e', '#2f8f4e', '#3a86a8'];
  const avColor = (id) => AV[Math.abs(Number(id) || 0) % AV.length];
  const firstName = (n) => String(n || '').split(' ')[0];
  const fileIcon = (name) => icon(['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extOf(name)) ? 'image' : 'file');
  const errBox = (msg) => `<div class="panel"><div class="empty"><b>Could not load this page</b>${esc(msg)}<br><br><button class="btn sm" onclick="location.reload()">Try again</button></div></div>`;
  const skeleton = (n = 4) => `<div class="panel" style="display:grid;gap:14px">${'<div class="skeleton"></div>'.repeat(n)}</div>`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const statusOf = (u) => (u.online ? 'Online' : u.lastSeen ? `Last seen ${ago(u.lastSeen)}` : 'Offline');

  // ======================================================= Dashboard
  CC.pages.dashboard = (view) => {
    let alive = true;
    view.innerHTML = skeleton(6);
    async function load() {
      try {
        const d = await api('/api/dashboard');
        if (!alive) return;
        const h = new Date().getHours();
        const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        view.innerHTML = `
          <div class="page-head"><div><h1>${hello}, ${esc(firstName(S.me.displayName))}</h1><p>Here is what is happening on campus right now.</p></div></div>
          <div class="grid" style="gap:18px">
            <div class="cta"><div><h2>Share a file with a classmate</h2><p>Send PDFs, slides, images and ZIP files up to ${S.config.maxUploadMb} MB. Only the people in the chat can download them.</p></div>
              <a class="btn" href="#/files">${icon('upload')} Send a file</a></div>
            <div class="grid g3">
              <div class="stat"><div class="k">${icon('users')} Students registered</div><div class="v num" id="dStudents">${d.totalStudents}</div><div class="s">Everyone who has an account</div></div>
              <div class="stat"><div class="k"><span class="led" style="background:var(--green)"></span> Online now</div><div class="v num" id="dOnline">${d.onlineCount}</div><div class="s">Connected to the live channel</div></div>
              <div class="stat"><div class="k">${icon('chat')} Unread messages</div><div class="v num" id="dUnread">${d.unread}</div><div class="s">${d.unread ? 'Waiting in your chats' : 'You are all caught up'}</div></div>
            </div>
            <div class="grid g2">
              <section class="panel"><div class="head"><h2>Recent conversations</h2><a class="small" href="#/chats">Open chats</a></div>
                <div class="list">${d.conversations.length ? d.conversations.map((c) => `
                  <button class="row" data-conv="${c.id}">${c.kind === 'group' ? groupAvatar() : avatar(c.name, c.peer ? c.peer.id : c.id, c.peer && c.peer.online)}
                    <span class="grow"><span class="t" style="display:block">${esc(c.name)}</span><span class="d" style="display:block">${c.last ? esc(c.last.text || '') : 'No messages yet'}</span></span>
                    ${c.unread ? `<span class="badge">${c.unread}</span>` : `<span class="muted small">${c.last ? fmtShort(c.last.createdAt) : ''}</span>`}</button>`).join('')
                  : `<div class="empty"><b>No conversations yet</b>Search for a classmate above, or open Chats to start one.</div>`}</div></section>
              <section class="panel"><div class="head"><h2>Recent shared files</h2><a class="small" href="#/files">All files</a></div>
                <div class="list">${d.files.length ? d.files.map((f) => `
                  <div class="row"><span class="fileico">${fileIcon(f.name)}</span><span class="grow"><span class="t" style="display:block">${esc(f.name)}</span>
                    <span class="d" style="display:block">${f.sentByMe ? 'Sent by you' : `From ${esc(f.uploaderName)}`} · ${fmtBytes(f.size)} · ${fmtShort(f.createdAt)}</span></span>
                    <a class="btn sm icon ghost" href="/api/files/${f.id}" title="Download ${esc(f.name)}" aria-label="Download ${esc(f.name)}">${icon('download')}</a></div>`).join('')
                  : `<div class="empty"><b>Nothing shared yet</b>Files you send or receive show up here.</div>`}</div></section>
            </div>
            <div class="grid g2">
              <section class="panel"><div class="head"><h2>Latest activity</h2><a class="small" href="#/activity">See all</a></div>
                <div>${d.activity.length ? d.activity.map(CC.evtHTML).join('') : '<div class="empty">No activity yet.</div>'}</div></section>
              <section class="panel"><div class="head"><h2>Your connection</h2><a class="small" href="#/network">Network monitor</a></div>
                <div class="list" id="dConn"></div></section>
            </div>
          </div>`;
        $$('[data-conv]', view).forEach((b) => b.addEventListener('click', () => { location.hash = `#/chats/${b.dataset.conv}`; }));
        paintConn();
      } catch (err) { if (alive) view.innerHTML = errBox(err.message); }
    }
    function paintConn() {
      const el = $('#dConn'); if (!el) return;
      const label = { ok: 'Connected', wait: 'Reconnecting', bad: 'Disconnected' }[S.conn] || S.connText;
      el.innerHTML = `
        <div class="row"><span class="grow t">Status</span><span class="tag ${S.conn === 'ok' ? 'in' : ''}">${esc(label)}</span></div>
        <div class="row"><span class="grow t">Transport</span><span class="muted">${S.conn !== 'ok' ? 'Not connected' : S.transport === 'websocket' ? 'WebSocket over TCP' : S.transport ? 'HTTP long-polling' : 'Not connected'}</span></div>
        <div class="row"><span class="grow t">Round-trip time</span><span class="muted num">${S.rtt != null ? `${S.rtt} ms` : 'Measuring'}</span></div>`;
    }
    const refresh = debounce(load, 500);
    const offs = [CC.on('presence', () => { const a = $('#dOnline'); if (a) a.textContent = S.onlineCount; }), CC.on('users', () => { const a = $('#dStudents'); if (a) a.textContent = S.totalStudents; }),
      CC.on('message', refresh), CC.on('conn', paintConn), CC.on('activity', refresh)];
    load();
    return () => { alive = false; offs.forEach((f) => f()); };
  };

  // ======================================================= Chats
  CC.pages.chats = (view, cidParam) => {
    let alive = true, pending = null, uploading = false, typingSent = 0, typingTimer = null, filter = '';
    S.activeCid = null;
    view.innerHTML = `
      <div class="chat ${cidParam ? 'open' : ''}" id="chatRoot">
        <section class="convs">
          <div class="head"><div class="line"><h2>Chats</h2><span style="display:flex;gap:8px">
            <button class="btn sm icon ghost" id="newDirect" title="New chat" aria-label="New chat">${icon('plus')}</button>
            <button class="btn sm icon ghost" id="newGroup" title="New group" aria-label="New group">${icon('users')}</button></span></div>
            <div class="search" style="max-width:none"><label class="sr" for="cfilter">Filter chats</label>${icon('search')}<input class="input" id="cfilter" placeholder="Filter chats" autocomplete="off" style="min-height:40px"></div></div>
          <div class="scroll" id="clist"></div>
        </section>
        <section class="thread" id="thread"></section>
      </div>`;

    function renderList() {
      const list = $('#clist'); if (!list) return;
      const items = S.convs.filter((c) => c.name.toLowerCase().includes(filter));
      if (!items.length) {
        list.innerHTML = S.convs.length ? '<div class="empty"><b>No chats match</b>Try another name.</div>'
          : '<div class="empty"><b>No chats yet</b>Start one with a classmate.<br><br><button class="btn primary sm" id="emptyNew">Start a chat</button></div>';
        const b = $('#emptyNew'); if (b) b.addEventListener('click', pickStudent);
        return;
      }
      list.innerHTML = items.map((c) => `
        <button class="citem ${c.id === S.activeCid ? 'on' : ''}" data-id="${c.id}">
          ${c.kind === 'group' ? groupAvatar() : avatar(c.name, c.peer ? c.peer.id : c.id, c.peer && c.peer.online)}
          <span class="grow" style="min-width:0;flex:1"><span class="name" style="display:flex"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></span>
            <span class="d muted small" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.last ? `${c.last.senderId === S.me.id ? 'You: ' : ''}${esc(c.last.text || '')}` : 'No messages yet'}</span></span>
          <span class="meta"><span>${c.last ? fmtShort(c.last.createdAt) : ''}</span>${c.unread ? `<span class="badge" aria-label="${c.unread} unread">${c.unread}</span>` : ''}</span>
        </button>`).join('');
    }

    function threadHeader(c) {
      const sub = c.kind === 'group' ? `${c.members.length} members · ${c.members.filter((m) => m.online).length} online` : statusOf(c.peer);
      return `<div class="thead"><button class="btn icon ghost back" id="backBtn" aria-label="Back to chats">${icon('back')}</button>
        ${c.kind === 'group' ? groupAvatar() : avatar(c.name, c.peer.id, c.peer.online)}
        <div style="min-width:0"><div style="font-weight:620">${esc(c.name)}</div><div class="muted small" id="tsub">${esc(sub)}</div></div></div>`;
    }

    function msgsHTML(cache, c) {
      let html = '', lastDay = '', prev = null;
      if (cache.hasMore) html += '<button class="btn sm ghost" id="olderBtn" style="align-self:center;margin-bottom:8px">Load earlier messages</button>';
      for (const m of cache.items) {
        const day = dayLabel(m.createdAt);
        if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; prev = null; }
        const mine = m.sender.id === S.me.id;
        const showName = !mine && c.kind === 'group' && (!prev || prev.sender.id !== m.sender.id);
        let inner = '';
        if (m.file) {
          inner += `<div class="fcard"><span class="fileico">${fileIcon(m.file.name)}</span><div style="min-width:0;flex:1"><div class="nm">${esc(m.file.name)}</div><div class="sz">${fmtBytes(m.file.size)}</div></div>
            <a class="btn sm" href="/api/files/${m.file.id}" aria-label="Download ${esc(m.file.name)}">${icon('download')} Download</a></div>`;
          if (m.file.isImage) inner += `<img class="imgprev" src="/api/files/${m.file.id}?inline=1" alt="${esc(m.file.name)}" loading="lazy">`;
          if (m.body) inner += `<div style="margin-top:8px">${esc(m.body)}</div>`;
        } else inner = esc(m.body);
        html += `<div class="msg ${mine ? 'me' : ''}">${showName ? `<span class="who" style="color:${avColor(m.sender.id)}">${esc(m.sender.displayName)}</span>` : ''}<div class="bubble">${inner}</div><span class="time">${fmtTime(m.createdAt)}</span></div>`;
        prev = m;
      }
      if (!cache.items.length) html = '<div class="nochat" style="margin:auto"><div>' + icon('chat') + '<div><b style="color:var(--text)">Say hello</b><br>Your messages with ' + esc(c.name) + ' will show up here.</div></div></div>';
      return html;
    }

    function paintMsgs(forceBottom) {
      const c = CC.findConv(S.activeCid), box = $('#msgs'), cache = S.msgs.get(S.activeCid);
      if (!c || !box || !cache) return;
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
      box.innerHTML = msgsHTML(cache, c);
      if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
      const older = $('#olderBtn');
      if (older) older.addEventListener('click', loadOlder);
    }

    async function loadOlder() {
      const cache = S.msgs.get(S.activeCid); if (!cache || !cache.items.length) return;
      const box = $('#msgs'), prevH = box.scrollHeight;
      try {
        const d = await api(`/api/conversations/${S.activeCid}/messages?before=${cache.items[0].id}&limit=60`);
        cache.items = [...d.messages, ...cache.items]; cache.hasMore = d.hasMore;
        paintMsgs(false); box.scrollTop = box.scrollHeight - prevH;
      } catch (err) { toast(err.message, 'bad'); }
    }

    async function openConversation(id) {
      let c = CC.findConv(id);
      if (!c) { try { await CC.loadConvs(); } catch (_) { /* reported */ } c = CC.findConv(id); }
      const thread = $('#thread'); if (!thread || !alive) return;
      if (!c) { S.activeCid = null; $('#chatRoot').classList.remove('open'); return showEmptyThread(); }
      S.activeCid = id;
      $('#chatRoot').classList.add('open');
      thread.innerHTML = `${threadHeader(c)}<div class="msgs" id="msgs" aria-live="polite"><div class="skeleton" style="width:55%"></div><div class="skeleton" style="width:40%;align-self:flex-end"></div></div>
        <div class="typing" id="typing" aria-live="polite"></div>
        <div class="composer"><div id="pendingBox"></div><div class="bar">
          <button class="btn icon ghost" id="attachBtn" title="Attach a file" aria-label="Attach a file">${icon('clip')}</button>
          <input type="file" id="fileIn" hidden>
          <textarea class="input" id="msgIn" rows="1" placeholder="Write a message" aria-label="Message" maxlength="2000"></textarea>
          <button class="btn primary icon" id="sendBtn" title="Send" aria-label="Send">${icon('send')}</button></div></div>`;
      renderList();
      wireComposer(c);
      $('#backBtn').addEventListener('click', () => { location.hash = '#/chats'; });
      try {
        if (!S.msgs.has(id)) { const d = await api(`/api/conversations/${id}/messages?limit=60`); S.msgs.set(id, { items: d.messages, hasMore: d.hasMore }); }
        if (!alive || S.activeCid !== id) return;
        paintMsgs(true);
        if (c.unread) { c.unread = 0; CC.socket && CC.socket.emit('conversation:read', { conversationId: id }); CC.updateBadges(); renderList(); }
        paintTyping();
      } catch (err) { const b = $('#msgs'); if (b) b.innerHTML = `<div class="empty"><b>Could not load messages</b>${esc(err.message)}</div>`; }
    }

    function showEmptyThread() {
      $('#thread').innerHTML = `<div class="nochat">${`<div>${icon('chat')}<div style="font-size:18px;font-weight:620;color:var(--text);margin-bottom:4px">Pick a chat to start talking</div><div>Or search for a classmate at the top.</div></div>`}</div>`;
    }

    function wireComposer(c) {
      const ta = $('#msgIn'), fileIn = $('#fileIn');
      const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; };
      ta.addEventListener('input', () => {
        grow();
        const now = Date.now();
        if (CC.socket && CC.socket.connected && now - typingSent > 2000) { typingSent = now; CC.socket.emit('typing', { conversationId: c.id, typing: true }); }
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { typingSent = 0; CC.socket && CC.socket.connected && CC.socket.emit('typing', { conversationId: c.id, typing: false }); }, 2500);
      });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      $('#sendBtn').addEventListener('click', send);
      $('#attachBtn').addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', () => { if (fileIn.files[0]) setPending(fileIn.files[0]); fileIn.value = ''; });
      const thread = $('#thread');
      thread.addEventListener('dragover', (e) => { e.preventDefault(); });
      thread.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) setPending(e.dataTransfer.files[0]); });
      ta.focus();

      function setPending(f) {
        const problem = CC.checkFile(f);
        if (problem) return toast(problem, 'bad');
        pending = f; paintPending();
      }
      function paintPending(pct) {
        const box = $('#pendingBox'); if (!box) return;
        if (!pending) { box.innerHTML = ''; return; }
        box.innerHTML = `<div class="pending"><span class="fileico">${fileIcon(pending.name)}</span><div style="min-width:0;flex:1"><div style="font-weight:580;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pending.name)}</div>
          <div class="muted small">${fmtBytes(pending.size)}${uploading ? ` · sending ${Math.round((pct || 0) * 100)}%` : ' · press send to share it'}</div>
          ${uploading ? `<div class="prog" style="margin-top:6px"><i style="width:${Math.round((pct || 0) * 100)}%"></i></div>` : ''}</div>
          ${uploading ? '' : `<button class="btn sm icon ghost" id="rmPending" aria-label="Remove file">✕</button>`}</div>`;
        const rm = $('#rmPending'); if (rm) rm.addEventListener('click', () => { pending = null; paintPending(); });
      }
      async function send() {
        if (uploading) return;
        const text = ta.value.trim();
        if (pending) {
          uploading = true; paintPending(0);
          try {
            await CC.upload(c.id, pending, text, (p) => paintPending(p));
            pending = null; ta.value = ''; grow(); toast('File sent', 'ok');
          } catch (err) { toast(err.message, 'bad'); }
          uploading = false; paintPending(); return;
        }
        if (!text) return;
        if (!CC.socket || !CC.socket.connected) return toast('You are offline. Your message is still in the box; it can be sent once you reconnect.', 'bad');
        ta.value = ''; grow(); typingSent = 0; clearTimeout(typingTimer);
        CC.socket.emit('typing', { conversationId: c.id, typing: false });
        CC.socket.timeout(8000).emit('message:send', { conversationId: c.id, body: text }, (err, res) => {
          if (err || !res || !res.ok) { toast(err ? 'The message was not confirmed. Check your connection.' : res.error, 'bad'); if (!ta.value) { ta.value = text; grow(); } }
        });
      }
    }

    function paintTyping() {
      const el = $('#typing'); if (!el) return;
      const t = S.typing.get(S.activeCid);
      el.textContent = t ? `${t.name} is typing…` : '';
    }

    // new chat and group dialogs
    function studentRows(users, multi) {
      return users.length ? users.map((u) => `<label class="row" style="cursor:pointer">${multi ? `<input type="checkbox" value="${u.id}" aria-label="${esc(u.displayName)}">` : ''}
        ${avatar(u.displayName, u.id, u.online, 'sm')}<span class="grow"><span class="t" style="display:block">${esc(u.displayName)}</span><span class="d" style="display:block">@${esc(u.username)} · ${esc(statusOf(u))}</span></span>${multi ? '' : `<button class="btn sm" data-pick="${u.id}">Chat</button>`}</label>`).join('')
        : '<div class="empty"><b>No other students yet</b>Ask a classmate to create an account.</div>';
    }
    const sortedUsers = () => [...S.users.values()].sort((a, b) => (b.online - a.online) || a.displayName.localeCompare(b.displayName));
    function pickStudent() {
      const m = CC.modal(`<h2>Start a chat</h2><input class="input" id="mq" placeholder="Search by name or username" autocomplete="off"><div class="pick" id="mlist">${studentRows(sortedUsers(), false)}</div>`);
      const paint = () => {
        const term = $('#mq', m.el).value.trim().toLowerCase();
        $('#mlist', m.el).innerHTML = studentRows(sortedUsers().filter((u) => !term || u.displayName.toLowerCase().includes(term) || u.username.includes(term)), false);
      };
      $('#mq', m.el).addEventListener('input', paint);
      m.el.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) { e.preventDefault(); m.close(); CC.openDirect(Number(b.dataset.pick)); } });
    }
    function pickGroup() {
      const m = CC.modal(`<h2>New group</h2><div class="field"><label for="gname">Group name</label><input class="input" id="gname" maxlength="40" placeholder="For example: CN project team"></div>
        <div class="muted small">Add students</div><div class="pick">${studentRows(sortedUsers(), true)}</div><div class="err" id="gerr" role="alert"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn ghost" id="gcancel">Cancel</button><button class="btn primary" id="gmake">Create group</button></div>`);
      $('#gcancel', m.el).addEventListener('click', m.close);
      $('#gmake', m.el).addEventListener('click', async () => {
        const memberIds = $$('input[type=checkbox]:checked', m.el).map((x) => Number(x.value));
        try {
          const d = await api('/api/conversations', { method: 'POST', body: { kind: 'group', name: $('#gname', m.el).value, memberIds } });
          m.close(); await CC.loadConvs(); location.hash = `#/chats/${d.conversation.id}`;
        } catch (err) { $('#gerr', m.el).textContent = err.message; }
      });
    }

    $('#newDirect').addEventListener('click', pickStudent);
    $('#newGroup').addEventListener('click', pickGroup);
    $('#cfilter').addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); renderList(); });
    $('#clist').addEventListener('click', (e) => { const b = e.target.closest('.citem'); if (b) location.hash = `#/chats/${b.dataset.id}`; });

    renderList();
    if (cidParam) openConversation(cidParam); else showEmptyThread();

    const offs = [
      CC.on('convs', () => { if (alive) renderList(); }),
      CC.on('message', (m) => { if (alive && m.conversationId === S.activeCid) paintMsgs(m.sender.id === S.me.id); }),
      CC.on('presence', () => {
        if (!alive) return; renderList();
        const c = CC.findConv(S.activeCid); const t = $('#tsub');
        if (c && t) t.textContent = c.kind === 'group' ? `${c.members.length} members · ${c.members.filter((m) => m.online).length} online` : statusOf(c.peer);
      }),
      CC.on('typing', (cid) => { if (alive && cid === S.activeCid) paintTyping(); }),
      CC.on('resync', async () => {
        if (!alive || !S.activeCid) return;
        try { const d = await api(`/api/conversations/${S.activeCid}/messages?limit=60`); S.msgs.set(S.activeCid, { items: d.messages, hasMore: d.hasMore }); paintMsgs(false); } catch (_) { /* reported */ }
      }),
    ];
    return () => { alive = false; offs.forEach((f) => f()); S.activeCid = null; clearTimeout(typingTimer); };
  };

  // ======================================================= Files
  CC.pages.files = (view) => {
    let alive = true, picked = null, list = [], filter = 'all', term = '', busy = false;
    view.innerHTML = `
      <div class="page-head"><div><h1>Files</h1><p>Send study material to a classmate or a group, and find everything shared with you.</p></div></div>
      <div class="files-grid">
        <section class="panel"><div class="head"><h2>Send a file</h2></div>
          <div class="field"><label for="to">Send to</label><select class="input" id="to"></select></div>
          <div class="drop" id="drop"><div style="margin-bottom:8px">${icon('upload')}</div><div id="dropText"><b>Drag a file here</b><br>or <button class="btn sm" id="chooseBtn" type="button">Choose a file</button></div><input type="file" id="fileIn" hidden></div>
          <div class="field" style="margin-top:14px"><label for="cap">Message (optional)</label><input class="input" id="cap" maxlength="500" placeholder="For example: Unit 3 notes"></div>
          <div id="upState"></div>
          <button class="btn primary" id="goBtn" style="width:100%;min-height:46px">${icon('send')} Send file</button>
          <p class="muted small" style="margin-top:12px">PDF, images, Word, Excel, PowerPoint, text, code and ZIP files up to ${S.config.maxUploadMb} MB. Only the people in the chat can download it.</p>
        </section>
        <section class="panel"><div class="head"><h2>Shared files</h2><div style="display:flex;gap:8px;flex-wrap:wrap" id="chips">
          <button class="chip on" data-f="all">All</button><button class="chip" data-f="received">Received</button><button class="chip" data-f="sent">Sent</button></div></div>
          <div class="search" style="max-width:none;margin-bottom:12px"><label class="sr" for="ffilter">Filter files</label>${icon('search')}<input class="input" id="ffilter" placeholder="Filter by file name or student" autocomplete="off"></div>
          <div class="tablewrap" id="ftable">${'<div class="skeleton" style="margin:12px 0"></div>'.repeat(3)}</div></section>
      </div>`;

    function fillRecipients() {
      const sel = $('#to'), keep = sel.value;
      const users = [...S.users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
      const groups = S.convs.filter((c) => c.kind === 'group');
      sel.innerHTML = `<option value="">Choose who gets it</option>${users.length ? `<optgroup label="Students">${users.map((u) => `<option value="u:${u.id}">${esc(u.displayName)} (@${esc(u.username)})${u.online ? ' · online' : ''}</option>`).join('')}</optgroup>` : ''}${groups.length ? `<optgroup label="Groups">${groups.map((g) => `<option value="c:${g.id}">${esc(g.name)}</option>`).join('')}</optgroup>` : ''}`;
      if (keep) sel.value = keep;
    }
    function paintDrop() {
      $('#dropText').innerHTML = picked ? `<b>${esc(picked.name)}</b><br><span class="small">${fmtBytes(picked.size)} · <button class="btn sm ghost" id="chooseBtn" type="button">Change</button></span>`
        : '<b>Drag a file here</b><br>or <button class="btn sm" id="chooseBtn" type="button">Choose a file</button>';
      $('#chooseBtn').addEventListener('click', () => $('#fileIn').click());
    }
    function setFile(f) {
      const problem = CC.checkFile(f);
      if (problem) return toast(problem, 'bad');
      picked = f; paintDrop();
    }
    function paintTable() {
      const el = $('#ftable'); if (!el) return;
      const rows = list.filter((f) => (filter === 'all' || (filter === 'sent') === f.sentByMe) && (!term || f.name.toLowerCase().includes(term) || (f.uploaderName || '').toLowerCase().includes(term) || (f.to || '').toLowerCase().includes(term)));
      if (!rows.length) { el.innerHTML = `<div class="empty"><b>${list.length ? 'No files match' : 'No files yet'}</b>${list.length ? 'Try a different filter.' : 'Send a file on the left, or wait for a classmate to send you one.'}</div>`; return; }
      el.innerHTML = `<table class="table"><thead><tr><th>File</th><th>Shared</th><th class="hide-s">Size</th><th class="hide-s">When</th><th><span class="sr">Download</span></th></tr></thead><tbody>${rows.map((f) => `
        <tr><td><div class="nm"><span class="fileico">${fileIcon(f.name)}</span><span>${esc(f.name)}</span></div></td>
        <td><span class="tag ${f.sentByMe ? '' : 'in'}">${f.sentByMe ? 'Sent' : 'Received'}</span><div class="muted small" style="margin-top:3px">${f.sentByMe ? `You to ${esc(f.to || '')}` : `${esc(f.uploaderName)}${f.kind === 'group' ? ` in ${esc(f.to)}` : ''}`}</div></td>
        <td class="hide-s num muted">${fmtBytes(f.size)}</td><td class="hide-s muted">${fmtShort(f.createdAt)}</td>
        <td><a class="btn sm" href="/api/files/${f.id}" aria-label="Download ${esc(f.name)}">${icon('download')} Download</a></td></tr>`).join('')}</tbody></table>`;
    }
    async function loadFiles() {
      try { const d = await api('/api/files'); if (!alive) return; list = d.files; paintTable(); } catch (err) { if (alive) $('#ftable').innerHTML = `<div class="empty"><b>Could not load files</b>${esc(err.message)}</div>`; }
    }

    fillRecipients(); paintDrop(); loadFiles();
    const fileIn = $('#fileIn');
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) setFile(fileIn.files[0]); fileIn.value = ''; });
    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
    $('#chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; filter = b.dataset.f; $$('.chip', view).forEach((x) => x.classList.toggle('on', x === b)); paintTable(); });
    $('#ffilter').addEventListener('input', (e) => { term = e.target.value.trim().toLowerCase(); paintTable(); });
    $('#goBtn').addEventListener('click', async () => {
      if (busy) return;
      const to = $('#to').value;
      if (!to) return toast('Choose who should get the file.', 'bad');
      const problem = CC.checkFile(picked); if (problem) return toast(problem, 'bad');
      busy = true; const btn = $('#goBtn'); btn.disabled = true;
      const state = $('#upState');
      state.innerHTML = '<div class="pending" style="margin-bottom:14px"><div style="flex:1"><div class="small muted" id="upText">Starting upload…</div><div class="prog" style="margin-top:8px"><i id="upBar"></i></div></div></div>';
      try {
        let cid;
        if (to.startsWith('c:')) cid = Number(to.slice(2));
        else { const d = await api('/api/conversations', { method: 'POST', body: { kind: 'direct', userId: Number(to.slice(2)) } }); cid = d.conversation.id; if (!CC.findConv(cid)) await CC.loadConvs(); }
        const t0 = performance.now();
        await CC.upload(cid, picked, $('#cap').value, (p) => { const bar = $('#upBar'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; const t = $('#upText'); if (t) t.textContent = `Uploading ${Math.round(p * 100)}% · ${fmtBytes(p * picked.size)} of ${fmtBytes(picked.size)}`; });
        const secs = Math.max(0.1, (performance.now() - t0) / 1000);
        toast(`File sent (${fmtBytes(picked.size)} in ${secs.toFixed(1)} s)`, 'ok');
        picked = null; $('#cap').value = ''; paintDrop(); state.innerHTML = '';
        loadFiles();
      } catch (err) { toast(err.message, 'bad'); state.innerHTML = `<div class="err" role="alert" style="margin-bottom:12px">${esc(err.message)}</div>`; }
      busy = false; btn.disabled = false;
    });
    const offs = [CC.on('message', (m) => { if (m.file) loadFiles(); }), CC.on('convs', fillRecipients), CC.on('users', fillRecipients), CC.on('presence', fillRecipients)];
    return () => { alive = false; offs.forEach((f) => f()); };
  };

  // ======================================================= Activity (shared pieces)
  const EVT = {
    connect: ['plug', 'good'], disconnect: ['plug', 'bad'], upgrade: ['signal', ''], message: ['chat', ''], upload: ['upload', ''],
    download: ['download', ''], register: ['users', 'good'], login: ['check', ''], logout: ['logout', 'warn'],
  };
  CC.evtHTML = (a) => {
    const [ic, tone] = EVT[a.kind] || ['activity', ''];
    return `<div class="evt"><span class="ic ${tone}">${icon(ic)}</span><div style="min-width:0"><b>${esc(a.name || 'Someone')}</b> <span class="muted">${esc(a.detail)}</span></div><span class="tm num">${esc(fmtTime(a.createdAt))}</span></div>`;
  };

  CC.pages.activity = (view) => {
    let alive = true, kinds = '', items = [];
    const FILTERS = [['', 'All'], ['connect,disconnect,upgrade', 'Connections'], ['message', 'Messages'], ['upload,download', 'Files'], ['register,login,logout', 'Accounts']];
    view.innerHTML = `<div class="page-head"><div><h1>Activity</h1><p>What the server has recorded recently. Message text and file names are never shown here.</p></div></div>
      <div class="panel"><div class="head" style="flex-wrap:wrap"><div style="display:flex;gap:8px;flex-wrap:wrap" id="afilters">${FILTERS.map(([k, l], i) => `<button class="chip ${i ? '' : 'on'}" data-k="${k}">${l}</button>`).join('')}</div></div>
      <div id="alist">${'<div class="skeleton" style="margin:12px 0"></div>'.repeat(4)}</div></div>`;
    const paint = () => { const el = $('#alist'); if (el) el.innerHTML = items.length ? items.map(CC.evtHTML).join('') : '<div class="empty"><b>Nothing here yet</b>Events show up as people connect, chat and share files.</div>'; };
    async function load() {
      try { const d = await api(`/api/activity${kinds ? `?kind=${encodeURIComponent(kinds)}` : ''}`); if (!alive) return; items = d.activity; paint(); } catch (err) { if (alive) $('#alist').innerHTML = `<div class="empty"><b>Could not load activity</b>${esc(err.message)}</div>`; }
    }
    $('#afilters').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; kinds = b.dataset.k; $$('.chip', view).forEach((x) => x.classList.toggle('on', x === b)); load(); });
    load();
    const off = CC.on('activity', (a) => { if (!alive) return; if (!kinds || kinds.split(',').includes(a.kind)) { items.unshift(a); items = items.slice(0, 100); paint(); } });
    return () => { alive = false; off(); };
  };

  // ======================================================= Network monitor
  CC.pages.network = (view) => {
    let alive = true, charts = {}, events = [], snap = null, pulseTimer = null;
    view.innerHTML = `
      <div class="page-head"><div><h1>Network monitor</h1><p>Live numbers measured by this server. Nothing on this page is estimated or made up.</p></div>
        <span class="tag in" id="mLive">Live · updates every 2 seconds</span></div>
      <div class="grid" style="gap:18px">
        <div class="grid g4" id="mStats"></div>
        <section class="panel"><div class="head"><h2>How a message travels</h2><span class="muted small" id="pathNote"></span></div>
          <div class="mon-path" aria-label="Student A to server to Student B">
            <div class="node"><span class="dot">${icon('users')}</span>Student A<br><span class="small">browser</span></div><span class="link" id="lnk1"></span>
            <div class="node srv"><span class="dot">${icon('network')}</span>Campus Connect<br><span class="small">Node.js server</span></div><span class="link" id="lnk2"></span>
            <div class="node"><span class="dot">${icon('users')}</span>Student B<br><span class="small">browser</span></div></div>
          <p class="note" style="margin-top:6px">Each browser keeps one connection to the server (WebSocket over TCP when it can, HTTP long-polling when it cannot). The server passes the message on. The dashes move when real traffic passes through the server.</p></section>
        <div class="grid g2">
          <section class="panel"><div class="head"><h2>Round-trip time</h2><span class="muted small">Server probe to client and back, in ms</span></div><div class="chartbox"><canvas id="cLat" role="img" aria-label="Round-trip time in milliseconds over the last probes"></canvas></div></section>
          <section class="panel"><div class="head"><h2>Connection types</h2><span class="muted small">Right now</span></div>
            <div style="padding:16px 0 8px"><div class="split" id="mSplit"></div></div><div class="legend" id="mLegend" style="margin-bottom:18px"></div>
            <div class="list" id="mConns"></div></section>
        </div>
        <div class="grid g2">
          <section class="panel"><div class="head"><h2>Messages per minute</h2><span class="muted small">Last 15 minutes</span></div><div class="chartbox short"><canvas id="cMsg" role="img" aria-label="Messages sent per minute"></canvas></div></section>
          <section class="panel"><div class="head"><h2>Data uploaded per minute</h2><span class="muted small">Last 15 minutes</span></div><div class="chartbox short"><canvas id="cUp" role="img" aria-label="Bytes uploaded per minute"></canvas></div></section>
        </div>
        <section class="panel"><div class="head"><h2>Recent connection events</h2><a class="small" href="#/activity">All activity</a></div><div id="mEvents"></div>
          <p class="note" id="mNote"></p></section>
      </div>`;

    const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    function makeCharts() {
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      Chart.defaults.color = cssv('--muted');
      const grid = { color: 'rgba(147,164,204,0.12)', drawTicks: false }, border = { display: false };
      const tip = { backgroundColor: '#15234a', borderColor: '#22335f', borderWidth: 1, titleColor: '#e9effc', bodyColor: '#e9effc', padding: 10, displayColors: false, cornerRadius: 10 };
      const base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: tip } };
      charts.lat = new Chart($('#cLat'), { type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: cssv('--series-1'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: cssv('--series-1'), pointHoverBorderColor: '#0f1a33', pointHoverBorderWidth: 2, tension: 0.25 }] },
        options: { ...base, scales: { x: { grid: { display: false }, border, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: { beginAtZero: true, grid, border, ticks: { padding: 8, callback: (v) => `${v} ms` } } }, plugins: { ...base.plugins, tooltip: { ...tip, callbacks: { label: (c) => `${c.parsed.y} ms` } } } } });
      charts.msg = new Chart($('#cMsg'), { type: 'bar', data: { labels: [], datasets: [{ data: [], backgroundColor: cssv('--series-1'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 22 }] },
        options: { ...base, scales: { x: { grid: { display: false }, border, ticks: { maxTicksLimit: 5, maxRotation: 0 } }, y: { beginAtZero: true, grid, border, ticks: { precision: 0, padding: 8 } } }, plugins: { ...base.plugins, tooltip: { ...tip, callbacks: { label: (c) => `${c.parsed.y} message${c.parsed.y === 1 ? '' : 's'}` } } } } });
      charts.up = new Chart($('#cUp'), { type: 'bar', data: { labels: [], datasets: [{ data: [], backgroundColor: cssv('--series-1'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 22 }] },
        options: { ...base, scales: { x: { grid: { display: false }, border, ticks: { maxTicksLimit: 5, maxRotation: 0 } }, y: { beginAtZero: true, grid, border, ticks: { padding: 8, callback: (v) => fmtBytes(v) } } }, plugins: { ...base.plugins, tooltip: { ...tip, callbacks: { label: (c) => fmtBytes(c.parsed.y) } } } } });
    }
    const tm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    function paint(s) {
      snap = s;
      const a = s.sinceStart, l = s.latency, st = (k, v, sub, extra = '') => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${sub}</div>${extra}</div>`;
      $('#mStats').innerHTML = [
        st('Active connections', s.activeConnections, `${s.transports.websocket} WebSocket · ${s.transports.polling} long-polling`),
        st('Online students', s.onlineStudents, `of ${s.totalStudents} registered`),
        st('Messages sent', a.messagesSent, `${a.deliveries} copies delivered to connected clients`),
        st('Files transferred', `${a.filesUploaded} <span class="muted" style="font-size:16px">up</span> · ${a.filesDownloaded} <span class="muted" style="font-size:16px">down</span>`, 'Uploads and downloads since start'),
        st('Data uploaded', fmtBytes(a.bytesUploaded), `${fmtBytes(a.bytesDownloaded)} downloaded`),
        st('Server uptime', fmtDur(s.uptimeSec), `Healthy · ${s.storage.persistentVolume ? 'persistent volume attached' : 'no persistent volume (local disk)'}`),
        st('Latest round trip', l.last != null ? `${l.last} <span class="muted" style="font-size:16px">ms</span>` : 'Measuring', l.count ? `avg ${l.avg} · min ${l.min} · max ${l.max} · p95 ${l.p95} ms` : 'First probe is sent a moment after you connect'),
        st('HTTP requests', a.httpRequests, `avg ${a.httpAvgMs} ms on the server · ${a.http5xx} server errors`),
      ].join('');
      $('#pathNote').textContent = S.transport && S.conn === 'ok' ? `Your connection: ${S.transport === 'websocket' ? 'WebSocket over TCP' : 'HTTP long-polling'}${S.rtt != null ? `, ${S.rtt} ms round trip` : ''}` : '';
      const ws = s.transports.websocket, po = s.transports.polling, tot = ws + po;
      $('#mSplit').innerHTML = tot ? `${ws ? `<i style="flex:${ws};background:var(--series-1)"></i>` : ''}${po ? `<i style="flex:${po};background:var(--series-2)"></i>` : ''}` : '<i style="flex:1;background:var(--line)"></i>';
      $('#mLegend').innerHTML = `<span><i style="background:var(--series-1)"></i>WebSocket: ${ws}</span><span><i style="background:var(--series-2)"></i>HTTP long-polling: ${po}</span>`;
      $('#mConns').innerHTML = s.connections.length ? s.connections.map((c) => `<div class="row">${avatar(c.name, c.userId, true, 'sm')}<span class="grow"><span class="t" style="display:block">${esc(c.name)}</span><span class="d" style="display:block">${c.transport === 'websocket' ? 'WebSocket' : 'Long-polling'} · connected ${fmtDur((s.serverTime - c.since) / 1000)}</span></span><span class="num muted">${c.rtt != null ? `${c.rtt} ms` : '…'}</span></div>`).join('') : '<div class="empty">No one is connected.</div>';
      if (charts.lat) {
        charts.lat.data.labels = l.series.map((p) => tm(p.t)); charts.lat.data.datasets[0].data = l.series.map((p) => p.rtt); charts.lat.update('none');
        charts.msg.data.labels = s.perMinute.map((p) => hm(p.t)); charts.msg.data.datasets[0].data = s.perMinute.map((p) => p.messages); charts.msg.update('none');
        charts.up.data.labels = s.perMinute.map((p) => hm(p.t)); charts.up.data.datasets[0].data = s.perMinute.map((p) => p.uploadBytes); charts.up.update('none');
      }
      $('#mNote').textContent = `Counters above start from zero each time the server starts (${new Date(s.startedAt).toLocaleString()}). Stored in the database across all time: ${s.allTime.messages} messages, ${s.allTime.files} files, ${fmtBytes(s.allTime.bytesStored)}.`;
    }
    const paintEvents = () => { const el = $('#mEvents'); if (el) el.innerHTML = events.length ? events.slice(0, 12).map(CC.evtHTML).join('') : '<div class="empty">No events yet.</div>'; };

    makeCharts();
    api('/api/monitor').then((d) => { if (!alive) return; events = d.activity; paintEvents(); paint(d.snapshot); }).catch((err) => { if (alive) toast(err.message, 'bad'); });
    const subscribe = () => { if (CC.socket && CC.socket.connected) CC.socket.emit('monitor:subscribe'); };
    subscribe();
    const offs = [
      CC.on('monitor', (s) => { if (alive) paint(s); }),
      CC.on('activity', (a) => { if (!alive) return; if (['connect', 'disconnect', 'upgrade'].includes(a.kind)) { events.unshift(a); events = events.slice(0, 30); paintEvents(); } }),
      CC.on('pulse', () => { ['lnk1', 'lnk2'].forEach((id) => { const e = $('#' + id); if (e) e.classList.add('run'); }); clearTimeout(pulseTimer); pulseTimer = setTimeout(() => { ['lnk1', 'lnk2'].forEach((id) => { const e = $('#' + id); if (e) e.classList.remove('run'); }); }, 1600); }),
      CC.on('conn', () => { if (S.conn === 'ok') subscribe(); }),
    ];
    return () => {
      alive = false; offs.forEach((f) => f()); clearTimeout(pulseTimer);
      if (CC.socket && CC.socket.connected) CC.socket.emit('monitor:unsubscribe');
      Object.values(charts).forEach((c) => c.destroy());
    };
  };

  CC.boot();
})();
