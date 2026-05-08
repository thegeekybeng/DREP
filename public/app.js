'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentUser = null; // { token, role, name, userId }
let membersCache = [];
let eventsCache = [];
let pollTimer = null;

// ── Utilities ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function toast(msg, type = '') {
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' toast-' + type : '');
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token || currentUser?.token) headers['Authorization'] = 'Bearer ' + (token || currentUser.token);
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function storeSession(data) {
  sessionStorage.setItem('fdr_token', data.token);
  sessionStorage.setItem('fdr_role', data.role);
  sessionStorage.setItem('fdr_name', data.name);
  sessionStorage.setItem('fdr_userId', data.userId ?? '');
  currentUser = { token: data.token, role: data.role, name: data.name, userId: data.userId };
}

function clearSession() {
  sessionStorage.clear();
  currentUser = null;
}

function roleAtLeast(role, min) {
  const ranks = { owner: 5, admin: 4, member: 3, guest: 2, pending: 1 };
  return (ranks[role] || 0) >= (ranks[min] || 0);
}

// ── View routing ───────────────────────────────────────────────────────────
function showView(name) {
  ['login', 'pending', 'app'].forEach(v => {
    const el = $('view-' + v);
    if (el) v === name ? show(el) : hide(el);
  });
}

function enterApp() {
  showView('app');
  const role = currentUser.role;

  // User badge
  const badge = $('user-badge');
  if (role === 'guest') {
    badge.textContent = 'Family guest · read only';
    show($('guest-signin-link'));
  } else {
    badge.textContent = currentUser.name + ' · ' + role;
    hide($('guest-signin-link'));
  }

  // Tab visibility
  if (roleAtLeast(role, 'admin')) show(document.querySelector('.tab-admin'));
  else hide(document.querySelector('.tab-admin'));

  // Submission buttons
  if (roleAtLeast(role, 'member')) {
    show($('btn-add-tag'));
    show($('btn-add-event'));
  } else {
    hide($('btn-add-tag'));
    hide($('btn-add-event'));
  }

  loadAll();
  startPolling();
}

// ── Load data ──────────────────────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadMembers(), loadEvents()]);
  if (roleAtLeast(currentUser?.role, 'admin')) await loadAdminPending();
}

async function loadMembers() {
  try {
    membersCache = await api('GET', '/api/members');
    renderMembers();
  } catch (e) { /* silent on poll */ }
}

async function loadEvents() {
  try {
    eventsCache = await api('GET', '/api/events');
    renderEvents();
  } catch (e) { /* silent on poll */ }
}

async function loadAdminPending() {
  try {
    const data = await api('GET', '/api/admin/pending');
    renderAdminPending(data);
  } catch (e) { /* silent */ }
}

async function loadAdminUsers() {
  try {
    const users = await api('GET', '/api/admin/users');
    renderAdminUsers(users);
  } catch (e) { /* silent */ }
}

async function loadAdminMembers() {
  try {
    const members = await api('GET', '/api/members');
    renderAdminMembers(members);
  } catch (e) { /* silent */ }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadAll, 30000);
}

// ── Render members ─────────────────────────────────────────────────────────
let activeGenFilter = 'all';
let activeTagFilter = null; // null | 'allergy' | 'restriction'

