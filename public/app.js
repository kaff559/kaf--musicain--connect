'use strict';

/* ---------- tiny DOM helper (JSX-like, no build step) ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  children.flat(Infinity).forEach((c) => {
    if (c == null || c === false) return;
    if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  });
  return el;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/* ---------- API helper ---------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- global state ---------- */
const state = {
  user: null,
  musicianProfile: null,
  equipmentOwnerProfile: null,
  page: 'home',
  params: {},
  musicians: [],
  equipmentList: [],
  notifications: [],
  unreadCount: 0,
  banner: null, // { type: 'error'|'success', message }
};

function navigate(page, params = {}, banner = null) {
  state.page = page;
  state.params = params;
  state.banner = banner;
  window.scrollTo(0, 0);
  render();
  loadPageData();
  if (banner && banner.type === 'success') {
    setTimeout(() => { if (state.banner === banner) { state.banner = null; render(); } }, 4000);
  }
}

function showBanner(type, message) {
  state.banner = { type, message };
  render();
  if (type === 'success') setTimeout(() => { if (state.banner && state.banner.message === message) { state.banner = null; render(); } }, 4000);
}

/* ---------- formatting helpers ---------- */
function money(n) { return `$${Number(n || 0).toFixed(2)}`; }
function stars(avg) {
  if (avg == null) return 'No reviews yet';
  const full = Math.round(avg);
  return '★'.repeat(full) + '☆'.repeat(5 - full) + ` (${avg})`;
}
function fmtDate(d) { return d; }
function statusLabel(s) { return s.replace(/_/g, ' '); }

/* ---------- refresh session/notifications ---------- */
async function refreshMe() {
  const data = await api('GET', '/api/auth/me');
  state.user = data.user;
  state.musicianProfile = data.musicianProfile || null;
  state.equipmentOwnerProfile = data.equipmentOwnerProfile || null;
}
async function refreshNotifications() {
  if (!state.user) { state.notifications = []; state.unreadCount = 0; return; }
  const data = await api('GET', '/api/notifications/mine');
  state.notifications = data.notifications;
  state.unreadCount = data.unreadCount;
}

/* ---------- topbar ---------- */
function Topbar() {
  const links = [];
  links.push(h('button', { class: state.page === 'home' ? 'active' : '', onclick: () => navigate('home') }, 'Find Musicians'));
  links.push(h('button', { class: state.page === 'equipmentBrowse' ? 'active' : '', onclick: () => navigate('equipmentBrowse') }, 'Rent Equipment'));

  if (state.user) {
    if (state.user.role === 'client') {
      links.push(h('button', { class: state.page === 'clientDashboard' ? 'active' : '', onclick: () => navigate('clientDashboard') }, 'My Dashboard'));
    } else if (state.user.role === 'musician') {
      links.push(h('button', { class: state.page === 'musicianDashboard' ? 'active' : '', onclick: () => navigate('musicianDashboard') }, 'My Dashboard'));
    } else if (state.user.role === 'equipment_owner') {
      links.push(h('button', { class: state.page === 'ownerDashboard' ? 'active' : '', onclick: () => navigate('ownerDashboard') }, 'My Dashboard'));
    } else if (state.user.role === 'admin') {
      links.push(h('button', { class: state.page === 'admin' ? 'active' : '', onclick: () => navigate('admin') }, 'Admin'));
    }
    links.push(h('button', { class: state.page === 'notifications' ? 'active' : '', onclick: () => navigate('notifications') },
      `Notifications${state.unreadCount ? ` (${state.unreadCount})` : ''}`));
    links.push(h('span', { class: 'muted' }, state.user.name));
    links.push(h('button', { class: 'secondary', onclick: doLogout }, 'Log out'));
  } else {
    links.push(h('button', { class: 'secondary', onclick: () => navigate('login') }, 'Log in'));
    links.push(h('button', { onclick: () => navigate('signup') }, 'Sign up'));
  }

  return h('header', { class: 'topbar' },
    h('div', { class: 'container' },
      h('div', { class: 'brand', onclick: () => navigate('home') }, '🎵 Kaf Musician Connect'),
      h('nav', { class: 'nav-links' }, links)
    )
  );
}

async function doLogout() {
  await api('POST', '/api/auth/logout');
  state.user = null; state.musicianProfile = null; state.equipmentOwnerProfile = null;
  navigate('home');
}

/* ---------- root render ---------- */
function render() {
  const app = document.getElementById('app');
  clear(app);
  app.appendChild(Topbar());
  const main = h('main', { class: 'container' });
  if (state.banner) {
    main.appendChild(h('div', { class: state.banner.type === 'error' ? 'error-box' : 'success-box' }, state.banner.message));
  }
  main.appendChild(PageBody());
  app.appendChild(main);
  app.appendChild(h('footer', { class: 'appfoot' },
    'Musician Connect — musicians, MCs, DJs & equipment rental, all in one place. ',
    h('a', { href: '/privacy-policy.html', class: 'footer-link' }, 'Privacy Policy')
  ));
}

function PageBody() {
  switch (state.page) {
    case 'home': return BrowseMusiciansPage();
    case 'login': return LoginPage();
    case 'signup': return SignupPage();
    case 'musicianDetail': return MusicianDetailPage();
    case 'clientDashboard': return ClientDashboardPage();
    case 'musicianDashboard': return MusicianDashboardPage();
    case 'ownerDashboard': return OwnerDashboardPage();
    case 'equipmentBrowse': return EquipmentBrowsePage();
    case 'equipmentDetail': return EquipmentDetailPage();
    case 'admin': return AdminPage();
    case 'notifications': return NotificationsPage();
    default: return h('div', {}, 'Not found');
  }
}

async function loadPageData() {
  try {
    if (state.page === 'home') {
      const data = await api('GET', '/api/musicians' + (state.params.qs || ''));
      state.musicians = data.profiles;
      render();
    } else if (state.page === 'musicianDetail') {
      const data = await api('GET', `/api/musicians/${state.params.id}`);
      state.params.detail = data;
      render();
    } else if (state.page === 'equipmentBrowse') {
      const data = await api('GET', '/api/equipment' + (state.params.qs || ''));
      state.equipmentList = data.equipment;
      render();
    } else if (state.page === 'equipmentDetail') {
      const data = await api('GET', `/api/equipment/${state.params.id}`);
      state.params.detail = data.equipment;
      render();
    } else if (state.page === 'notifications') {
      await refreshNotifications();
      render();
    } else if (state.page === 'clientDashboard') {
      await loadClientDashboardData();
      render();
    } else if (state.page === 'musicianDashboard') {
      await loadMusicianDashboardData();
      // avoid clobbering an in-progress profile edit with an unrelated re-render
      if (state.page === 'musicianDashboard' && (state.params.tab || 'profile') !== 'profile') render();
    } else if (state.page === 'ownerDashboard') {
      await loadOwnerDashboardData();
      if (state.page === 'ownerDashboard' && (state.params.tab || 'profile') !== 'profile') render();
    } else if (state.page === 'admin') {
      await loadAdminData();
      render();
    }
  } catch (err) {
    showBanner('error', err.message);
  }
}

