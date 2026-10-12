// ==========================================
// WA Gateway Pro - Frontend SPA Controller
// ==========================================

const API_BASE = '/api/v1';
let authToken = localStorage.getItem('wa_auth_token') || '';
let currentUser = null;
let socket = null;
let activeSessionIdForModal = null;
let qrPollTimer = null;
let activeChatRemoteJid = null;
let currentActiveSessionForChat = null;

// Safely parse a fetch Response as JSON. Hosts return empty or HTML bodies on
// errors (e.g. a 502 Bad Gateway), which made res.json() throw
// "Unexpected end of JSON input". This always returns a usable object.
async function parseJson(res) {
  const text = await res.text();
  if (text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      /* fall through */
    }
  }
  return { success: false, error: `Request failed (HTTP ${res.status})`, _httpStatus: res.status };
}

// Copy to clipboard helper
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied!');
  }).catch(() => {
    showToast('Failed to copy');
  });
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-4 right-4 bg-emerald-500 text-slate-950 px-4 py-2 rounded-xl text-xs font-semibold shadow-lg z-50 animate-slide-up';
  toast.innerText = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// Initialize app on load
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  if (authToken) {
    loadUserAndInit();
  } else {
    showAuthScreen();
  }
});

// ==========================================
// 1. Authentication Handlers
// ==========================================
function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('loginForm').classList.toggle('hidden', !isLogin);
  document.getElementById('registerForm').classList.toggle('hidden', isLogin);
  
  document.getElementById('tabLogin').className = isLogin 
    ? 'flex-1 pb-3 text-sm font-semibold text-emerald-400 border-b-2 border-emerald-400'
    : 'flex-1 pb-3 text-sm font-semibold text-slate-400 border-b-2 border-transparent hover:text-slate-200';

  document.getElementById('tabRegister').className = !isLogin 
    ? 'flex-1 pb-3 text-sm font-semibold text-emerald-400 border-b-2 border-emerald-400'
    : 'flex-1 pb-3 text-sm font-semibold text-slate-400 border-b-2 border-transparent hover:text-slate-200';
  
  document.getElementById('authError').classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await parseJson(res);
    if (!data.success) throw new Error(data.error);

    authToken = data.token;
    localStorage.setItem('wa_auth_token', authToken);
    currentUser = data.user;

    initApp();
  } catch (err) {
    showAuthError(err.message);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  const plan = document.getElementById('regPlan').value;

  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, plan }),
    });

    const data = await parseJson(res);
    if (!data.success) throw new Error(data.error);

    authToken = data.token;
    localStorage.setItem('wa_auth_token', authToken);
    currentUser = data.user;

    initApp();
  } catch (err) {
    showAuthError(err.message);
  }
}

function showAuthError(msg) {
  const errDiv = document.getElementById('authError');
  errDiv.innerText = msg;
  errDiv.classList.remove('hidden');
}

function handleLogout() {
  localStorage.removeItem('wa_auth_token');
  authToken = '';
  if (socket) socket.disconnect();
  location.reload();
}

async function loadUserAndInit() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) throw new Error();
    currentUser = data.user;
    initApp();
  } catch {
    handleLogout();
  }
}

// ==========================================
// 2. Application Init & Real-Time Socket.IO
// ==========================================
function initApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');

  // Update User info in header
  document.getElementById('userNameHeader').innerText = currentUser.name;
  document.getElementById('userEmailHeader').innerText = currentUser.email;
  document.getElementById('userPlanBadge').innerText = (currentUser.plan || 'STARTER').toUpperCase();

  // Connect Socket.IO
  initSocket();

  // Load Initial Data
  loadOverviewStats();
  loadSessions();
  loadApiKeys();

  if (window.lucide) lucide.createIcons();
}

function initSocket() {
  if (socket) socket.disconnect();

  socket = io({
    auth: { token: authToken },
  });

  socket.on('connect', () => {
    document.getElementById('socketStatusText').innerText = 'Gateway Live';
  });

  socket.on('session_qr', ({ sessionId, qr }) => {
    if (activeSessionIdForModal === sessionId) {
      document.getElementById('qrImage').src = qr;
      document.getElementById('qrModal').classList.remove('hidden');
      setQrModalHint('Open WhatsApp > Linked Devices > Link a Device. QR refreshes every 5s.');
    }
    loadSessions();
  });

  socket.on('session_status', ({ sessionId, status, phone, pushName }) => {
    loadSessions();
    loadOverviewStats();
    if (status === 'CONNECTED' && activeSessionIdForModal === sessionId) {
      closeQrModal();
    }
  });

  socket.on('new_message', (msg) => {
    loadOverviewStats();
    if (currentActiveSessionForChat === msg.sessionId) {
      loadChats();
      const rJid = msg.remoteJid || msg.remote_jid;
      if (activeChatRemoteJid && (activeChatRemoteJid === rJid || (activeChatRemoteJid.split('@')[0] === (rJid || '').split('@')[0]))) {
        appendMessageBubble(msg);
      }
    }
  });

  socket.on('message_sent', (msg) => {
    loadOverviewStats();
    loadChats();
  });
}

// ==========================================
// 3. Navigation View Switcher
// ==========================================
function switchView(viewName) {
  document.querySelectorAll('.view-panel').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active-nav'));

  const activePanel = document.getElementById(`view-${viewName}`);
  const activeBtn = document.getElementById(`nav-${viewName}`);

  if (activePanel) activePanel.classList.remove('hidden');
  if (activeBtn) activeBtn.classList.add('active-nav');

  if (viewName === 'overview') loadOverviewStats();
  if (viewName === 'sessions') loadSessions();
  if (viewName === 'chats') {
    populateChatSessionSelector();
  }
  if (viewName === 'broadcast') {
    populateBroadcastSessionSelector();
  }
  if (viewName === 'apikeys') loadApiKeys();

  if (window.lucide) lucide.createIcons();
}