function renderMembers() {
  const grid = $('members-grid');
  let members = membersCache;
  if (activeGenFilter !== 'all') members = members.filter(m => m.generation === parseInt(activeGenFilter));
  if (activeTagFilter) members = members.filter(m => m.tags.some(t => t.type === activeTagFilter && t.pending === 0));
  if (!members.length) {
    grid.innerHTML = '<div class="empty-state">No members to display.</div>';
    return;
  }

  grid.innerHTML = members.map(m => {
    const hasAllergy = m.tags.some(t => t.type === 'allergy');
    const isAdminPlus = currentUser && roleAtLeast(currentUser.role, 'admin');

  const tags = m.tags.map(t => {
    const isPending = t.pending === 1;
    const cls = `tag tag-${t.type}${isPending ? ' pending-tag' : ''}`;
    const dot = isPending ? '<span class="pending-dot"></span>' : '';
    const label = isPending ? ` <span style="font-size:10px">(pending)</span>` : '';
    const controls = isAdminPlus
      ? `<span class="tag-controls">
           <button class="tag-action-btn" title="Edit" onclick="openEditTag(${t.id},'${t.type}','${esc(t.value).replace(/'/g,"\\'")}')">✏️</button>
           <button class="tag-action-btn" title="Remove" onclick="deleteTag(${t.id})">🗑</button>
         </span>`
      : '';
    return `<span class="${cls}">${dot}${esc(t.value)}${label}${controls}</span>`;
  }).join('');

    return `
    <div class="member-card${hasAllergy ? ' has-allergy' : ''}" data-id="${m.id}">
      <div class="member-card-header">
        <div class="avatar avatar-${m.avatar_color}">${esc(m.initials)}</div>
        <div class="member-info">
          <div class="member-name">${esc(m.name)}</div>
          <div class="member-relation">${esc(m.relation)}</div>
        </div>
        <span class="gen-badge gen-${m.generation}">Gen ${m.generation}</span>
      </div>
      ${hasAllergy ? '<div class="allergy-flag">⚠ Allergy</div>' : ''}
      <div class="tags-wrap">${tags || '<span style="color:var(--text-muted);font-size:12px">No tags</span>'}</div>
      ${m.notes ? `<div class="member-notes">${esc(m.notes)}</div>` : ''}
      ${isAdminPlus ? `<div class="member-card-actions"><button class="btn btn-xs btn-ghost" onclick="openEditMember(${m.id})">✏️ Edit member</button></div>` : ''}
    </div>`;
  }).join('');
}