/* ================= AUTH PAGES ================= */
function LoginPage() {
  let email = '', password = '';
  const form = h('form', { class: 'card center-form', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/login', { email, password });
      await refreshMe();
      await refreshNotifications();
      navigate('home', {}, { type: 'success', message: 'Welcome back!' });
    } catch (err) { showBanner('error', err.message); }
  } },
    h('h1', {}, 'Log in'),
    h('label', {}, 'Email'),
    h('input', { type: 'email', required: true, oninput: (e) => email = e.target.value }),
    h('label', {}, 'Password'),
    h('input', { type: 'password', required: true, oninput: (e) => password = e.target.value }),
    h('div', { style: 'margin-top:18px' }, h('button', { type: 'submit' }, 'Log in')),
    h('p', { class: 'muted', style: 'margin-top:14px' }, "Don't have an account? ",
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('signup'); } }, 'Sign up'))
  );
  return h('div', { class: 'full-bleed gradient-surface auth-shell' }, form);
}

function SignupPage() {
  const v = { email: '', password: '', name: '', phone: '', role: 'client' };
  const form = h('form', { class: 'card center-form', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/signup', v);
      await refreshMe();
      await refreshNotifications();
      navigate('home', {}, { type: 'success', message: 'Account created!' });
    } catch (err) { showBanner('error', err.message); }
  } },
    h('h1', {}, 'Create your account'),
    h('label', {}, 'I am a...'),
    h('select', { onchange: (e) => v.role = e.target.value },
      h('option', { value: 'client' }, 'Client (I want to hire musicians / rent gear)'),
      h('option', { value: 'musician' }, 'Musician / Singer / MC / DJ'),
      h('option', { value: 'equipment_owner' }, 'Equipment Owner (I rent out gear)')
    ),
    h('label', {}, 'Full name'),
    h('input', { required: true, oninput: (e) => v.name = e.target.value }),
    h('label', {}, 'Email'),
    h('input', { type: 'email', required: true, oninput: (e) => v.email = e.target.value }),
    h('label', {}, 'Phone (optional)'),
    h('input', { oninput: (e) => v.phone = e.target.value }),
    h('label', {}, 'Password (min 8 characters)'),
    h('input', { type: 'password', required: true, minlength: 8, oninput: (e) => v.password = e.target.value }),
    h('div', { style: 'margin-top:18px' }, h('button', { type: 'submit' }, 'Sign up')),
    h('p', { class: 'muted', style: 'margin-top:14px' }, 'Already have an account? ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('login'); } }, 'Log in'))
  );
  return h('div', { class: 'full-bleed gradient-surface auth-shell' }, form);
}

/* ================= BROWSE MUSICIANS ================= */
const US_STATE_CODES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

/* ---------- floating instrument decoration ---------- */
// Fixed (non-random) layouts so the icons don't jump around on every
// re-render — each entry is [emoji, xPercent, yPercent, sizePx, durationSec, delaySec, rotateDeg]
const FLOATING_ICON_PRESETS = {
  musicians: [
    ['🎹', 2, 8, 110, 8, 0, -10], ['🎸', 87, 6, 120, 9.5, .6, 12],
    ['🎷', 0, 62, 100, 7.5, 1.2, 8], ['🎺', 89, 58, 105, 10, .3, -14],
    ['🥁', 10, 40, 90, 8.5, .9, -9], ['🎤', 78, 40, 80, 9, .4, 10],
    ['🎶', 46, 82, 60, 8.2, 1.1, -6],
  ],
  equipment: [
    ['🥁', 1, 8, 112, 8.5, .2, -11], ['🎧', 87, 6, 115, 9, .7, 10],
    ['🔊', 0, 62, 92, 7.8, 1.3, 6], ['🎚️', 89, 58, 98, 9.6, .5, -13],
    ['🎛️', 12, 42, 85, 8, 1, 12], ['🎤', 80, 42, 78, 7.4, .8, -8],
    ['💡', 46, 82, 58, 8.8, .3, 9],
  ],
  auth: [
    ['🎹', 0, 4, 100, 8, 0, -10], ['🎸', 86, 6, 108, 9.5, .5, 12],
    ['🎷', 0, 27, 90, 7.6, 1, 8], ['🎺', 88, 26, 92, 10, .2, -14],
    ['🥁', 1, 50, 100, 8.4, 1.5, 15], ['🎧', 86, 52, 92, 9, .8, -9],
    ['🎤', 3, 73, 78, 7, .3, 10], ['🎶', 84, 75, 72, 8.6, 1.1, -12],
    ['🪕', 44, 90, 78, 9.2, .6, 9],
  ],
};

function FloatingIcons(preset) {
  const list = FLOATING_ICON_PRESETS[preset] || [];
  return h('div', { class: 'floating-icons', 'aria-hidden': 'true' },
    list.map(([emoji, x, y, size, dur, delay, rot]) =>
      h('span', { class: 'fi', style: `--x:${x}%;--y:${y}%;--size:${size}px;--dur:${dur}s;--delay:${delay}s;--rot:${rot}deg` }, emoji))
  );
}

function Hero(icon, title, subtitle, preset) {
  return h('div', { class: 'full-bleed gradient-surface hero' },
    preset ? FloatingIcons(preset) : null,
    h('div', { class: 'container' },
      h('span', { class: 'music-note' }, icon),
      h('h1', {}, title),
      h('p', {}, subtitle)
    )
  );
}

/* ---------- "stage" hero: animated equalizer + spinning vinyl on a lit piano ---------- */
// Deterministic pseudo-random per bar (hash of the index) so the spectrum
// looks organic but is identical on every render — no jumping on re-render.
const EQ_BARS = Array.from({ length: 48 }, (_, i) => {
  const seed = Math.sin(i * 12.9898) * 43758.5453;
  const frac = seed - Math.floor(seed);
  return {
    heightPx: 22 + Math.round(frac * 92),
    dur: (0.65 + frac * 0.9).toFixed(2),
    delay: (frac * 1.3).toFixed(2),
    minS: (0.22 + frac * 0.22).toFixed(2),
  };
});

function Equalizer() {
  return h('div', { class: 'equalizer', 'aria-hidden': 'true' },
    EQ_BARS.map((b) => h('span', {
      class: 'bar',
      style: `height:${b.heightPx}px;--dur:${b.dur}s;--delay:${b.delay}s;--min:${b.minS};--max:1`,
    })));
}

const VINYL_SVG = `<svg viewBox="0 0 200 200" aria-hidden="true">
  <defs>
    <radialGradient id="vinylLabel" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#7dd3fc"/>
      <stop offset="55%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </radialGradient>
    <radialGradient id="vinylSheen" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="rgba(255,255,255,.20)"/>
      <stop offset="40%" stop-color="rgba(255,255,255,.03)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <circle cx="100" cy="100" r="98" fill="#0a0f24"/>
  <circle cx="100" cy="100" r="97" fill="none" stroke="#22335e" stroke-width="1.5"/>
  <circle cx="100" cy="100" r="86" fill="none" stroke="#142038" stroke-width="2"/>
  <circle cx="100" cy="100" r="74" fill="none" stroke="#142038" stroke-width="2"/>
  <circle cx="100" cy="100" r="62" fill="none" stroke="#142038" stroke-width="2"/>
  <circle cx="100" cy="100" r="50" fill="none" stroke="#142038" stroke-width="2"/>
  <circle cx="100" cy="100" r="40" fill="url(#vinylLabel)"/>
  <circle cx="100" cy="100" r="40" fill="none" stroke="#000" stroke-width="1" opacity=".35"/>
  <circle cx="100" cy="100" r="5" fill="#0a0f24"/>
  <path d="M100 18 A82 82 0 0 1 165 55" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="100" cy="100" r="98" fill="url(#vinylSheen)"/>
</svg>`;

const TONEARM_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="88" cy="12" r="9" fill="#1a2247" stroke="#3a5a94" stroke-width="1.5"/>
  <line x1="88" y1="12" x2="32" y2="66" stroke="#c7dbf5" stroke-width="4" stroke-linecap="round"/>
  <rect x="20" y="60" width="20" height="11" rx="2.5" fill="#0ea5e9"/>