// ==========================================
// 4. Overview & Stats
// ==========================================
async function loadOverviewStats() {
  try {
    const res = await fetch(`${API_BASE}/stats/overview`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) return;

    const s = data.stats;
    document.getElementById('metricActiveSessions').innerText = s.sessions.active;
    document.getElementById('metricTotalSessions').innerText = `${s.sessions.total} / ${s.sessions.maxAllowed} allowed`;

    document.getElementById('metricSentToday').innerText = s.messages.sentToday;
    document.getElementById('metricSentTotal').innerText = `${s.messages.sentTotal} Total all time`;

    document.getElementById('metricReceivedTotal').innerText = s.messages.receivedTotal;

    document.getElementById('metricWebhookRate').innerText = `${s.webhooks.rate}%`;
    document.getElementById('metricWebhookCount').innerText = `${s.webhooks.success} / ${s.webhooks.total} calls`;

    // Quota Progress Bar
    const quotaPercent = Math.min(Math.round((s.sessions.total / s.sessions.maxAllowed) * 100), 100);
    document.getElementById('quotaProgressBar').style.width = `${quotaPercent}%`;
    document.getElementById('quotaSessionsText').innerText = `${s.sessions.total} / ${s.sessions.maxAllowed} Sessions`;

    // Recent Activity List
    const activityList = document.getElementById('recentActivityList');
    if (s.recentMessages && s.recentMessages.length > 0) {
      activityList.innerHTML = s.recentMessages.map(m => `
        <div class="flex items-center justify-between p-3 bg-slate-950/60 rounded-xl border border-slate-800/60">
          <div class="flex items-center gap-3">
            <span class="p-1.5 ${m.from_me ? 'bg-cyan-500/10 text-cyan-400' : 'bg-emerald-500/10 text-emerald-400'} rounded-lg">
              <i data-lucide="${m.from_me ? 'arrow-up-right' : 'arrow-down-left'}" class="w-3.5 h-3.5"></i>
            </span>
            <div>
              <div class="font-medium text-white">${m.remote_jid.split('@')[0]}</div>
              <div class="text-[10px] text-slate-400 truncate max-w-xs">${m.body || '[Media message]'}</div>
            </div>
          </div>
          <span class="text-[10px] text-slate-500 font-mono">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      `).join('');
    }

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error loading overview:', err);
  }
}

// ==========================================
// 5. WhatsApp Sessions Management
// ==========================================
async function loadSessions() {
  try {
    const res = await fetch(`${API_BASE}/sessions`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) return;

    const grid = document.getElementById('sessionsGrid');
    if (data.sessions.length === 0) {
      grid.innerHTML = `
        <div class="col-span-3 text-center py-16 bg-slate-900/30 border border-slate-800 rounded-2xl">
          <i data-lucide="smartphone" class="w-10 h-10 text-slate-600 mx-auto mb-3"></i>
          <h3 class="text-sm font-semibold text-white">No WhatsApp Sessions Connected</h3>
          <p class="text-xs text-slate-400 mt-1 mb-4">Click below to add your first WhatsApp number.</p>
          <button onclick="openNewSessionModal()" class="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-semibold rounded-xl text-xs">Create First Session</button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    grid.innerHTML = data.sessions.map(s => {
      const isConnected = s.status === 'CONNECTED';
      const isScanQr = s.status === 'SCAN_QR' || s.status === 'STARTING';

      return `
        <div class="bg-slate-900/60 border ${isConnected ? 'border-emerald-500/30' : 'border-slate-800'} rounded-2xl p-6 flex flex-col justify-between space-y-4">
          <div>
            <div class="flex items-center justify-between mb-3">
                          <span class="text-xs font-bold text-white tracking-wide">${s.session_name}</span>
                          <span class="px-2 py-0.5 text-[10px] font-mono rounded-full ${
                            isConnected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                            isScanQr ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse' :
                            'bg-slate-800 text-slate-400'
                          }">${s.status}</span>
                        </div>

                        <div class="space-y-1.5 text-xs text-slate-400">
                          <div class="flex items-center gap-2">
                                                      <i data-lucide="hash" class="w-3.5 h-3.5 text-slate-500"></i>
                                                      <div class="flex items-center gap-1.5 flex-1 min-w-0">
                                                        <span class="font-mono text-white text-[10px] truncate max-w-[150px]">${s.id}</span>
                                                        <button onclick="copyToClipboard('${s.id}')" class="p-1 text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition" title="Copy Session ID">
                                                          <i data-lucide="copy" class="w-3 h-3"></i>
                                                        </button>
                                                      </div>
                                                    </div>
                          <div class="flex items-center gap-2">
                            <i data-lucide="phone" class="w-3.5 h-3.5 text-slate-500"></i>
                            <span class="font-mono text-white">${s.phone_number ? '+' + s.phone_number : 'Not Connected'}</span>
                          </div>
              <div class="flex items-center gap-2">
                              <i data-lucide="user" class="w-3.5 h-3.5 text-slate-500"></i>
                              <span>${s.push_name || '—'}</span>
                            </div>
                            <div class="flex items-center gap-2">
                              <i data-lucide="calendar" class="w-3.5 h-3.5 text-slate-500"></i>
                              <span class="text-[10px] text-slate-500 font-mono">${new Date(s.created_at).toLocaleDateString()}</span>
                            </div>
            </div>
          </div>

          <div class="pt-3 border-t border-slate-800/80 flex items-center gap-2">
            ${
              !isConnected 
                ? `<button onclick="startSessionAndShowQr('${s.id}')" class="flex-1 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-semibold rounded-xl text-xs transition flex items-center justify-center gap-1.5">
                    <i data-lucide="qr-code" class="w-3.5 h-3.5"></i>
                    <span>Connect / QR</span>
                  </button>`
                : `<button onclick="handleStopSession('${s.id}')" class="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-amber-400 font-medium rounded-xl text-xs transition">
                    Disconnect
                  </button>`
            }
            <button onclick="handleDeleteSession('${s.id}')" class="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition" title="Delete Session">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error loading sessions:', err);
  }
}