function isPastEvent(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr || '00:00'}`).getTime() < Date.now();
}

// ── Render events ──────────────────────────────────────────────────────────
function heroGradientClass(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('birthday')) return 'hero-birthday';
  if (t.includes('wedding') || t.includes('anniversary')) return 'hero-wedding';
  if (t.includes('reunion') || t.includes('family')) return 'hero-reunion';
  if (t.includes('festive') || t.includes('cny') || t.includes('lunar') || t.includes('celebration')) return 'hero-festive';
  return 'hero-default';
}

function renderEvents() {
  const list = $('events-list');
  const isAuth = !!currentUser;
  const isAdminPlus = currentUser && roleAtLeast(currentUser.role, 'admin');

  if (!isAuth) {
    if (!eventsCache.length) { list.innerHTML = '<div class="event-locked">No upcoming events.</div>'; return; }
    list.innerHTML = eventsCache.map(e =>
      `<div class="event-card"><div class="event-type">${esc(e.type)}</div><div class="event-locked" style="padding:.5rem 0 0;font-size:12px">Sign in to view event details</div></div>`
    ).join('');
    return;
  }

  const visible = eventsCache.filter(e => e.pending === 0 || roleAtLeast(currentUser.role, 'member'));
  if (!visible.length) { list.innerHTML = '<div class="event-locked">No upcoming events.</div>'; return; }

  list.innerHTML = visible.map(e => {
    const past = isPastEvent(e.event_date, e.event_time);
    const pendingBadge = e.pending ? '<span class="pending-badge">⏳ Pending approval</span>' : '';
    const pastBadge = past ? '<span class="past-badge">Completed</span>' : '';
    const shareBadge = (e.share_token || e.has_share_link) ? '<span class="share-badge">🔗 Shared</span>' : '';

    const heroBanner = e.hero_image_url
      ? `<div class="event-hero"><img src="${esc(e.hero_image_url)}" alt="${esc(e.type)}" onerror="this.parentElement.classList.add('hero-error')"/></div>`
      : `<div class="event-hero event-hero-gradient ${heroGradientClass(e.type)}"></div>`;

    const adminControls = isAdminPlus
      ? `<div class="event-admin-controls">
           <button class="btn btn-sm btn-outline" onclick="openShareEvent(${e.id})">🔗 Share</button>
           <button class="btn btn-sm btn-outline" onclick="openEditEvent(${e.id})">✏️ Edit</button>
           <button class="btn btn-sm btn-danger" onclick="deleteEvent(${e.id})">🗑 Delete</button>
         </div>`
      : '';

    return `
    <div class="event-card${past ? ' event-past' : ''}">
      ${heroBanner}
      <div class="event-body">
        <div class="event-header">
          <div><span class="event-type">${esc(e.type)}</span>${pendingBadge}${pastBadge}${shareBadge}</div>
          <span class="event-date-badge">${esc(e.event_date)} ${esc(e.event_time)}</span>
        </div>
        <div class="event-meta"><span>📍 ${esc(e.location)}</span></div>
        ${e.details ? `<div class="event-details">${esc(e.details)}</div>` : ''}
        ${e.diet_notes ? `<div class="event-diet">🥗 ${esc(e.diet_notes)}</div>` : ''}
        ${adminControls}
      </div>
    </div>`;
  }).join('');
}

// ── Render admin pending ───────────────────────────────────────────────────
function renderAdminPending({ tags, events }) {
  const container = $('admin-pending');
  let html = '';

  if (!tags.length && !events.length) {
    container.innerHTML = '<div class="empty-state">No pending items. All caught up.</div>';
    return;
  }

  if (tags.length) {
    html += '<h3 style="font-size:13px;font-weight:700;margin-bottom:.75rem;color:var(--text-muted)">DIETARY TAGS</h3>';
    html += tags.map(t => `
      <div class="pending-item">
        <div class="pending-item-header">${esc(t.member_name)} — <span class="tag tag-${t.type}" style="vertical-align:middle">${esc(t.type)}</span></div>
        <div class="pending-item-meta">
          Value: <strong>${esc(t.value)}</strong><br>
          Submitted by: ${esc(t.submitted_by_name || 'Unknown')} · ${esc(t.created_at)}
        </div>
        <div class="pending-actions">
          <button class="btn btn-sm btn-success" onclick="approveTag(${t.id})">✓ Approve</button>
          <button class="btn btn-sm btn-danger" onclick="rejectTag(${t.id})">✕ Reject</button>
        </div>
      </div>`).join('');
  }

  if (events.length) {
    html += '<h3 style="font-size:13px;font-weight:700;margin:.75rem 0;color:var(--text-muted)">EVENTS</h3>';
    html += events.map(e => `
      <div class="pending-item">
        <div class="pending-item-header">${esc(e.type)} — ${esc(e.event_date)} ${esc(e.event_time)}</div>
        <div class="pending-item-meta">
          📍 ${esc(e.location)}<br>
          ${e.details ? esc(e.details) + '<br>' : ''}
          Submitted by: ${esc(e.submitted_by_name || 'Unknown')} · ${esc(e.created_at)}
        </div>
        <div class="pending-actions">
          <button class="btn btn-sm btn-success" onclick="approveEvent(${e.id})">✓ Approve</button>
          <button class="btn btn-sm btn-danger" onclick="rejectEvent(${e.id})">✕ Reject</button>
        </div>
      </div>`).join('');
  }

  container.innerHTML = html;
}

// ── Render admin members ──────────────────────────────────────────────────
function renderAdminMembers(members) {
  const container = $('admin-members');
  if (!members.length) {
    container.innerHTML = '<div class="empty-state">No members yet. Add your first family member above.</div>';
    return;
  }
  const genLabel = { 1: '1st Gen', 2: '2nd Gen', 3: '3rd Gen' };
  const rows = members.map(m => `
    <tr>
      <td><div class="avatar avatar-${m.avatar_color}" style="width:30px;height:30px;font-size:11px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font-weight:700;margin-right:.5rem">${esc(m.initials)}</div>${esc(m.name)}</td>
      <td>${genLabel[m.generation] || m.generation}</td>
      <td>${esc(m.relation)}</td>
      <td style="color:var(--text-muted);font-size:12px">${esc(m.notes || '—')}</td>
      <td>
        <div class="user-actions">
          <button class="btn btn-sm btn-outline" onclick="openEditMember(${m.id})">✏️ Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteMember(${m.id})">🗑 Delete</button>
        </div>
      </td>
    </tr>`).join('');
  container.innerHTML = `
    <table class="member-mgmt-table">
      <thead><tr><th>Name</th><th>Gen</th><th>Relation</th><th>Notes</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

window.openEditMember = (id) => {
  const m = membersCache.find(x => x.id === id);
  if (!m) return;
  $('member-id').value = m.id;
  $('modal-member-title').textContent = 'Edit family member';
  $('member-name').value = m.name;
  $('member-initials').value = m.initials;
  $('member-generation').value = m.generation;
  $('member-relation').value = m.relation;
  $('member-notes').value = m.notes || '';
  setMemberColor(m.avatar_color);
  openModal('modal-member');
};

window.deleteMember = async (id) => {
  const m = membersCache.find(x => x.id === id);
  if (!confirm(`Remove ${m?.name || 'this member'} and ALL their tags permanently?`)) return;
  try {
    await api('DELETE', `/api/admin/members/${id}`);
    toast('Member removed', 'success');
    await Promise.all([loadMembers(), loadAdminMembers()]);
  } catch (e) { toast(e.message, 'error'); }
};