</svg>`;

function Fog() {
  const puffs = [[8, 14, 0], [55, 18, 5], [30, 16, 9]];
  return h('div', { class: 'fog', 'aria-hidden': 'true' },
    puffs.map(([left, dur, delay]) => h('span', { style: `left:${left}%;--fdur:${dur}s;--fdelay:${delay}s` })));
}

// Deterministic pseudo-random per person (same sine-hash trick as EQ_BARS) so
// the crowd silhouette is stable across renders instead of reshuffling.
function hash01(i) {
  const seed = Math.sin(i * 78.233) * 43758.5453;
  return seed - Math.floor(seed);
}

// A silhouetted festival crowd, hands raised, standing in front of the stage
// glow — an original illustration (not a photo) evoking a packed show.
const CROWD_SVG = (() => {
  const W = 1400, H = 210, COUNT = 30;
  let shoulders = '';
  let arms = '';
  for (let i = 0; i < COUNT; i++) {
    const r1 = hash01(i * 2 + 1);
    const r2 = hash01(i * 2 + 2);
    const x = (i + 0.5) * (W / COUNT) + (r1 - 0.5) * 20;
    const shoulderY = H - 6 - r2 * 16;
    const headR = 15 + r1 * 6;
    const headY = shoulderY - headR - 8;
    const shoulderW = 50 + r2 * 20;
    shoulders += `<ellipse cx="${x.toFixed(1)}" cy="${shoulderY.toFixed(1)}" rx="${(shoulderW / 2).toFixed(1)}" ry="34" fill="#0a0f24"/>`;
    shoulders += `<circle cx="${x.toFixed(1)}" cy="${headY.toFixed(1)}" r="${headR.toFixed(1)}" fill="#0a0f24"/>`;
    if (r1 > 0.35) {
      const side = r2 > 0.5 ? 1 : -1;
      const handX = x + side * (headR + 12 + r1 * 16);
      const handY = headY - 42 - r2 * 58;
      const delay = (r1 * 2.6).toFixed(2);
      const dur = (2.8 + r2 * 1.6).toFixed(2);
      arms += `<g class="crowd-arm" style="--cdelay:${delay}s;--cdur:${dur}s;transform-origin:${x.toFixed(1)}px ${shoulderY.toFixed(1)}px">
        <line x1="${x.toFixed(1)}" y1="${(shoulderY - 14).toFixed(1)}" x2="${handX.toFixed(1)}" y2="${handY.toFixed(1)}" stroke="#0a0f24" stroke-width="10" stroke-linecap="round"/>
        <circle cx="${handX.toFixed(1)}" cy="${handY.toFixed(1)}" r="7.5" fill="#0a0f24"/>
      </g>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${shoulders}${arms}</svg>`;
})();

function CrowdSilhouette(extraClass) {
  return h('div', { class: extraClass ? `crowd-band ${extraClass}` : 'crowd-band', 'aria-hidden': 'true', html: CROWD_SVG });
}

// Deterministic crossing stage-light beams — cool + warm cones fanning out
// from a rig overhead, like the crossed spotlights over a packed floor.
const BEAMS = Array.from({ length: 12 }, (_, i) => {
  const r1 = hash01(i * 3 + 11);
  const r2 = hash01(i * 3 + 12);
  const side = i % 2 === 0 ? -1 : 1;
  const warm = r1 > 0.5;
  return {
    angle: (side * (10 + r1 * 48)).toFixed(1),
    top: warm ? '#bfe3ff' : '#e0f2fe',
    bottom: warm ? '#1d4ed8' : '#22d3ee',
    width: (5 + r2 * 6).toFixed(1),
    dur: (3.2 + r2 * 2.6).toFixed(2),
    delay: (r1 * 3.4).toFixed(2),
  };
});

function BeamRig() {
  return h('div', { class: 'beam-rig', 'aria-hidden': 'true' },
    BEAMS.map((b) => h('span', {
      class: 'beam',
      style: `--angle:${b.angle}deg;--w:${b.width}px;--dur:${b.dur}s;--delay:${b.delay}s;background:linear-gradient(to bottom, ${b.top} 0%, ${b.bottom} 32%, transparent 88%)`,
    }))
  );
}

// Same beams, upward: anchored at the hero's own piano keys, shining up past
// the equalizer toward the title.
function BeamRigUp() {
  return h('div', { class: 'beam-rig-up', 'aria-hidden': 'true' },
    BEAMS.map((b) => h('span', {
      class: 'beam',
      style: `--angle:${b.angle}deg;--w:${b.width}px;--dur:${b.dur}s;--delay:${b.delay}s;background:linear-gradient(to top, ${b.top} 0%, ${b.bottom} 32%, transparent 88%)`,
    }))
  );
}

// Same beams again, anchored right beneath the title block, shining down
// through the equalizer to meet the ones rising from the piano.
function BeamRigTitle() {
  return h('div', { class: 'beam-rig-title', 'aria-hidden': 'true' },
    BEAMS.map((b) => h('span', {
      class: 'beam',
      style: `--angle:${b.angle}deg;--w:${b.width}px;--dur:${b.dur}s;--delay:${b.delay}s;background:linear-gradient(to bottom, ${b.top} 0%, ${b.bottom} 32%, transparent 88%)`,
    }))
  );
}

// Bottom-of-page closer: crossing stage lights over a raised-hands crowd —
// an original illustration of the "concert" mood, not a stock photo.
function StageLightsBand(title, subtitle) {
  return h('div', { class: 'full-bleed stage-lights-band' },
    BeamRig(),
    CrowdSilhouette('crowd-band--tall'),
    h('div', { class: 'container stage-lights-copy' },
      h('h2', {}, title || 'This is the energy you\'re booking'),
      h('p', {}, subtitle || 'Real acts, real shows — find the right one and make it happen.')
    )
  );
}

function PianoStrip() {
  // A uniform, evenly-spaced row of keys — no blank "no black key" gaps.
  const keys = Array.from({ length: 24 }, () => 1);
  return h('div', { class: 'piano-strip', 'aria-hidden': 'true' },
    keys.map((hasBlack) => h('div', { class: hasBlack ? 'bk' : 'bk no-black' })));
}

function StageHero(title, subtitle) {
  return h('div', { class: 'full-bleed gradient-surface hero stage-hero' },
    h('div', { class: 'stage-glow' }),
    Fog(),
    CrowdSilhouette(),
    BeamRigUp(),
    h('div', { class: 'keys-glow', 'aria-hidden': 'true' }),
    h('div', { class: 'light-sweep' }),
    h('div', { class: 'vinyl-wrap', html: VINYL_SVG }),
    h('div', { class: 'tonearm', html: TONEARM_SVG }),
    h('div', { class: 'container' },
      h('span', { class: 'music-note' }, '🎵'),
      h('h1', {}, title),
      h('p', {}, subtitle),
      BeamRigTitle()
    ),
    Equalizer(),
    PianoStrip()
  );
}

function BrowseMusiciansPage() {
  const wrap = h('div', {});
  wrap.appendChild(StageHero('Find your musician, singer, MC, or DJ',
    'Try natural language — e.g. "gospel piano player less than $100 an hour" — or filter by city/state, or search within a radius of where you are.'));
  wrap.appendChild(h('div', { class: 'full-bleed keys-glow-below', 'aria-hidden': 'true' }));

  let q = state.params.q || '';
  let city = state.params.city || '';
  let stateCode = state.params.stateCode || '';
  let radius = state.params.radius || '';
  let emergency = false;
  const locationStatus = h('span', { class: 'muted' },
    state.params.lat ? `Using your location — radius is approximate (based on each musician's state, not their exact address).` : '');

  function doSearch() {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (city) qs.set('city', city);
    if (stateCode) qs.set('state', stateCode);
    if (emergency) qs.set('emergency', '1');
    if (radius && state.params.lat && state.params.lng) {
      qs.set('radius', radius);
      qs.set('lat', state.params.lat);
      qs.set('lng', state.params.lng);
    }
    state.params.q = q;
    state.params.city = city;
    state.params.stateCode = stateCode;
    state.params.radius = radius;
    state.params.qs = qs.toString() ? `?${qs}` : '';
    loadPageData();
  }

  function useMyLocation() {
    if (!navigator.geolocation) { showBanner('error', 'Your browser does not support geolocation.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.params.lat = pos.coords.latitude;
        state.params.lng = pos.coords.longitude;
        if (!radius) radius = 25;
        state.params.radius = radius;
        doSearch();
      },
      () => showBanner('error', 'Could not get your location — check your browser/site permissions and try again.'),
      { timeout: 8000 }
    );
  }

  const searchRow = h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('input', { placeholder: 'Search musicians (instrument, genre, name, "under $100/hr")...', value: q, style: 'flex:2;min-width:240px', oninput: (e) => q = e.target.value,
        onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      h('input', { placeholder: 'City', value: city, style: 'max-width:160px', oninput: (e) => city = e.target.value,
        onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      h('select', { style: 'max-width:120px', onchange: (e) => stateCode = e.target.value },
        h('option', { value: '' }, 'Any state'),
        US_STATE_CODES.map((s) => h('option', { value: s, selected: stateCode === s }, s))
      )
    ),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('label', { style: 'display:flex;align-items:center;gap:6px;margin:0;font-weight:400;color:var(--text)' },
        h('input', { type: 'checkbox', style: 'width:auto', onchange: (e) => emergency = e.target.checked }), 'Emergency/last-minute available only'),
      h('input', { type: 'number', min: 1, placeholder: 'Miles', value: radius, style: 'max-width:90px', oninput: (e) => radius = e.target.value }),
      h('button', { type: 'button', class: 'secondary', title: 'Radius is approximate — distance is measured to the center of each musician\'s state, not their exact address.', onclick: useMyLocation }, 'Search near me'),
      locationStatus,
      h('button', { onclick: doSearch }, 'Search')
    )
  );
  wrap.appendChild(searchRow);

  const grid = h('div', { class: 'grid' });
  if (!state.musicians.length) {
    grid.appendChild(h('div', { class: 'empty-state' }, 'No musicians found. Try a different search.'));
  }
  state.musicians.forEach((p) => {
    grid.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, p.stageName || p.name),
        p.emergencyAvailable ? h('span', { class: 'badge emergency' }, 'Emergency OK') : null),
      h('p', { class: 'muted' }, [p.city, p.state].filter(Boolean).join(', ') || 'Location not set'),
      h('div', { class: 'pill-row' }, (p.instruments || []).slice(0, 4).map((i) => h('span', { class: 'pill' }, i))),
      h('p', {}, `${money(p.hourlyRate)}/hr`),
      h('p', { class: 'stars' }, stars(p.avgRating)),
      p.idVerified ? h('span', { class: 'badge' }, '✓ ID Verified') : null,
      h('div', { style: 'margin-top:10px' }, h('button', { onclick: () => navigate('musicianDetail', { id: p.id }) }, 'View profile'))
    ));
  });
  wrap.appendChild(grid);
  wrap.appendChild(StageLightsBand());
  return wrap;
}