function openNewSessionModal() {
  document.getElementById('newSessionModal').classList.remove('hidden');
}
function closeNewSessionModal() {
  document.getElementById('newSessionModal').classList.add('hidden');
}

async function handleCreateSession(e) {
  e.preventDefault();
  const sessionName = document.getElementById('newSessionName').value;
  const webhookUrl = document.getElementById('newSessionWebhook').value;

  try {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ sessionName, webhookUrl }),
    });

    const data = await parseJson(res);
    if (!data.success) throw new Error(data.error);

    closeNewSessionModal();
    loadSessions();
    startSessionAndShowQr(data.session.id);
  } catch (err) {
    alert(err.message);
  }
}

async function startSessionAndShowQr(sessionId) {
  activeSessionIdForModal = sessionId;
  document.getElementById('qrModal').classList.remove('hidden');
  document.getElementById('qrImage').src = 'https://placehold.co/300x300/0f172a/34d399?text=Generating+QR...';
  document.getElementById('pairingCodeDisplay').classList.add('hidden');
  setQrModalHint('Starting session and generating QR...');

  try {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) {
      const msg = data.error || 'Unknown error';
      setQrModalHint(`Could not start session: ${msg}`);
      showToast(`Start failed: ${msg}`);
      return;
    }
  } catch (err) {
    setQrModalHint('Could not reach the gateway. Please retry.');
    console.error('Start session err:', err);
  }

  // Fetch immediately, then keep refreshing every 5 seconds. WhatsApp rotates and
  // expires the QR code, so an auto-refresh guarantees the user always scans a live
  // code instead of a stale one (which silently fails to link the device).
  refreshQr(sessionId);
  startQrPolling(sessionId);
}

function setQrModalHint(text) {
  const el = document.getElementById('qrModalHint');
  if (el) el.innerText = text;
}

async function refreshQr(sessionId) {
  try {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/qr`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) return;

    if (data.status === 'CONNECTED') {
      setQrModalHint('Connected! Closing...');
      closeQrModal();
      loadSessions();
      return;
    }
    if (data.status === 'LOGGED_OUT') {
      setQrModalHint('Device unlinked. Click "New QR" to link again.');
      return;
    }
    if (data.qr) {
      const img = document.getElementById('qrImage');
      if (img.getAttribute('src') !== data.qr) img.src = data.qr;
      setQrModalHint('Open WhatsApp > Linked Devices > Link a Device. QR refreshes every 5s.');
    } else {
      setQrModalHint('Generating QR code...');
    }
  } catch (err) {
    console.error('Refresh QR err:', err);
  }
}

function startQrPolling(sessionId) {
  stopQrPolling();
  qrPollTimer = setInterval(() => {
    if (activeSessionIdForModal !== sessionId) {
      stopQrPolling();
      return;
    }
    refreshQr(sessionId);
  }, 5000);
}

function stopQrPolling() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

// Force a brand-new QR code (relink) for the session currently in the modal
async function handleRegenerateQr() {
  if (!activeSessionIdForModal) return;
  const sessionId = activeSessionIdForModal;
  document.getElementById('qrImage').src = 'https://placehold.co/300x300/0f172a/34d399?text=Generating+QR...';
  setQrModalHint('Generating a fresh QR code...');
  try {
    await fetch(`${API_BASE}/sessions/${sessionId}/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch (err) {
    console.error('Restart session err:', err);
  }
  refreshQr(sessionId);
  startQrPolling(sessionId);
}

function closeQrModal() {
  stopQrPolling();
  document.getElementById('qrModal').classList.add('hidden');
  activeSessionIdForModal = null;
}

async function handleRequestPairingCode() {
  const phone = document.getElementById('pairingPhoneInput').value;
  if (!phone || !activeSessionIdForModal) {
    alert('Please enter your WhatsApp phone number with country code');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/sessions/${activeSessionIdForModal}/pairing-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ phoneNumber: phone }),
    });

    const data = await parseJson(res);
    if (!data.success) throw new Error(data.error);

    const display = document.getElementById('pairingCodeDisplay');
    display.innerText = `CODE: ${data.pairingCode}`;
    display.classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
}