function setMemberColor(color) {
  $('member-color').value = color;
  document.querySelectorAll('#member-color-picker .color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
}

// ── Render admin users ─────────────────────────────────────────────────────
function renderAdminUsers(users) {
  const container = $('admin-users');
  const isOwner = currentUser.role === 'owner';

  const rows = users.map(u => {
    const isOwnerRow = u.role === 'owner';
    const isSelf = u.id === currentUser.userId;
    let actions = '';
    if (!isOwnerRow && !isSelf) {
      if (u.role === 'pending') {
        actions += `<button class="btn btn-sm btn-success" onclick="setUserRole(${u.id},'member')">Activate</button>`;
      } else if (u.role === 'member') {
        actions += `<button class="btn btn-sm btn-outline" onclick="setUserRole(${u.id},'pending')">Deactivate</button>`;
        if (isOwner) actions += `<button class="btn btn-sm btn-outline" onclick="setUserRole(${u.id},'admin')">→ Admin</button>`;
      } else if (u.role === 'admin' && isOwner) {
        actions += `<button class="btn btn-sm btn-outline" onclick="setUserRole(${u.id},'member')">→ Member</button>`;
      }
    }
    return `
      <tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td><span class="role-pill role-${u.role}">${u.role}</span></td>
        <td>${u.activated_at ? 'Active' : 'Pending'}</td>
        <td>${esc(u.created_at.split('T')[0] || u.created_at)}</td>
        <td><div class="user-actions">${actions}</div></td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="users-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Registered</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

window.deleteTag = async (id) => {
  if (!confirm('Remove this tag permanently?')) return;
  try { await api('DELETE', `/api/admin/tags/${id}`); toast('Tag removed', 'success'); await loadMembers(); } catch (e) { toast(e.message, 'error'); }
};
window.openEditTag = (id, type, value) => {
  $('edit-tag-id').value = id;
  $('edit-tag-type').value = type;
  $('edit-tag-value').value = value;
  openModal('modal-edit-tag');
};
window.deleteEvent = async (id) => {
  if (!confirm('Delete this event permanently?')) return;
  try { await api('DELETE', `/api/admin/events/${id}`); toast('Event deleted', 'success'); await loadEvents(); } catch (e) { toast(e.message, 'error'); }
};
window.openEditEvent = (id) => {
  const e = eventsCache.find(ev => ev.id === id);
  if (!e) return;
  $('edit-ev-id').value = e.id;
  $('edit-ev-type').value = e.type;
  $('edit-ev-date').value = e.event_date;
  $('edit-ev-time').value = e.event_time;
  $('edit-ev-location').value = e.location;
  $('edit-ev-details').value = e.details || '';
  $('edit-ev-diet').value = e.diet_notes || '';
  $('edit-ev-hero').value = e.hero_image_url || '';
  updateHeroPreview('edit-ev-hero', 'edit-ev-hero-preview');
  openModal('modal-edit-event');
};

// ── Admin actions (global so onclick works) ────────────────────────────────
window.approveTag = async (id) => {
  try { await api('POST', `/api/admin/tags/${id}/approve`); toast('Tag approved', 'success'); await loadAll(); } catch (e) { toast(e.message, 'error'); }
};
window.rejectTag = async (id) => {
  try { await api('POST', `/api/admin/tags/${id}/reject`); toast('Tag rejected', 'success'); await loadAll(); } catch (e) { toast(e.message, 'error'); }
};
window.approveEvent = async (id) => {
  try { await api('POST', `/api/admin/events/${id}/approve`); toast('Event approved', 'success'); await loadAll(); } catch (e) { toast(e.message, 'error'); }
};
window.rejectEvent = async (id) => {
  try { await api('POST', `/api/admin/events/${id}/reject`); toast('Event rejected', 'success'); await loadAll(); } catch (e) { toast(e.message, 'error'); }
};
window.setUserRole = async (id, role) => {
  try { await api('PATCH', `/api/admin/users/${id}`, { role }); toast('User updated', 'success'); await loadAdminUsers(); } catch (e) { toast(e.message, 'error'); }
};

// ── Helper ─────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Modal helpers ──────────────────────────────────────────────────────────
function openModal(id) { show($(id)); }
function closeModal(id) { hide($(id)); }

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modal;
    if (id) closeModal(id);
  });
});
document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeModal(backdrop.id);
  });
});

// ── Event listeners ────────────────────────────────────────────────────────

// Eye toggle
document.querySelectorAll('.eye-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = $(btn.dataset.target);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
});

// Register panel toggle
$('toggle-register').addEventListener('click', () => {
  const panel = $('register-panel');
  const btn = $('toggle-register');
  panel.classList.toggle('hidden');
  btn.classList.toggle('open');
});

// Guest login
$('btn-guest').addEventListener('click', async () => {
  const pin = $('guest-pin').value.trim();
  const err = $('guest-error');
  hide(err);
  if (!pin) { show(err); err.textContent = 'Enter the family password.'; return; }
  try {
    const data = await api('POST', '/api/auth/guest', { guestPin: pin });
    storeSession(data);
    enterApp();
  } catch (e) {
    show(err); err.textContent = e.message;
  }
});

// Sign in
$('btn-login').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const err = $('login-error');
  hide(err);
  if (!email || !password) { show(err); err.textContent = 'Email and password required.'; return; }
  try {
    const data = await api('POST', '/api/auth/login', { email, password });
    storeSession(data);
    if (data.role === 'pending') showView('pending');
    else enterApp();
  } catch (e) {
    show(err); err.textContent = e.message;
  }
});

// Register
$('btn-register').addEventListener('click', async () => {
  const name = $('reg-name').value.trim();
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;
  const confirm = $('reg-confirm').value;
  const err = $('register-error');
  const msg = $('register-msg');
  hide(err); hide(msg);
  if (!name || !email || !password) { show(err); err.textContent = 'All fields required.'; return; }
  if (password !== confirm) { show(err); err.textContent = 'Passwords do not match.'; return; }
  if (password.length < 8) { show(err); err.textContent = 'Password must be at least 8 characters.'; return; }
  try {
    await api('POST', '/api/auth/register', { name, email, password });
    show(msg); msg.textContent = 'Request sent — a family admin will activate your account shortly.';
    $('reg-name').value = ''; $('reg-email').value = ''; $('reg-password').value = ''; $('reg-confirm').value = '';
  } catch (e) {
    show(err); err.textContent = e.message;
  }
});

// Sign out (all views)
['btn-signout', 'btn-pending-signout'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('click', () => {
    clearSession();
    if (pollTimer) clearInterval(pollTimer);
    showView('login');
  });
});

// Guest signin link
$('guest-signin-link').addEventListener('click', e => {
  e.preventDefault();
  clearSession();
  if (pollTimer) clearInterval(pollTimer);
  showView('login');
});

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => { t.classList.remove('active'); t.classList.remove('hidden'); });
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'admin') {
      loadAdminPending();
      loadAdminUsers();
      loadAdminMembers();
    }
  });
});

// Generation filter
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeGenFilter = btn.dataset.gen;
    renderMembers();
  });
});

// Tag type filter (allergy / restriction) — toggles on/off
document.querySelectorAll('.tag-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tag = btn.dataset.tag;
    if (activeTagFilter === tag) {
      activeTagFilter = null;
      btn.classList.remove('active');
    } else {
      activeTagFilter = tag;
      document.querySelectorAll('.tag-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    renderMembers();
  });
});

// Add tag modal
$('btn-add-tag').addEventListener('click', () => {
  const sel = $('tag-member');
  sel.innerHTML = membersCache.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('tag-value').value = ''; $('tag-notes').value = '';
  openModal('modal-tag');
});

// Submit tag
$('btn-submit-tag').addEventListener('click', async () => {
  const memberId = $('tag-member').value;
  const type = $('tag-type').value;
  const value = $('tag-value').value.trim();
  const notes = $('tag-notes').value.trim();
  if (!value) { toast('Value is required', 'error'); return; }
  try {
    await api('POST', `/api/members/${memberId}/updates`, { type, value, notes });
    closeModal('modal-tag');
    toast('Dietary update submitted — pending approval', 'success');
    await loadMembers();
  } catch (e) { toast(e.message, 'error'); }
});

// Add event modal
$('btn-add-event').addEventListener('click', () => {
  ['ev-type','ev-date','ev-time','ev-location','ev-details','ev-diet','ev-hero'].forEach(id => { $(id).value = ''; });
  hide($('ev-hero-preview'));
  openModal('modal-event');
});

// Submit event
$('btn-submit-event').addEventListener('click', async () => {
  const type = $('ev-type').value.trim();
  const event_date = $('ev-date').value;
  const event_time = $('ev-time').value;
  const location = $('ev-location').value.trim();
  const details = $('ev-details').value.trim();
  const diet_notes = $('ev-diet').value.trim();
  const hero_image_url = $('ev-hero').value.trim();
  if (!type || !event_date || !event_time || !location) { toast('Type, date, time, and location are required', 'error'); return; }
  try {
    await api('POST', '/api/events', { type, event_date, event_time, location, details, diet_notes, hero_image_url });
    closeModal('modal-event');
    toast('Event submitted — pending approval', 'success');
    await loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

// Save edited tag
$('btn-save-tag').addEventListener('click', async () => {
  const id = $('edit-tag-id').value;
  const type = $('edit-tag-type').value;
  const value = $('edit-tag-value').value.trim();
  if (!value) { toast('Value cannot be empty', 'error'); return; }
  try {
    await api('PATCH', `/api/admin/tags/${id}`, { type, value });
    closeModal('modal-edit-tag');
    toast('Tag updated', 'success');
    await loadMembers();
  } catch (e) { toast(e.message, 'error'); }
});

// Save edited event
$('btn-save-event').addEventListener('click', async () => {
  const id = $('edit-ev-id').value;
  const type = $('edit-ev-type').value.trim();
  const event_date = $('edit-ev-date').value;
  const event_time = $('edit-ev-time').value;
  const location = $('edit-ev-location').value.trim();
  const details = $('edit-ev-details').value.trim();
  const diet_notes = $('edit-ev-diet').value.trim();
  const hero_image_url = $('edit-ev-hero').value.trim();
  if (!type || !event_date || !event_time || !location) { toast('Type, date, time, and location are required', 'error'); return; }
  try {
    await api('PATCH', `/api/admin/events/${id}`, { type, event_date, event_time, location, details, diet_notes, hero_image_url });
    closeModal('modal-edit-event');
    toast('Event updated', 'success');
    await loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

// Hero image preview helper
function updateHeroPreview(inputId, previewId) {
  const url = $(inputId).value.trim();
  const preview = $(previewId);
  if (!url) { hide(preview); return; }
  preview.innerHTML = `<img src="${esc(url)}" style="width:100%;height:120px;object-fit:cover;border-radius:6px;margin-top:.5rem" onerror="this.parentElement.style.display='none'"/>`;
  show(preview);
}

// Live hero preview on input
$('ev-hero').addEventListener('input', () => updateHeroPreview('ev-hero', 'ev-hero-preview'));
$('edit-ev-hero').addEventListener('input', () => updateHeroPreview('edit-ev-hero', 'edit-ev-hero-preview'));

// Share event
let shareEventId = null;
window.openShareEvent = async (id) => {
  shareEventId = id;
  const ev = eventsCache.find(e => e.id === id);
  const haToken = ev && ev.share_token;
  $('share-diet-toggle').checked = ev && ev.share_diet_enabled ? true : false;
  $('share-link-input').value = haToken ? `${location.origin}/share/${ev.share_token}` : '';
  openModal('modal-share');
  if (!haToken) {
    // Auto-generate on open
    try {
      const data = await api('POST', `/api/events/${id}/share`, { diet: false });
      $('share-link-input').value = `${location.origin}/share/${data.token}`;
      await loadEvents();
    } catch (e) { toast(e.message, 'error'); }
  }
};

$('share-diet-toggle').addEventListener('change', async () => {
  if (!shareEventId) return;
  try {
    const diet = $('share-diet-toggle').checked;
    const data = await api('POST', `/api/events/${shareEventId}/share`, { diet });
    $('share-link-input').value = `${location.origin}/share/${data.token}`;
    await loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

$('btn-copy-share').addEventListener('click', () => {
  const val = $('share-link-input').value;
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => toast('Link copied!', 'success')).catch(() => {
    $('share-link-input').select();
    document.execCommand('copy');
    toast('Link copied!', 'success');
  });
});

$('btn-revoke-share').addEventListener('click', async () => {
  if (!shareEventId) return;
  if (!confirm('Revoke this share link? Anyone with the current link will lose access immediately.')) return;
  try {
    await api('DELETE', `/api/events/${shareEventId}/share`);
    $('share-link-input').value = '';
    closeModal('modal-share');
    toast('Share link revoked', 'success');
    await loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

// Profile settings modal
$('btn-open-profile').addEventListener('click', async () => {
  try {
    const me = await api('GET', '/api/auth/me');
    $('profile-name').value = me.name;
    $('profile-email').value = me.email;
    ['profile-cur-pw','profile-new-pw'].forEach(id => { $(id).value = ''; });
    ['profile-msg','profile-error','pw-msg','pw-error'].forEach(id => hide($(id)));
    openModal('modal-profile');
  } catch (e) { toast(e.message, 'error'); }
});

$('btn-save-profile').addEventListener('click', async () => {
  const name = $('profile-name').value.trim();
  const email = $('profile-email').value.trim();
  const err = $('profile-error');
  const msg = $('profile-msg');
  hide(err); hide(msg);
  if (!name || !email) { show(err); err.textContent = 'Name and email required.'; return; }
  try {
    await api('PATCH', '/api/auth/me', { name, email });
    // Update badge immediately
    currentUser.name = name;
    sessionStorage.setItem('fdr_name', name);
    $('user-badge').textContent = name + ' · ' + currentUser.role;
    show(msg); msg.textContent = 'Profile updated. Re-login to refresh session token.';
  } catch (e) { show(err); err.textContent = e.message; }
});

$('btn-change-pw').addEventListener('click', async () => {
  const cur = $('profile-cur-pw').value;
  const nw = $('profile-new-pw').value;
  const err = $('pw-error');
  const msg = $('pw-msg');
  hide(err); hide(msg);
  if (!cur || !nw) { show(err); err.textContent = 'Both password fields required.'; return; }
  try {
    await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: nw });
    $('profile-cur-pw').value = ''; $('profile-new-pw').value = '';
    show(msg); msg.textContent = 'Password changed successfully.';
  } catch (e) { show(err); err.textContent = e.message; }
});


// Add member modal
$('btn-add-member').addEventListener('click', () => {
  $('member-id').value = '';
  $('modal-member-title').textContent = 'Add family member';
  ['member-name','member-initials','member-relation','member-notes'].forEach(id => { $(id).value = ''; });
  $('member-generation').value = '1';
  setMemberColor('blue');
  openModal('modal-member');
});

// Color swatch picker
document.querySelectorAll('#member-color-picker .color-swatch').forEach(btn => {
  btn.addEventListener('click', () => setMemberColor(btn.dataset.color));
});

// Save member (add or edit)
$('btn-save-member').addEventListener('click', async () => {
  const id = $('member-id').value;
  const name = $('member-name').value.trim();
  const initials = $('member-initials').value.trim();
  const generation = $('member-generation').value;
  const relation = $('member-relation').value.trim();
  const notes = $('member-notes').value.trim();
  const avatar_color = $('member-color').value;
  if (!name || !initials || !relation) { toast('Name, initials, and relation are required', 'error'); return; }
  try {
    if (id) {
      await api('PATCH', `/api/admin/members/${id}`, { name, initials, generation, relation, notes, avatar_color });
      toast('Member updated', 'success');
    } else {
      await api('POST', '/api/admin/members', { name, initials, generation, relation, notes, avatar_color });
      toast('Member added', 'success');
    }
    closeModal('modal-member');
    await Promise.all([loadMembers(), loadAdminMembers()]);
  } catch (e) { toast(e.message, 'error'); }
});

// Backup DB download (authenticated fetch → blob)
$('btn-backup').addEventListener('click', async () => {
  try {
    const token = sessionStorage.getItem('fdr_token');
    const res = await fetch('/api/admin/backup', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) { toast('Backup failed: ' + res.status, 'error'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `drep-backup-${new Date().toISOString().slice(0,10)}.db`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded', 'success');
  } catch (e) { toast('Backup failed', 'error'); }
});

// Window focus refresh
window.addEventListener('focus', () => {
  if (currentUser) loadAll();
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
(function init() {
  const token = sessionStorage.getItem('fdr_token');
  const role = sessionStorage.getItem('fdr_role');
  const name = sessionStorage.getItem('fdr_name');
  const userId = sessionStorage.getItem('fdr_userId');

  if (token && role) {
    currentUser = { token, role, name, userId: userId ? parseInt(userId) : null };
    if (role === 'pending') showView('pending');
    else enterApp();
  } else {
    showView('login');
  }
})();