/* ================= MUSICIAN DETAIL ================= */
function MusicianDetailPage() {
  const detail = state.params.detail;
  if (!detail) return h('p', {}, 'Loading...');
  const p = detail.profile;
  const wrap = h('div', {});
  wrap.appendChild(h('button', { class: 'secondary', onclick: () => navigate('home') }, '← Back to search'));
  wrap.appendChild(h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'row between' },
      h('h1', {}, p.stageName || p.name),
      h('div', {}, p.idVerified ? h('span', { class: 'badge' }, '✓ ID Verified') : null,
        p.emergencyAvailable ? h('span', { class: 'badge emergency' }, ' Emergency OK') : null)),
    h('p', { class: 'muted' }, [p.city, p.state].filter(Boolean).join(', ') || 'Location not set'),
    h('p', { class: 'stars' }, stars(p.avgRating), ` · ${p.reviewCount} review(s)`),
    h('p', {}, p.bio || 'No bio provided yet.'),
    h('div', { class: 'pill-row' }, (p.instruments || []).map((i) => h('span', { class: 'pill' }, i)), (p.genres || []).map((g) => h('span', { class: 'pill' }, g))),
    h('h2', { style: 'margin-top:16px' }, `${money(p.hourlyRate)}/hr`),
    p.hasInsurance ? h('p', { class: 'muted' }, '🛡️ Self-reported liability insurance') : null,
    p.strikes > 0 ? h('p', { class: 'muted' }, `⚠️ ${p.strikes} no-show strike(s) on record`) : null,
    h('div', { class: 'safety-notice' },
      '⚠️ Before you hire: confirm this is really the person you think you\'re booking. Check their reviews, verify their identity, message them through Musician Connect first, and never send payment outside the platform. Report anything that feels off.'),
    (state.user && state.user.role === 'client') ? h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: () => openBookingModal(p) }, 'Request to hire'),
      h('button', { class: 'secondary', onclick: () => toggleFavorite(p.id) }, 'Favorite'),
      h('button', { class: 'secondary', onclick: () => openReportModal({ reportedMusicianProfileId: p.id }) }, 'Report')
    ) : (!state.user ? h('p', { class: 'muted' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('login'); } }, 'Log in as a client'), ' to request booking.') : null)
  ));

  if (detail.backups && detail.backups.length) {
    wrap.appendChild(h('div', { class: 'card' }, h('h2', {}, 'Designated backup musicians'),
      h('div', { class: 'grid' }, detail.backups.map((b) => h('div', { class: 'card' },
        h('h3', {}, b.stageName || b.name), h('p', {}, `${money(b.hourlyRate)}/hr`),
        h('button', { onclick: () => navigate('musicianDetail', { id: b.id }) }, 'View'))))));
  }

  wrap.appendChild(h('div', { class: 'card' }, h('h2', {}, 'Reviews'),
    detail.reviews.length ? detail.reviews.map((r) => h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--border)' },
      h('div', { class: 'stars' }, '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)),
      h('p', {}, r.comment || ''), h('p', { class: 'muted' }, `— ${r.clientName}`)))
      : h('p', { class: 'muted' }, 'No reviews yet.')));

  return wrap;
}

async function toggleFavorite(profileId) {
  try {
    const r = await api('POST', `/api/favorites/${profileId}`);
    showBanner('success', r.favorited ? 'Added to favorites' : 'Removed from favorites');
  } catch (err) { showBanner('error', err.message); }
}