async function handleStopSession(sessionId) {
  if (!confirm('Are you sure you want to disconnect this session?')) return;
  try {
    await fetch(`${API_BASE}/sessions/${sessionId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    loadSessions();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDeleteSession(sessionId) {
  if (!confirm('Are you sure you want to delete this session and clear its credentials?')) return;
  try {
    await fetch(`${API_BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    loadSessions();
    loadOverviewStats();
  } catch (err) {
    alert(err.message);
  }
}

// ==========================================
// 6. Live Chats & Direct Messaging
// ==========================================
let loadedChatsData = [];
let selectedAttachmentFile = null;
const avatarCache = new Map();

// Helper to generate consistent color gradient for contact avatars
function getAvatarGradient(str) {
  const gradients = [
    'from-emerald-500 to-teal-700',
    'from-indigo-500 to-purple-700',
    'from-blue-500 to-cyan-700',
    'from-amber-500 to-orange-700',
    'from-rose-500 to-pink-700',
    'from-violet-500 to-fuchsia-700',
    'from-teal-500 to-emerald-800',
  ];
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return gradients[Math.abs(hash) % gradients.length];
}

function getInitials(name, fallback) {
  if (name && name.trim()) {
    // Remove emojis, symbols, and non-letter decorations
    const clean = name.replace(/[\u{1F600}-\u{1F6FF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}♧🍄⚡💎🐚✨🔥⭐❤️•|~`!@#$%^&*()_=+\[\]{};:'",.<>?/\\-]/gu, ' ').trim();
    if (clean) {
      const parts = clean.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
      }
      return clean.substring(0, 2).toUpperCase();
    }
  }
  const cleanFallback = (fallback || '').replace(/\D/g, '');
  if (cleanFallback.length >= 2) return cleanFallback.slice(-2);
  return 'WA';
}

function renderAvatarHtml(avatarUrl, name, jid, size = 'w-10 h-10') {
  const baseId = jid ? (jid.includes('@') ? jid.split('@')[0] : jid) : '';
  const cached = (jid && avatarCache.get(jid)) || (baseId && avatarCache.get(baseId)) || avatarUrl;
  if (cached) {
    return `<img src="${cached}" class="${size} rounded-full object-cover border border-slate-700/80 shadow shrink-0" onerror="this.onerror=null;this.parentElement.innerHTML=renderAvatarFallback('${escapeHtml(name)}', '${escapeHtml(jid)}', '${size}')" />`;
  }
  return renderAvatarFallback(name, jid, size);
}

function renderAvatarFallback(name, jid, size = 'w-10 h-10') {
  const grad = getAvatarGradient(jid || name);
  const initials = getInitials(name, jid);
  return `
    <div class="${size} rounded-full bg-gradient-to-br ${grad} flex items-center justify-center font-bold text-white text-xs shadow shrink-0 border border-white/10 avatar-initials select-none">
      ${initials}
    </div>
  `;
}

function formatContactPhone(jid, phone) {
  if (phone && phone.startsWith('+')) return phone;
  const raw = phone || (jid ? jid.split('@')[0] : '');
  const digits = raw.replace(/\D/g, '');

  if (digits.length >= 7 && digits.length <= 13) {
    return `+${digits}`;
  }
  if (jid && jid.includes('@s.whatsapp.net') && digits.length <= 13) {
    return `+${digits}`;
  }
  if ((jid && jid.includes('@lid')) || digits.length > 13) {
    return `WhatsApp ID: ${digits}`;
  }
  return digits ? `+${digits}` : '';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function populateChatSessionSelector() {
  const res = await fetch(`${API_BASE}/sessions`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const data = await parseJson(res);
  if (!data.success) return;

  const select = document.getElementById('chatSessionSelector');
  select.innerHTML = '<option value="">Select Connected Session...</option>' + 
    data.sessions.filter(s => s.status === 'CONNECTED').map(s => `<option value="${s.id}">${s.session_name} (+${s.phone_number})</option>`).join('');

  if (data.sessions.filter(s => s.status === 'CONNECTED').length > 0) {
    select.value = data.sessions.filter(s => s.status === 'CONNECTED')[0].id;
    loadChats();
  }
}

async function loadChats() {
  const sessionId = document.getElementById('chatSessionSelector').value;
  currentActiveSessionForChat = sessionId;
  if (!sessionId) return;

  try {
    const res = await fetch(`${API_BASE}/chats?sessionId=${sessionId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) return;

    loadedChatsData = data.chats || [];
    renderContactsList(loadedChatsData);

    // Fetch avatars in background for contacts without avatar
    loadedChatsData.forEach(c => {
      if (c.remote_jid && !avatarCache.has(c.remote_jid)) {
        fetchAvatarInBackground(sessionId, c.remote_jid);
      }
    });
  } catch (err) {
    console.error('Error loading chats:', err);
  }
}

let currentFilteredChats = [];

function renderContactsList(chats) {
  currentFilteredChats = chats;
  const list = document.getElementById('chatContactsList');
  if (chats.length === 0) {
    list.innerHTML = `
      <div class="p-8 text-center text-xs text-slate-500">
        <i data-lucide="message-square-dashed" class="w-8 h-8 text-slate-600 mx-auto mb-2"></i>
        <p>No conversations found</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  list.innerHTML = chats.map((c, index) => {
    const baseId = c.base_id || (c.remote_jid || '').split('@')[0];
    const rawPhone = c.phone_number || baseId;
    const formattedPhone = rawPhone ? `+${rawPhone}` : baseId;
    const displayName = c.name || formattedPhone;
    const isActive = activeChatRemoteJid && (activeChatRemoteJid === c.remote_jid || activeChatRemoteJid.split('@')[0] === baseId);
    
    // Format message snippet with icon
    let msgIcon = '';
    let msgPreview = c.last_message || '';
    if (c.media_type === 'image') {
      msgIcon = '<i data-lucide="image" class="w-3 h-3 text-cyan-400 inline mr-1"></i>';
      msgPreview = c.last_message && c.last_message !== '[Image]' ? c.last_message : 'Photo';
    } else if (c.media_type === 'video') {
      msgIcon = '<i data-lucide="video" class="w-3 h-3 text-indigo-400 inline mr-1"></i>';
      msgPreview = c.last_message && c.last_message !== '[Video]' ? c.last_message : 'Video';
    } else if (c.media_type === 'audio') {
      msgIcon = '<i data-lucide="mic" class="w-3 h-3 text-amber-400 inline mr-1"></i>';
      msgPreview = 'Voice message';
    } else if (c.media_type === 'document') {
      msgIcon = '<i data-lucide="file-text" class="w-3 h-3 text-emerald-400 inline mr-1"></i>';
      msgPreview = c.last_message || 'Document';
    }

    return `
      <div onclick="selectChatByIndex(${index})" 
           class="p-3 hover:bg-slate-800/60 cursor-pointer transition flex items-center gap-3 ${isActive ? 'bg-slate-800/90 border-l-4 border-emerald-400' : ''}">
        <!-- Avatar / DP -->
        <div id="avatar-${escapeHtml(c.remote_jid.replace(/[^a-zA-Z0-9]/g, '_'))}">
          ${renderAvatarHtml(c.avatar_url, displayName, c.remote_jid, 'w-11 h-11')}
        </div>

        <!-- Details -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-1">
            <span class="text-xs font-bold text-white truncate">${escapeHtml(displayName)}</span>
            <span class="text-[9px] text-slate-500 font-mono shrink-0">${c.last_timestamp ? new Date(c.last_timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
          </div>
          <div class="text-[10px] text-slate-400 font-mono truncate">${escapeHtml(formattedPhone)}</div>
          <div class="text-[11px] text-slate-400 truncate flex items-center mt-0.5">
            ${c.from_me ? '<span class="text-emerald-400 text-[10px] mr-1 font-mono">You:</span>' : ''}
            ${msgIcon}
            <span class="truncate">${escapeHtml(msgPreview)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function filterChatContacts() {
  const q = (document.getElementById('contactSearchInput').value || '').toLowerCase().trim();
  if (!q) {
    renderContactsList(loadedChatsData);
    return;
  }
  const filtered = loadedChatsData.filter(c => {
    const name = (c.name || '').toLowerCase();
    const phone = (c.phone_number || '').toLowerCase();
    const jid = (c.remote_jid || '').toLowerCase();
    const msg = (c.last_message || '').toLowerCase();
    return name.includes(q) || phone.includes(q) || jid.includes(q) || msg.includes(q);
  });
  renderContactsList(filtered);
}

async function fetchAvatarInBackground(sessionId, jid) {
  try {
    const res = await fetch(`${API_BASE}/chats/avatar?sessionId=${sessionId}&jid=${encodeURIComponent(jid)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (data.success && data.avatarUrl) {
      avatarCache.set(jid, data.avatarUrl);
      
      // Update DOM avatar for this contact item if visible
      const avatarEl = document.getElementById(`avatar-${jid.replace(/[^a-zA-Z0-9]/g, '_')}`);
      if (avatarEl) {
        avatarEl.innerHTML = `<img src="${data.avatarUrl}" class="w-11 h-11 rounded-full object-cover border border-slate-700/80 shadow shrink-0" />`;
      }
      
      // Update active header if currently viewing this chat
      if (activeChatRemoteJid === jid || (activeChatRemoteJid && activeChatRemoteJid.split('@')[0] === jid.split('@')[0])) {
        const headerAvatar = document.getElementById('activeHeaderAvatar');
        if (headerAvatar) {
          headerAvatar.innerHTML = `<img src="${data.avatarUrl}" class="w-11 h-11 rounded-full object-cover border border-slate-700/80 shadow shrink-0" />`;
        }
      }
    }
  } catch {}
}

function handleChatInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const form = document.getElementById('chatSendForm');
    if (form) {
      handleSendDirectMessage(e);
    }
  }
}

function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function selectChatByIndex(index) {
  const list = currentFilteredChats.length > 0 ? currentFilteredChats : loadedChatsData;
  const chat = list[index];
  if (!chat) return;

  activeChatRemoteJid = chat.remote_jid;
  const sessionId = document.getElementById('chatSessionSelector').value;

  const headerDiv = document.getElementById('activeChatHeader');
  const actionsDiv = document.getElementById('activeChatActions');
  if (actionsDiv) actionsDiv.classList.remove('hidden');

  const baseId = chat.base_id || (chat.remote_jid || '').split('@')[0];
  const rawPhone = chat.phone_number || baseId;
  const formattedPhone = formatContactPhone(chat.remote_jid, rawPhone);
  const name = chat.name || formattedPhone;

  headerDiv.innerHTML = `
    <div id="activeHeaderAvatar">
      ${renderAvatarHtml(chat.avatar_url, name, chat.remote_jid, 'w-11 h-11')}
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="text-sm font-bold text-white truncate">${escapeHtml(name)}</span>
        <button onclick="openEditContactModal('${escapeHtml(chat.remote_jid)}', '${escapeHtml(chat.name || '')}', '${escapeHtml(chat.phone_number || '')}')" 
                class="p-1 text-slate-400 hover:text-emerald-400 hover:bg-slate-800 rounded-lg transition" title="Edit Contact Name or Number">
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
        </button>
        <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0" title="Connected"></span>
      </div>
      <div class="text-[11px] text-slate-400 font-mono truncate">${escapeHtml(formattedPhone)}</div>
    </div>
  `;

  // Update input placeholder and focus
  const inputEl = document.getElementById('chatInputText');
  if (inputEl) {
    inputEl.placeholder = `Type a message to ${name}... (Press Enter to send)`;
    inputEl.focus();
  }

  // Fetch real DP if not yet in cache
  if (!avatarCache.has(chat.remote_jid)) {
    fetchAvatarInBackground(sessionId, chat.remote_jid);
  }

  // Refresh active selection highlight in list
  renderContactsList(list);

  // Load conversation messages
  loadMessagesForActiveChat();
}

function openEditContactModal(jid, currentName, currentPhone) {
  document.getElementById('editContactJid').value = jid;
  document.getElementById('editContactName').value = currentName || '';
  document.getElementById('editContactPhone').value = currentPhone || '';
  document.getElementById('editContactModal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeEditContactModal() {
  document.getElementById('editContactModal').classList.add('hidden');
}

async function handleSaveContact(e) {
  e.preventDefault();
  const jid = document.getElementById('editContactJid').value;
  const name = document.getElementById('editContactName').value.trim();
  const phoneNumber = document.getElementById('editContactPhone').value.trim();
  const avatarFileInput = document.getElementById('editContactAvatarFile');
  const sessionId = document.getElementById('chatSessionSelector').value;

  if (!jid || !sessionId) return;

  try {
    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('jid', jid);
    formData.append('name', name);
    formData.append('phoneNumber', phoneNumber);
    if (avatarFileInput.files && avatarFileInput.files[0]) {
      formData.append('avatarFile', avatarFileInput.files[0]);
    }

    const res = await fetch(`${API_BASE}/chats/contact`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    const data = await parseJson(res);
    if (!data.success) throw new Error(data.error);

    if (data.avatarUrl) {
      avatarCache.set(jid, data.avatarUrl);
      avatarCache.set(jid.split('@')[0], data.avatarUrl);
    }

    avatarFileInput.value = '';
    closeEditContactModal();

    // Reload chats and refresh view
    await loadChats();
    // Find updated index and re-select
    const idx = loadedChatsData.findIndex(c => c.remote_jid === jid || c.base_id === jid.split('@')[0]);
    if (idx !== -1) {
      selectChatByIndex(idx);
    }
  } catch (err) {
    alert(`Failed to save contact: ${err.message}`);
  }
}

async function reloadActiveChat() {
  if (activeChatRemoteJid) {
    await loadMessagesForActiveChat();
  }
}

async function loadMessagesForActiveChat() {
  const sessionId = document.getElementById('chatSessionSelector').value;
  if (!sessionId || !activeChatRemoteJid) return;

  const container = document.getElementById('chatMessagesContainer');
  container.innerHTML = `
    <div class="flex items-center justify-center py-20 text-slate-500 text-xs gap-2">
      <i data-lucide="loader-2" class="w-5 h-5 animate-spin text-emerald-400"></i>
      <span>Loading conversation...</span>
    </div>
  `;
  if (window.lucide) lucide.createIcons();

  try {
    const res = await fetch(`${API_BASE}/messages?sessionId=${sessionId}&jid=${encodeURIComponent(activeChatRemoteJid)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) return;

    if (data.messages.length === 0) {
      container.innerHTML = `
        <div class="text-center text-xs text-slate-500 py-20">
          <p>No messages in this chat yet. Send the first message below!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.messages.map(m => renderMessageBubbleHtml(m)).join('');
    container.scrollTop = container.scrollHeight;
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 60);
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error loading messages:', err);
  }
}

function renderMessageBubbleHtml(m) {
  const isMe = m.fromMe || m.from_me === 1 || m.from_me === true;
  const timeStr = m.timestamp 
    ? new Date(m.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Just now';

  let contentHtml = '';

  const mediaType = m.mediaType || m.media_type || 'text';
  const mediaUrl = m.mediaUrl || m.media_url;
  const caption = m.mediaCaption || m.media_caption || (m.body && !m.body.startsWith('[') ? m.body : '');

  if (mediaType === 'image') {
    if (mediaUrl) {
      contentHtml = `
        <div class="space-y-1.5">
          <div class="relative group cursor-pointer overflow-hidden rounded-xl bg-slate-900 border border-slate-700/50 max-w-sm" onclick="openMediaLightbox('${mediaUrl}', '${escapeHtml(caption)}')">
            <img src="${mediaUrl}" alt="WhatsApp Image" class="max-h-60 max-w-full rounded-xl object-contain hover:scale-[1.02] transition duration-200" />
            <div class="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white">
              <i data-lucide="zoom-in" class="w-6 h-6"></i>
            </div>
          </div>
          ${caption ? `<p class="text-xs pt-1">${escapeHtml(caption)}</p>` : ''}
        </div>
      `;
    } else {
      // Historical image where media file wasn't cached on disk
      contentHtml = `
        <div class="space-y-1.5">
          <div class="flex items-center gap-3 p-3 bg-slate-900/80 rounded-xl border border-slate-700/60">
            <div class="p-2.5 bg-cyan-500/10 text-cyan-400 rounded-lg shrink-0">
              <i data-lucide="image" class="w-5 h-5"></i>
            </div>
            <div>
              <div class="text-xs font-semibold text-white">Photo</div>
              <div class="text-[10px] text-slate-400">Received WhatsApp Image</div>
            </div>
          </div>
          ${caption ? `<p class="text-xs pt-1">${escapeHtml(caption)}</p>` : ''}
        </div>
      `;
    }
  } else if (mediaType === 'video') {
    if (mediaUrl) {
      contentHtml = `
        <div class="space-y-1.5">
          <video controls class="max-h-60 max-w-full rounded-xl bg-black border border-slate-700/50">
            <source src="${mediaUrl}">
            Your browser does not support video playback.
          </video>
          ${caption ? `<p class="text-xs pt-1">${escapeHtml(caption)}</p>` : ''}
        </div>
      `;
    } else {
      contentHtml = `
        <div class="flex items-center gap-3 p-3 bg-slate-900/80 rounded-xl border border-slate-700/60">
          <div class="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-lg shrink-0">
            <i data-lucide="video" class="w-5 h-5"></i>
          </div>
          <div>
            <div class="text-xs font-semibold text-white">Video</div>
            <div class="text-[10px] text-slate-400">Received WhatsApp Video</div>
          </div>
        </div>
      `;
    }
  } else if (mediaType === 'audio') {
    if (mediaUrl) {
      contentHtml = `
        <div class="py-1 min-w-[240px]">
          <audio controls class="w-full h-10 rounded-lg">
            <source src="${mediaUrl}">
          </audio>
        </div>
      `;
    } else {
      contentHtml = `
        <div class="flex items-center gap-3 p-2.5 bg-slate-900/80 rounded-xl border border-slate-700/60">
          <div class="p-2 bg-amber-500/10 text-amber-400 rounded-lg shrink-0">
            <i data-lucide="mic" class="w-4 h-4"></i>
          </div>
          <div>
            <div class="text-xs font-semibold text-white">Voice Message</div>
            <div class="text-[10px] text-slate-400">Audio Voice Note</div>
          </div>
        </div>
      `;
    }
  } else if (mediaType === 'document') {
    const fn = m.media_caption || m.body || 'Document.pdf';
    contentHtml = `
      <a href="${mediaUrl || '#'}" ${mediaUrl ? 'download' : ''} class="flex items-center gap-3 p-2.5 bg-slate-900/80 hover:bg-slate-900 rounded-xl border border-slate-700/60 transition group text-left">
        <div class="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-lg shrink-0 group-hover:bg-emerald-500 group-hover:text-slate-950 transition">
          <i data-lucide="file-text" class="w-5 h-5"></i>
        </div>
        <div class="truncate flex-1">
          <div class="text-xs font-semibold text-white truncate">${escapeHtml(fn)}</div>
          <div class="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
            <span>${mediaUrl ? 'Click to download' : 'Document file'}</span>
            ${mediaUrl ? '<i data-lucide="download" class="w-3 h-3"></i>' : ''}
          </div>
        </div>
      </a>
    `;
  } else {
    // Text fallback
    contentHtml = `<p class="whitespace-pre-wrap break-words leading-relaxed">${escapeHtml(m.body || m.text || '')}</p>`;
  }

  return `
    <div class="flex ${isMe ? 'justify-end' : 'justify-start'}">
      <div class="max-w-md p-3.5 rounded-2xl text-xs ${
        isMe 
          ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-tr-none shadow-md shadow-emerald-900/20' 
          : 'bg-slate-800/90 text-slate-100 rounded-tl-none border border-slate-700/50 shadow-md'
      }">
        ${!isMe && m.push_name ? `<div class="text-[10px] font-semibold text-emerald-400 mb-1">${escapeHtml(m.push_name)}</div>` : ''}
        ${contentHtml}
        <div class="flex items-center justify-end gap-1 mt-1.5 ${isMe ? 'text-emerald-200' : 'text-slate-400'} font-mono text-[9px]">
          <span>${timeStr}</span>
          ${isMe ? '<i data-lucide="check-check" class="w-3 h-3 text-emerald-300 inline"></i>' : ''}
        </div>
      </div>
    </div>
  `;
}

function appendMessageBubble(msg) {
  const container = document.getElementById('chatMessagesContainer');
  const temp = document.createElement('div');
  temp.innerHTML = renderMessageBubbleHtml(msg);
  container.appendChild(temp.firstElementChild);
  container.scrollTop = container.scrollHeight;
  setTimeout(() => {
    container.scrollTop = container.scrollHeight;
  }, 50);
  if (window.lucide) lucide.createIcons();
}

function handleFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  selectedAttachmentFile = file;
  const previewBar = document.getElementById('chatAttachmentPreview');
  const nameEl = document.getElementById('attachmentFileName');
  const sizeEl = document.getElementById('attachmentFileSize');

  nameEl.innerText = file.name;
  sizeEl.innerText = `${(file.size / 1024).toFixed(1)} KB`;
  previewBar.classList.remove('hidden');

  if (window.lucide) lucide.createIcons();
}

function clearSelectedAttachment() {
  selectedAttachmentFile = null;
  document.getElementById('chatFileInput').value = '';
  document.getElementById('chatAttachmentPreview').classList.add('hidden');
}

async function handleSendDirectMessage(e) {
  if (e) e.preventDefault();
  const textInput = document.getElementById('chatInputText');
  const text = textInput ? textInput.value : '';
  const sessionId = document.getElementById('chatSessionSelector').value;
  const sendBtn = document.getElementById('chatSendBtn');

  if (!sessionId) {
    alert('Please select an active WhatsApp session first.');
    return;
  }
  if (!activeChatRemoteJid) {
    alert('Please select a conversation to reply to.');
    return;
  }
  if (!text.trim() && !selectedAttachmentFile) {
    return;
  }

  // Set button sending state
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Sending...</span>';
  if (window.lucide) lucide.createIcons();

  try {
    if (selectedAttachmentFile) {
      // Send Media File with optional text caption
      const formData = new FormData();
      formData.append('sessionId', sessionId);
      formData.append('to', activeChatRemoteJid);
      formData.append('file', selectedAttachmentFile);
      formData.append('caption', text.trim());

      let mediaType = 'document';
      const mime = selectedAttachmentFile.type || '';
      if (mime.startsWith('image/')) mediaType = 'image';
      else if (mime.startsWith('video/')) mediaType = 'video';
      else if (mime.startsWith('audio/')) mediaType = 'audio';

      formData.append('mediaType', mediaType);

      const res = await fetch(`${API_BASE}/messages/send-media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      });

      const data = await parseJson(res);
      if (!data.success) throw new Error(data.error || 'Failed to send media');

      textInput.value = '';
      textInput.style.height = 'auto';
      clearSelectedAttachment();
      appendMessageBubble(data);
      loadChats();
      textInput.focus();
    } else {
      // Send Text Message
      const res = await fetch(`${API_BASE}/messages/send-text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          sessionId,
          to: activeChatRemoteJid,
          text: text.trim(),
        }),
      });

      const data = await parseJson(res);
      if (!data.success) throw new Error(data.error || 'Failed to send text message');

      textInput.value = '';
      textInput.style.height = 'auto';
      appendMessageBubble(data);
      loadChats();
      textInput.focus();
    }
  } catch (err) {
    alert(`Failed to send message: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<i data-lucide="send" class="w-3.5 h-3.5"></i><span>Send</span>';
    if (window.lucide) lucide.createIcons();
  }
}

function openMediaLightbox(url, caption) {
  document.getElementById('lightboxImage').src = url;
  document.getElementById('lightboxDownloadBtn').href = url;
  document.getElementById('lightboxCaption').innerText = caption && caption !== '[Image]' ? caption : '';
  document.getElementById('mediaLightboxModal').classList.remove('hidden');
}

function closeMediaLightbox() {
  document.getElementById('mediaLightboxModal').classList.add('hidden');
  document.getElementById('lightboxImage').src = '';
}

// ==========================================
// 7. Bulk Message Broadcaster
// ==========================================
async function populateBroadcastSessionSelector() {
  const res = await fetch(`${API_BASE}/sessions`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const data = await parseJson(res);
  if (!data.success) return;

  const select = document.getElementById('broadcastSessionId');
  select.innerHTML = data.sessions.filter(s => s.status === 'CONNECTED').map(s => `<option value="${s.id}">${s.session_name} (+${s.phone_number})</option>`).join('');
}

async function handleBroadcast(e) {
  e.preventDefault();
  const sessionId = document.getElementById('broadcastSessionId').value;
  const rawNumbers = document.getElementById('broadcastNumbers').value;
  const message = document.getElementById('broadcastMessage').value;
  const delay = parseInt(document.getElementById('broadcastDelay').value || '3', 10);

  if (!sessionId) {
    alert('Please select an active WhatsApp session');
    return;
  }

  const numbers = rawNumbers.split(/[\n,]+/).map(n => n.trim()).filter(n => n.length > 5);

  if (numbers.length === 0) {
    alert('Please enter at least one valid phone number');
    return;
  }

  const statusDiv = document.getElementById('broadcastStatus');
  statusDiv.className = 'mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl text-xs block';
  statusDiv.innerText = `🚀 Campaign launched for ${numbers.length} numbers with ${delay}s delay. Messages are being sent in the background!`;

  try {
    await fetch(`${API_BASE}/messages/send-bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        sessionId,
        numbers,
        message,
        delaySeconds: delay,
      }),
    });
  } catch (err) {
    statusDiv.className = 'mt-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-xs block';
    statusDiv.innerText = 'Error launching campaign: ' + err.message;
  }
}

// ==========================================
// 8. API Keys & Webhooks
// ==========================================
async function loadApiKeys() {
  try {
    const res = await fetch(`${API_BASE}/auth/api-keys`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await parseJson(res);
    if (!data.success) return;

    const table = document.getElementById('apiKeysTable');
    if (data.keys.length === 0) {
      table.innerHTML = '<div class="p-6 text-center text-xs text-slate-500">No API keys generated yet.</div>';
      return;
    }

    table.innerHTML = data.keys.map(k => `
      <div class="p-4 flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-white">${k.name}</div>
          <div class="text-xs font-mono text-emerald-400 mt-0.5">${k.key_prefix}</div>
          <div class="text-[10px] text-slate-500 mt-1">Created: ${new Date(k.created_at).toLocaleDateString()} ${k.last_used_at ? '• Last used: ' + new Date(k.last_used_at).toLocaleTimeString() : ''}</div>
        </div>
        <button onclick="handleDeleteApiKey('${k.id}')" class="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition" title="Revoke Key">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `).join('');

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error loading API keys:', err);
  }
}

async function handleCreateApiKey() {
  const name = prompt('Enter a name for this API Key (e.g., Production Server, CRM Bot):', 'Server Key');
  if (!name) return;

  try {
    const res = await fetch(`${API_BASE}/auth/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ name }),
    });

    const data = await parseJson(res);
    if (!data.success) throw new Error(data.error);

    prompt('✅ Copy your full API Key now (it will not be shown again):', data.key.apiKey);
    loadApiKeys();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDeleteApiKey(keyId) {
  if (!confirm('Are you sure you want to revoke this API Key? Any application using it will lose access.')) return;
  try {
    await fetch(`${API_BASE}/auth/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    loadApiKeys();
  } catch (err) {
    alert(err.message);
  }
}

async function handleSaveWebhook(e) {
  e.preventDefault();
  const webhook_url = document.getElementById('globalWebhookUrl').value;
  try {
    await fetch(`${API_BASE}/auth/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ webhook_url }),
    });
    alert('✅ Global Webhook URL saved successfully!');
  } catch (err) {
    alert(err.message);
  }
}

function copySessionId(sessionId, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(sessionId).then(() => {
      if (btn) {
        const original = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-emerald-400"></i>';
        if (window.lucide) lucide.createIcons();
        setTimeout(() => {
          btn.innerHTML = original;
          if (window.lucide) lucide.createIcons();
        }, 1500);
      }
    }).catch(() => {
      prompt('Copy Session ID:', sessionId);
    });
  } else {
    prompt('Copy Session ID:', sessionId);
  }
}