function openBookingModal(profile) {
  const v = { eventDate: '', eventTime: '', durationHours: 2, location: '', offeredRate: profile.hourlyRate, isEmergency: false, isGroup: false, groupDetails: '' };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  const modal = h('div', { class: 'modal' },
    h('h2', {}, `Request to hire ${profile.stageName || profile.name}`),
    h('div', { class: 'safety-notice' },
      '⚠️ Make sure this is the right person before you send this request — check reviews and ID verification, and keep all communication and payment on Musician Connect.'),
    h('label', {}, 'Event date'), h('input', { type: 'date', required: true, oninput: (e) => v.eventDate = e.target.value }),
    h('label', {}, 'Event time (optional)'), h('input', { type: 'time', oninput: (e) => v.eventTime = e.target.value }),
    h('label', {}, 'Duration (hours)'), h('input', { type: 'number', min: 0.5, step: 0.5, value: 2, oninput: (e) => v.durationHours = e.target.value }),
    h('label', {}, 'Location'), h('input', { oninput: (e) => v.location = e.target.value }),
    h('label', {}, 'Your offer ($/hr)'), h('input', { type: 'number', value: profile.hourlyRate, oninput: (e) => v.offeredRate = e.target.value }),
    profile.emergencyAvailable ? h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text)' },
      h('input', { type: 'checkbox', style: 'width:auto', onchange: (e) => v.isEmergency = e.target.checked }), 'This is an emergency / last-minute booking') : null,
    h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text)' },
      h('input', { type: 'checkbox', style: 'width:auto', onchange: (e) => v.isGroup = e.target.checked }), 'This is a group booking'),
    h('label', {}, 'Group details (if applicable)'), h('input', { oninput: (e) => v.groupDetails = e.target.value }),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', { onclick: async () => {
        try {
          await api('POST', '/api/bookings', { musicianProfileId: profile.id, ...v });
          close();
          navigate('clientDashboard', {}, { type: 'success', message: 'Booking request sent!' });
        } catch (err) { showBanner('error', err.message); }
      } }, 'Send request'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))
  );
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function openReportModal(target) {
  let reason = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, 'Report to Trust & Safety'),
    h('label', {}, 'What happened?'),
    h('textarea', { rows: 4, oninput: (e) => reason = e.target.value }),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: async () => {
        try { await api('POST', '/api/reports', { ...target, reason }); close(); showBanner('success', 'Report submitted. Our team will review it.'); }
        catch (err) { showBanner('error', err.message); }
      } }, 'Submit report'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
}

function openDisputeModal(target) {
  let reason = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, 'File a dispute'),
    h('label', {}, 'Describe the issue'),
    h('textarea', { rows: 4, oninput: (e) => reason = e.target.value }),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: async () => {
        try { await api('POST', '/api/disputes', { ...target, reason }); close(); showBanner('success', 'Dispute filed. An admin will review it.'); }
        catch (err) { showBanner('error', err.message); }
      } }, 'File dispute'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
}

function openCounterRespondModal(booking) {
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, 'Counter-offer received'),
    h('p', {}, `The musician countered at ${money(booking.counterRate)}/hr for ${booking.eventDate}.`),
    booking.counterNote ? h('p', { class: 'muted' }, `"${booking.counterNote}"`) : null,
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: async () => { await bookingAction(booking.id, '/counter-response', { action: 'accept' }); close(); } }, 'Accept counter'),
      h('button', { class: 'danger', onclick: async () => { await bookingAction(booking.id, '/counter-response', { action: 'decline' }); close(); } }, 'Decline'))));
  document.body.appendChild(backdrop);
}

function openRespondModal(booking) {
  let counterRate = booking.offeredRate, counterNote = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, `Booking request — ${booking.eventDate}`),
    h('p', {}, `Offered: ${money(booking.offeredRate)}/hr × ${booking.durationHours}hr, ${booking.location || 'location TBD'}`),
    booking.isEmergency ? h('p', {}, h('span', { class: 'badge emergency' }, 'EMERGENCY')) : null,
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { onclick: async () => { await bookingAction(booking.id, '/respond', { action: 'accept' }); close(); } }, 'Accept'),
      h('button', { class: 'danger', onclick: async () => { await bookingAction(booking.id, '/respond', { action: 'decline' }); close(); } }, 'Decline')),
    h('h3', { style: 'margin-top:16px' }, 'Or counter-offer'),
    h('label', {}, 'Your rate ($/hr)'), h('input', { type: 'number', value: booking.offeredRate, oninput: (e) => counterRate = e.target.value }),
    h('label', {}, 'Note (optional)'), h('input', { oninput: (e) => counterNote = e.target.value }),
    h('button', { class: 'secondary', style: 'margin-top:10px', onclick: async () => { await bookingAction(booking.id, '/respond', { action: 'counter', counterRate, counterNote }); close(); } }, 'Send counter-offer'),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'secondary', onclick: close }, 'Close'))));
  document.body.appendChild(backdrop);
}

async function bookingAction(id, path, body) {
  try {
    await api('POST', `/api/bookings/${id}${path}`, body);
    showBanner('success', 'Done.');
    loadPageData();
  } catch (err) { showBanner('error', err.message); }
}

function openNoShowModal(booking, defaultParty) {
  let party = defaultParty, report = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, 'Report a no-show'),
    h('label', {}, 'Who failed to show?'),
    h('select', { onchange: (e) => party = e.target.value },
      h('option', { value: 'musician', selected: defaultParty === 'musician' }, 'The musician'),
      h('option', { value: 'client', selected: defaultParty === 'client' }, 'The client')),
    h('label', {}, 'What happened?'),
    h('textarea', { rows: 3, oninput: (e) => report = e.target.value }),
    h('p', { class: 'muted' }, 'Musician no-show: client is refunded in full and the musician forfeits the platform fee and receives a strike. Client no-show: no refund is owed; the musician may invoice separately.'),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { onclick: async () => { await bookingAction(booking.id, '/no-show', { party, report }); close(); } }, 'Submit report'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
}

function openReviewModal(booking) {
  let rating = 5, comment = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, 'Leave a review'),
    h('label', {}, 'Rating'),
    h('select', { onchange: (e) => rating = e.target.value }, [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, `${n} star${n > 1 ? 's' : ''}`))),
    h('label', {}, 'Comment'),
    h('textarea', { rows: 3, oninput: (e) => comment = e.target.value }),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { onclick: async () => {
        try { await api('POST', `/api/bookings/${booking.id}/review`, { rating, comment }); close(); showBanner('success', 'Review posted.'); loadPageData(); }
        catch (err) { showBanner('error', err.message); }
      } }, 'Submit review'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
}

function BookingCard(booking, viewerRole) {
  const actions = [];
  if (viewerRole === 'musician' && booking.status === 'pending') actions.push(h('button', { onclick: () => openRespondModal(booking) }, 'Respond'));
  if (viewerRole === 'client' && booking.status === 'countered') actions.push(h('button', { onclick: () => openCounterRespondModal(booking) }, 'View counter-offer'));
  if (booking.status === 'accepted') {
    actions.push(h('button', { class: 'secondary', onclick: () => bookingAction(booking.id, '/complete', {}) }, 'Mark completed'));
    actions.push(h('button', { class: 'secondary', onclick: () => openNoShowModal(booking, viewerRole === 'client' ? 'musician' : 'client') }, 'Report no-show'));
    actions.push(h('button', { class: 'danger', onclick: () => { const reason = prompt('Reason for cancelling?') || ''; bookingAction(booking.id, '/cancel', { reason }); } }, 'Cancel'));
  }
  if (viewerRole === 'client' && booking.status === 'completed') actions.push(h('button', { onclick: () => openReviewModal(booking) }, 'Leave review'));
  actions.push(h('button', { class: 'secondary', onclick: () => openDisputeModal({ bookingId: booking.id }) }, 'File dispute'));

  return h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('h3', {}, `${booking.eventDate}${booking.eventTime ? ' · ' + booking.eventTime : ''}`),
      h('span', { class: `badge ${booking.status}` }, statusLabel(booking.status))),
    booking.isEmergency ? h('span', { class: 'badge emergency' }, 'EMERGENCY') : null,
    booking.isGroup ? h('span', { class: 'badge' }, 'GROUP') : null,
    h('p', {}, `${money(booking.offeredRate)}/hr × ${booking.durationHours}hr — total ${money(booking.total)} (incl. ${money(booking.serviceFee)} service fee)`),
    booking.location ? h('p', { class: 'muted' }, booking.location) : null,
    booking.status === 'countered' ? h('p', { class: 'muted' }, `Counter-offer: ${money(booking.counterRate)}/hr`) : null,
    booking.noShowReport ? h('p', { class: 'muted' }, `No-show report: ${booking.noShowReport}`) : null,
    h('div', { class: 'row', style: 'margin-top:8px' }, actions));
}

/* ================= CLIENT DASHBOARD ================= */
let clientData = { bookings: [], rentals: [], favorites: [] };
async function loadClientDashboardData() {
  const [b, r, f] = await Promise.all([
    api('GET', '/api/bookings/mine'),
    api('GET', '/api/rentals/mine'),
    api('GET', '/api/favorites/mine'),
  ]);
  clientData = { bookings: b.bookings, rentals: r.rentals, favorites: f.profiles };
}

function ClientDashboardPage() {
  const tab = state.params.tab || 'bookings';
  const wrap = h('div', {});
  wrap.appendChild(h('h1', {}, 'My Dashboard'));
  wrap.appendChild(Tabs([
    ['bookings', 'My Bookings'], ['rentals', 'My Rentals'], ['favorites', 'Favorites'],
  ], tab, (t) => { state.params.tab = t; render(); }));

  if (tab === 'bookings') {
    wrap.appendChild(clientData.bookings.length
      ? h('div', {}, clientData.bookings.map((b) => BookingCard(b, 'client')))
      : h('div', { class: 'empty-state' }, "You haven't requested any bookings yet."));
  } else if (tab === 'rentals') {
    wrap.appendChild(clientData.rentals.length
      ? h('div', {}, clientData.rentals.map((r) => RentalCard(r, 'client')))
      : h('div', { class: 'empty-state' }, "You haven't requested any equipment rentals yet."));
  } else if (tab === 'favorites') {
    wrap.appendChild(clientData.favorites.length
      ? h('div', { class: 'grid' }, clientData.favorites.map((p) => h('div', { class: 'card' },
          h('h3', {}, p.stageName || p.name), h('p', {}, `${money(p.hourlyRate)}/hr`),
          h('div', { class: 'row' },
            h('button', { onclick: () => navigate('musicianDetail', { id: p.id }) }, 'View'),
            h('button', { class: 'secondary', onclick: async () => { await toggleFavorite(p.id); loadPageData(); } }, 'Remove')))))
      : h('div', { class: 'empty-state' }, 'No favorites yet.'));
  }
  return wrap;
}

function Tabs(items, active, onSelect) {
  return h('div', { class: 'tabs' }, items.map(([key, label]) =>
    h('button', { class: active === key ? 'active' : '', onclick: () => onSelect(key) }, label)));
}

async function rentalAction(id, path, body) {
  try { await api('POST', `/api/rentals/${id}${path}`, body || {}); showBanner('success', 'Done.'); loadPageData(); }
  catch (err) { showBanner('error', err.message); }
}

function RentalCard(r, viewerRole) {
  const actions = [];
  if (viewerRole === 'owner' && r.status === 'pending') {
    actions.push(h('button', { onclick: () => rentalAction(r.id, '/respond', { action: 'accept' }) }, 'Accept'));
    actions.push(h('button', { class: 'danger', onclick: () => rentalAction(r.id, '/respond', { action: 'decline' }) }, 'Decline'));
  }
  if (r.status === 'accepted') {
    actions.push(h('button', { class: 'secondary', onclick: () => rentalAction(r.id, '/complete') }, 'Mark completed'));
    actions.push(h('button', { class: 'danger', onclick: () => rentalAction(r.id, '/cancel') }, 'Cancel'));
  }
  if (r.status === 'pending' && viewerRole === 'client') actions.push(h('button', { class: 'danger', onclick: () => rentalAction(r.id, '/cancel') }, 'Cancel request'));
  actions.push(h('button', { class: 'secondary', onclick: () => openDisputeModal({ rentalId: r.id }) }, 'File dispute'));

  return h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('h3', {}, `${r.startDate} → ${r.endDate} (${r.days} day${r.days > 1 ? 's' : ''})`),
      h('span', { class: `badge ${r.status}` }, statusLabel(r.status))),
    h('p', {}, `${money(r.dailyRate)}/day — rental ${money(r.rentalFee)} + service fee ${money(r.serviceFee)} + refundable deposit ${money(r.deposit)} = total ${money(r.total)}`),
    h('div', { class: 'row', style: 'margin-top:8px' }, actions));
}

/* ================= MUSICIAN DASHBOARD ================= */
let musicianData = { bookings: [] };
async function loadMusicianDashboardData() {
  const b = await api('GET', '/api/bookings/mine');
  musicianData = { bookings: b.bookings };
}

function MusicianDashboardPage() {
  const tab = state.params.tab || 'profile';
  const wrap = h('div', {});
  wrap.appendChild(h('h1', {}, 'My Dashboard'));
  wrap.appendChild(Tabs([['profile', 'My Profile'], ['bookings', 'Incoming Bookings']], tab, (t) => { state.params.tab = t; render(); }));

  if (tab === 'profile') wrap.appendChild(MusicianProfileForm());
  else wrap.appendChild(musicianData.bookings.length
    ? h('div', {}, musicianData.bookings.map((b) => BookingCard(b, 'musician')))
    : h('div', { class: 'empty-state' }, 'No booking requests yet.'));
  return wrap;
}

function MusicianProfileForm() {
  const p = state.musicianProfile || {};
  const v = {
    stageName: p.stageName || '', bio: p.bio || '', hourlyRate: p.hourlyRate || 0,
    city: p.city || '', state: p.state || '', emergencyAvailable: !!p.emergencyAvailable, hasInsurance: !!p.hasInsurance,
    instruments: (p.instruments || []).join(', '), genres: (p.genres || []).join(', '),
  };
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const data = await api('POST', '/api/musicians/profile', {
        ...v,
        hourlyRate: parseFloat(v.hourlyRate) || 0,
        instruments: v.instruments.split(',').map((s) => s.trim()).filter(Boolean),
        genres: v.genres.split(',').map((s) => s.trim()).filter(Boolean),
      });
      state.musicianProfile = data.profile;
      showBanner('success', 'Profile updated.');
      render();
    } catch (err) { showBanner('error', err.message); }
  } },
    h('h2', {}, 'Edit profile'),
    p.idVerified ? h('span', { class: 'badge' }, '✓ ID Verified') :
      h('button', { type: 'button', class: 'secondary', onclick: async () => { const d = await api('POST', '/api/musicians/verify-id'); state.musicianProfile = d.profile; render(); showBanner('success', 'ID verified (demo).'); } }, 'Verify my ID (demo)'),
    h('label', {}, 'Stage name'), h('input', { value: v.stageName, oninput: (e) => v.stageName = e.target.value }),
    h('label', {}, 'Bio'), h('textarea', { rows: 3, oninput: (e) => v.bio = e.target.value }, v.bio),
    h('label', {}, 'Hourly rate ($)'), h('input', { type: 'number', value: v.hourlyRate, oninput: (e) => v.hourlyRate = e.target.value }),
    h('label', {}, 'City'), h('input', { value: v.city, oninput: (e) => v.city = e.target.value }),
    h('label', {}, 'State (2-letter, e.g. GA)'), h('input', { value: v.state, maxlength: 2, oninput: (e) => v.state = e.target.value.toUpperCase() }),
    h('label', {}, 'Instruments (comma-separated)'), h('input', { value: v.instruments, oninput: (e) => v.instruments = e.target.value }),
    h('label', {}, 'Genres (comma-separated)'), h('input', { value: v.genres, oninput: (e) => v.genres = e.target.value }),
    h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text)' },
      h('input', { type: 'checkbox', style: 'width:auto', checked: v.emergencyAvailable, onchange: (e) => v.emergencyAvailable = e.target.checked }), 'Available for emergency / last-minute bookings'),
    h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text)' },
      h('input', { type: 'checkbox', style: 'width:auto', checked: v.hasInsurance, onchange: (e) => v.hasInsurance = e.target.checked }), 'I carry liability insurance (self-reported)'),
    h('div', { style: 'margin-top:14px' }, h('button', { type: 'submit' }, 'Save profile'))
  );
  return form;
}

/* ================= EQUIPMENT OWNER DASHBOARD ================= */
let ownerData = { equipment: [], rentals: [] };
async function loadOwnerDashboardData() {
  const [e, r] = await Promise.all([api('GET', '/api/equipment/mine'), api('GET', '/api/rentals/mine')]);
  ownerData = { equipment: e.equipment, rentals: r.rentals };
}

function OwnerDashboardPage() {
  const tab = state.params.tab || 'profile';
  const wrap = h('div', {});
  wrap.appendChild(h('h1', {}, 'My Dashboard'));
  wrap.appendChild(Tabs([['profile', 'My Profile'], ['listings', 'My Listings'], ['rentals', 'Incoming Rentals']], tab, (t) => { state.params.tab = t; render(); }));

  if (tab === 'profile') wrap.appendChild(OwnerProfileForm());
  else if (tab === 'listings') wrap.appendChild(OwnerListingsSection());
  else wrap.appendChild(ownerData.rentals.length
    ? h('div', {}, ownerData.rentals.map((r) => RentalCard(r, 'owner')))
    : h('div', { class: 'empty-state' }, 'No rental requests yet.'));
  return wrap;
}

function OwnerProfileForm() {
  const p = state.equipmentOwnerProfile || {};
  const v = { businessName: p.businessName || '', bio: p.bio || '', city: p.city || '', state: p.state || '' };
  return h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const data = await api('POST', '/api/equipment-owner/profile', v);
      state.equipmentOwnerProfile = { ...state.equipmentOwnerProfile, ...data.profile };
      showBanner('success', 'Profile updated.');
      render();
    } catch (err) { showBanner('error', err.message); }
  } },
    h('h2', {}, 'Edit business profile'),
    p.idVerified ? h('span', { class: 'badge' }, '✓ ID Verified') :
      h('button', { type: 'button', class: 'secondary', onclick: async () => { await api('POST', '/api/equipment-owner/verify-id'); state.equipmentOwnerProfile.idVerified = true; render(); showBanner('success', 'ID verified (demo).'); } }, 'Verify my ID (demo)'),
    h('label', {}, 'Business name'), h('input', { value: v.businessName, oninput: (e) => v.businessName = e.target.value }),
    h('label', {}, 'Bio'), h('textarea', { rows: 3, oninput: (e) => v.bio = e.target.value }, v.bio),
    h('label', {}, 'City'), h('input', { value: v.city, oninput: (e) => v.city = e.target.value }),
    h('label', {}, 'State'), h('input', { value: v.state, maxlength: 2, oninput: (e) => v.state = e.target.value.toUpperCase() }),
    h('div', { style: 'margin-top:14px' }, h('button', { type: 'submit' }, 'Save profile')));
}

function OwnerListingsSection() {
  const wrap = h('div', {});
  wrap.appendChild(h('div', { class: 'card' }, h('h2', {}, 'Add new listing'), NewEquipmentForm()));
  wrap.appendChild(h('div', { class: 'grid' }, ownerData.equipment.map((eq) => h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, eq.title), h('span', { class: 'badge' }, eq.category)),
    h('p', {}, eq.description),
    h('p', {}, `${money(eq.dailyRate)}/day · deposit ${money(eq.securityDeposit)}`),
    h('p', { class: 'muted' }, eq.available ? 'Available' : 'Unavailable'),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'secondary', onclick: async () => { await api('PATCH', `/api/equipment/${eq.id}`, { available: !eq.available }); loadPageData(); } }, eq.available ? 'Mark unavailable' : 'Mark available'),
      h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this listing?')) { await api('DELETE', `/api/equipment/${eq.id}`); loadPageData(); } } }, 'Delete'))))));
  return wrap;
}

function NewEquipmentForm() {
  const v = { title: '', category: '', description: '', dailyRate: '', securityDeposit: '' };
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/equipment', v);
      showBanner('success', 'Listing created.');
      form.reset();
      loadPageData();
    } catch (err) { showBanner('error', err.message); }
  } },
    h('label', {}, 'Title'), h('input', { required: true, oninput: (e) => v.title = e.target.value }),
    h('label', {}, 'Category (e.g. Speaker, Microphone, Drum Kit, DJ Controller, Lighting)'), h('input', { required: true, oninput: (e) => v.category = e.target.value }),
    h('label', {}, 'Description'), h('textarea', { rows: 2, oninput: (e) => v.description = e.target.value }),
    h('label', {}, 'Daily rate ($)'), h('input', { type: 'number', required: true, min: 0.01, step: 0.01, oninput: (e) => v.dailyRate = e.target.value }),
    h('label', {}, 'Security deposit ($)'), h('input', { type: 'number', min: 0, step: 0.01, oninput: (e) => v.securityDeposit = e.target.value }),
    h('div', { style: 'margin-top:12px' }, h('button', { type: 'submit' }, 'Add listing')));
  return form;
}

/* ================= EQUIPMENT BROWSE / DETAIL ================= */
function EquipmentBrowsePage() {
  let category = '', maxDaily = '', q = state.params.q || '';
  const wrap = h('div', {});
  wrap.appendChild(Hero('🎧', 'Rent equipment', 'Speakers, microphones, drum kits, DJ gear, lighting, and more.'));
  wrap.appendChild(h('div', { class: 'card row' },
    h('input', { placeholder: 'Search equipment...', value: q, style: 'flex:1;min-width:200px', oninput: (e) => q = e.target.value }),
    h('input', { placeholder: 'Category', style: 'max-width:160px', oninput: (e) => category = e.target.value }),
    h('input', { placeholder: 'Max $/day', type: 'number', style: 'max-width:120px', oninput: (e) => maxDaily = e.target.value }),
    h('button', { onclick: () => {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q); if (category) qs.set('category', category); if (maxDaily) qs.set('maxDaily', maxDaily);
      state.params.q = q;
      state.params.qs = qs.toString() ? `?${qs}` : '';
      loadPageData();
    } }, 'Search')));

  const grid = h('div', { class: 'grid' });
  if (!state.equipmentList.length) grid.appendChild(h('div', { class: 'empty-state' }, 'No equipment found.'));
  state.equipmentList.forEach((eq) => {
    grid.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, eq.title), h('span', { class: 'badge' }, eq.category)),
      h('p', { class: 'muted' }, [eq.ownerCity, eq.ownerState].filter(Boolean).join(', ') || eq.ownerBusinessName),
      h('p', {}, `${money(eq.dailyRate)}/day`),
      h('p', { class: 'muted' }, `Refundable deposit: ${money(eq.securityDeposit)}`),
      h('button', { onclick: () => navigate('equipmentDetail', { id: eq.id }) }, 'View & request')));
  });
  wrap.appendChild(grid);
  return wrap;
}

function EquipmentDetailPage() {
  const eq = state.params.detail;
  if (!eq) return h('p', {}, 'Loading...');
  const wrap = h('div', {});
  wrap.appendChild(h('button', { class: 'secondary', onclick: () => navigate('equipmentBrowse') }, '← Back'));
  wrap.appendChild(h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'row between' }, h('h1', {}, eq.title), h('span', { class: 'badge' }, eq.category)),
    h('p', { class: 'muted' }, `Listed by ${eq.ownerBusinessName}${eq.ownerIdVerified ? ' · ✓ ID Verified' : ''}`),
    h('p', {}, eq.description),
    h('h2', {}, `${money(eq.dailyRate)}/day`),
    h('p', { class: 'muted' }, `Refundable security deposit: ${money(eq.securityDeposit)}`),
    (state.user && state.user.role === 'client') ? h('button', { onclick: () => openRentalModal(eq) }, 'Request to rent') :
      (!state.user ? h('p', { class: 'muted' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('login'); } }, 'Log in as a client'), ' to request a rental.') : null)));
  return wrap;
}

function openRentalModal(eq) {
  const v = { startDate: '', endDate: '' };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  const estimate = h('p', { class: 'muted' }, '');
  function updateEstimate() {
    if (v.startDate && v.endDate) {
      const days = Math.round((new Date(v.endDate) - new Date(v.startDate)) / 86400000) + 1;
      if (days > 0) {
        const rentalFee = eq.dailyRate * days;
        const serviceFee = Math.round(rentalFee * 0.10 * 100) / 100;
        const total = Math.round((rentalFee + serviceFee + eq.securityDeposit) * 100) / 100;
        estimate.textContent = `${days} day(s): ${money(rentalFee)} rental + ${money(serviceFee)} service fee + ${money(eq.securityDeposit)} deposit = ${money(total)}`;
        return;
      }
    }
    estimate.textContent = '';
  }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, `Rent "${eq.title}"`),
    h('label', {}, 'Start date'), h('input', { type: 'date', required: true, oninput: (e) => { v.startDate = e.target.value; updateEstimate(); } }),
    h('label', {}, 'End date'), h('input', { type: 'date', required: true, oninput: (e) => { v.endDate = e.target.value; updateEstimate(); } }),
    estimate,
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: async () => {
        try { await api('POST', '/api/rentals', { equipmentId: eq.id, ...v }); close(); navigate('clientDashboard', { tab: 'rentals' }, { type: 'success', message: 'Rental request sent!' }); }
        catch (err) { showBanner('error', err.message); }
      } }, 'Send request'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
}

/* ================= NOTIFICATIONS ================= */
function NotificationsPage() {
  const wrap = h('div', {});
  wrap.appendChild(h('div', { class: 'row between' }, h('h1', {}, 'Notifications'),
    state.notifications.some((n) => !n.read) ? h('button', { class: 'secondary', onclick: async () => { await api('POST', '/api/notifications/read-all'); loadPageData(); } }, 'Mark all read') : null));
  wrap.appendChild(h('div', { class: 'card' }, state.notifications.length
    ? state.notifications.map((n) => h('div', { class: `notif-item ${n.read ? '' : 'unread'}`, onclick: async () => { if (!n.read) { await api('POST', `/api/notifications/${n.id}/read`); loadPageData(); } } },
        !n.read ? h('span', { class: 'notif-dot' }) : null, n.message, h('div', { class: 'muted' }, n.createdAt)))
    : h('div', { class: 'empty-state' }, 'No notifications yet.')));
  return wrap;
}

/* ================= ADMIN ================= */
let adminData = { users: [], reports: [], disputes: [] };
async function loadAdminData() {
  const [u, r, d] = await Promise.all([
    api('GET', '/api/admin/users'), api('GET', '/api/admin/reports'), api('GET', '/api/admin/disputes'),
  ]);
  adminData = { users: u.users, reports: r.reports, disputes: d.disputes };
}

function AdminPage() {
  const tab = state.params.tab || 'users';
  const wrap = h('div', {});
  wrap.appendChild(h('h1', {}, 'Admin'));
  wrap.appendChild(Tabs([['users', 'Users'], ['reports', 'Reports'], ['disputes', 'Disputes']], tab, (t) => { state.params.tab = t; render(); }));

  if (tab === 'users') {
    wrap.appendChild(h('div', {}, adminData.users.map((u) => h('div', { class: 'card row between' },
      h('div', {}, h('h3', {}, `${u.name} (${u.role})`), h('p', { class: 'muted' }, u.email),
        u.suspended ? h('span', { class: 'badge declined' }, `Suspended: ${u.suspensionReason || ''}`) : h('span', { class: 'badge accepted' }, 'Active')),
      u.role === 'admin' ? null : (u.suspended
        ? h('button', { onclick: async () => { await api('POST', `/api/admin/users/${u.id}/reinstate`); loadPageData(); } }, 'Reinstate')
        : h('button', { class: 'danger', onclick: async () => { const reason = prompt('Reason for suspension?') || 'Policy violation'; await api('POST', `/api/admin/users/${u.id}/suspend`, { reason }); loadPageData(); } }, 'Suspend'))))));
  } else if (tab === 'reports') {
    wrap.appendChild(adminData.reports.length ? h('div', {}, adminData.reports.map((r) => h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, `Report #${r.id}`), h('span', { class: `badge ${r.status === 'open' ? 'pending' : 'accepted'}` }, r.status)),
      h('p', {}, r.reason), h('p', { class: 'muted' }, `From ${r.reporterName}${r.reportedUserName ? ' about ' + r.reportedUserName : ''}`),
      r.status === 'open' ? h('button', { class: 'secondary', onclick: async () => { await api('POST', `/api/admin/reports/${r.id}/resolve`); loadPageData(); } }, 'Mark resolved') : null)))
      : h('div', { class: 'empty-state' }, 'No reports.'));
  } else {
    wrap.appendChild(adminData.disputes.length ? h('div', {}, adminData.disputes.map((d) => {
      let resolution = '';
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', {}, `Dispute #${d.id}`), h('span', { class: `badge ${d.status === 'open' ? 'pending' : 'accepted'}` }, d.status)),
        h('p', {}, d.reason), h('p', { class: 'muted' }, `Filed by ${d.filedByName}`),
        d.resolution ? h('p', { class: 'muted' }, `Resolution: ${d.resolution}`) : null,
        d.status === 'open' ? h('div', { class: 'row' },
          h('input', { placeholder: 'Resolution notes', style: 'flex:1', oninput: (e) => resolution = e.target.value }),
          h('button', { onclick: async () => { await api('POST', `/api/admin/disputes/${d.id}/resolve`, { resolution }); loadPageData(); } }, 'Resolve')) : null);
    })) : h('div', { class: 'empty-state' }, 'No disputes.'));
  }
  return wrap;
}

/* ================= INIT ================= */
async function init() {
  try { await refreshMe(); await refreshNotifications(); } catch (e) { /* not logged in */ }
  render();
  loadPageData();
}
init();

// Register the service worker so the app installs on Android/iOS home
// screens (PWA) and the shell keeps working on a flaky connection. The API
// itself is never cached — see sw.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  });
}
