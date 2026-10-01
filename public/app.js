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
  jobs: [],
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

// Profile picture — an <img> when one's set, otherwise a colored circle with
// initials, used consistently in browse cards, detail pages, and the
// dashboard's own upload preview. sizeClass picks a CSS size (see
// .avatar-sm/.avatar-md/.avatar-lg in styles.css); defaults to medium.
function Avatar(name, url, sizeClass) {
  const cls = `avatar ${sizeClass || 'avatar-md'}`;
  if (url) return h('img', { src: url, class: cls, alt: name ? `${name}'s profile photo` : 'Profile photo' });
  const initials = String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return h('div', { class: `${cls} avatar-placeholder` }, initials || '?');
}

// Full-width rectangular photo for the browse-grid listing cards — the
// AirGigs-style "thumbnail at the top of the card" look, distinct from the
// circular Avatar used on detail/dashboard pages. Falls back to a large
// music-note glyph (rather than initials) when no photo is set, since at
// this size initials read as an odd little logo instead of a placeholder.
function CardPhoto(url, alt) {
  if (url) return h('img', { src: url, class: 'card-photo', alt: alt || 'Photo' });
  return h('div', { class: 'card-photo card-photo-placeholder' }, '🎵');
}

// Reads a File as a base64 string (no data: prefix) for the JSON-upload
// endpoints (photo-upload, demo-upload) — this app has zero npm
// dependencies, so JSON base64 avoids needing a multipart/form-data parser.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

// Shared "profile photo" upload widget used by both the musician and
// equipment-owner dashboard forms: a live preview plus file input, wired up
// by the caller's own uploading/status state and upload/remove functions so
// each form keeps its own local (non-global-re-render) status — same reason
// the demo-clip uploader below uses inline status instead of showBanner.
function PhotoUploadField(name, url, uploading, status, onFile, onRemove) {
  return h('div', { class: 'avatar-upload-row' },
    Avatar(name, url, 'avatar-lg'),
    h('div', {},
      h('input', { type: 'file', accept: 'image/*', disabled: uploading,
        onchange: (e) => { onFile(e.target.files[0]); e.target.value = ''; } }),
      uploading ? h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Uploading…') : null,
      status ? h('p', { class: status.type === 'error' ? 'error-box' : 'success-box', style: 'margin:6px 0 0' }, status.message) : null,
      (url && !uploading) ? h('button', { type: 'button', class: 'secondary', style: 'margin-top:8px', onclick: onRemove }, 'Remove photo') : null
    )
  );
}

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
  links.push(h('button', { class: state.page === 'home' ? 'active' : '', onclick: () => navigate('home') }, 'Find Talent'));
  links.push(h('button', { class: state.page === 'equipmentBrowse' ? 'active' : '', onclick: () => navigate('equipmentBrowse') }, 'Rent Equipment'));
  links.push(h('button', { class: state.page === 'jobsBrowse' ? 'active' : '', onclick: () => navigate('jobsBrowse') }, 'Job Postings'));

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
    links.push(h('button', { class: state.page === 'account' ? 'active' : '', onclick: () => navigate('account') }, 'Account'));
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
    case 'forgotPassword': return ForgotPasswordPage();
    case 'resetPassword': return ResetPasswordPage();
    case 'musicianDetail': return MusicianDetailPage();
    case 'clientDashboard': return ClientDashboardPage();
    case 'musicianDashboard': return MusicianDashboardPage();
    case 'ownerDashboard': return OwnerDashboardPage();
    case 'equipmentBrowse': return EquipmentBrowsePage();
    case 'equipmentDetail': return EquipmentDetailPage();
    case 'jobsBrowse': return BrowseJobsPage();
    case 'jobDetail': return JobDetailPage();
    case 'admin': return AdminPage();
    case 'notifications': return NotificationsPage();
    case 'account': return AccountPage();
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
    } else if (state.page === 'jobsBrowse') {
      const data = await api('GET', '/api/jobs' + (state.params.qs || ''));
      state.jobs = data.jobs;
      render();
    } else if (state.page === 'jobDetail') {
      const data = await api('GET', `/api/jobs/${state.params.id}`);
      state.params.detail = data;
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
    h('p', { class: 'muted', style: 'margin-top:14px' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('forgotPassword'); } }, 'Forgot password?')),
    h('p', { class: 'muted', style: 'margin-top:6px' }, "Don't have an account? ",
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('signup'); } }, 'Sign up'))
  );
  return h('div', { class: 'full-bleed gradient-surface auth-shell' }, form);
}

function ForgotPasswordPage() {
  let email = '';
  let sent = false;
  const wrap = h('div', { class: 'full-bleed gradient-surface auth-shell' });
  const rerender = () => { clear(wrap); wrap.appendChild(build()); };
  function build() {
    if (sent) {
      return h('div', { class: 'card center-form' },
        h('h1', {}, 'Check your email'),
        h('p', { class: 'muted' }, 'If an account exists for that email, we just sent a link to reset the password. It expires in 1 hour.'),
        h('div', { style: 'margin-top:18px' }, h('button', { onclick: () => navigate('login') }, 'Back to log in')));
    }
    return h('form', { class: 'card center-form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/auth/forgot-password', { email });
        sent = true;
        rerender();
      } catch (err) { showBanner('error', err.message); }
    } },
      h('h1', {}, 'Reset your password'),
      h('p', { class: 'muted' }, "Enter the email on your account and we'll send you a link to set a new password."),
      h('label', {}, 'Email'),
      h('input', { type: 'email', required: true, oninput: (e) => email = e.target.value }),
      h('div', { style: 'margin-top:18px' }, h('button', { type: 'submit' }, 'Send reset link')),
      h('p', { class: 'muted', style: 'margin-top:14px' },
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('login'); } }, 'Back to log in')));
  }
  wrap.appendChild(build());
  return wrap;
}

function ResetPasswordPage() {
  const token = state.params.token;
  let password = '', confirm = '';
  if (!token) {
    return h('div', { class: 'full-bleed gradient-surface auth-shell' },
      h('div', { class: 'card center-form' },
        h('h1', {}, 'Missing reset link'),
        h('p', { class: 'muted' }, "This page needs a reset link from your email — you can't reach it directly."),
        h('div', { style: 'margin-top:18px' }, h('button', { onclick: () => navigate('forgotPassword') }, 'Request a new link'))));
  }
  const form = h('form', { class: 'card center-form', onsubmit: async (e) => {
    e.preventDefault();
    if (password !== confirm) { showBanner('error', 'Passwords do not match'); return; }
    try {
      const data = await api('POST', '/api/auth/reset-password', { token, password });
      navigate('login', {}, { type: 'success', message: data.message || 'Password updated!' });
    } catch (err) { showBanner('error', err.message); }
  } },
    h('h1', {}, 'Choose a new password'),
    h('label', {}, 'New password (min 8 characters)'),
    h('input', { type: 'password', required: true, minlength: 8, oninput: (e) => password = e.target.value }),
    h('label', {}, 'Confirm new password'),
    h('input', { type: 'password', required: true, minlength: 8, oninput: (e) => confirm = e.target.value }),
    h('div', { style: 'margin-top:18px' }, h('button', { type: 'submit' }, 'Update password'))
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
      h('option', { value: 'musician' }, 'Musician, Singer, DJ, MC & other performers'),
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

/* ---------- countries ---------- */
// Fixed list of countries for a dropdown (state/province naming varies too
// much across countries to dropdown-ify, so that field stays free text).
const COUNTRIES = [
  'United States',
  'Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria',
  'Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia',
  'Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia',
  'Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo (Congo-Brazzaville)',
  'Costa Rica','Croatia','Cuba','Cyprus','Czechia','Democratic Republic of the Congo','Denmark','Djibouti','Dominica',
  'Dominican Republic','Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia',
  'Fiji','Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea',
  'Guinea-Bissau','Guyana','Haiti','Honduras','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel',
  'Italy','Ivory Coast','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait','Kyrgyzstan','Laos',
  'Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Madagascar','Malawi',
  'Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia','Moldova',
  'Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru','Nepal','Netherlands',
  'New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman','Pakistan','Palau',
  'Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania',
  'Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino',
  'Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia',
  'Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan',
  'Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga',
  'Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates',
  'United Kingdom','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen',
  'Zambia','Zimbabwe',
];

// States/provinces for countries where we have a clean, well-known list —
// selecting one of these countries turns the State field into a dropdown of
// its real subdivisions. Any other country keeps the free-text State field,
// since province/region naming isn't standardized enough worldwide to
// dropdown-ify every country.
const STATES_BY_COUNTRY = {
  'United States': ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'],
  'Canada': ['Alberta','British Columbia','Manitoba','New Brunswick','Newfoundland and Labrador','Northwest Territories','Nova Scotia','Nunavut','Ontario','Prince Edward Island','Quebec','Saskatchewan','Yukon'],
  'United Kingdom': ['England','Scotland','Wales','Northern Ireland'],
  'Nigeria': ['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara','Federal Capital Territory (Abuja)'],
  'Ghana': ['Ahafo','Ashanti','Bono','Bono East','Central','Eastern','Greater Accra','North East','Northern','Oti','Savannah','Upper East','Upper West','Volta','Western','Western North'],
  'Kenya': ['Baringo','Bomet','Bungoma','Busia','Elgeyo-Marakwet','Embu','Garissa','Homa Bay','Isiolo','Kajiado','Kakamega','Kericho','Kiambu','Kilifi','Kirinyaga','Kisii','Kisumu','Kitui','Kwale','Laikipia','Lamu','Machakos','Makueni','Mandera','Marsabit','Meru','Migori','Mombasa',"Murang'a",'Nairobi','Nakuru','Nandi','Narok','Nyamira','Nyandarua','Nyeri','Samburu','Siaya','Taita-Taveta','Tana River','Tharaka-Nithi','Trans Nzoia','Turkana','Uasin Gishu','Vihiga','Wajir','West Pokot'],
  'South Africa': ['Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','North West','Northern Cape','Western Cape'],
  'Australia': ['Australian Capital Territory','New South Wales','Northern Territory','Queensland','South Australia','Tasmania','Victoria','Western Australia'],
  'India': ['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Andaman and Nicobar Islands','Chandigarh','Dadra and Nagar Haveli and Daman and Diu','Delhi','Jammu and Kashmir','Ladakh','Lakshadweep','Puducherry'],
  'Germany': ['Baden-Württemberg','Bavaria','Berlin','Brandenburg','Bremen','Hamburg','Hesse','Lower Saxony','Mecklenburg-Vorpommern','North Rhine-Westphalia','Rhineland-Palatinate','Saarland','Saxony','Saxony-Anhalt','Schleswig-Holstein','Thuringia'],
  'Brazil': ['Acre','Alagoas','Amapá','Amazonas','Bahia','Ceará','Distrito Federal','Espírito Santo','Goiás','Maranhão','Mato Grosso','Mato Grosso do Sul','Minas Gerais','Pará','Paraíba','Paraná','Pernambuco','Piauí','Rio de Janeiro','Rio Grande do Norte','Rio Grande do Sul','Rondônia','Roraima','Santa Catarina','São Paulo','Sergipe','Tocantins'],
  'Mexico': ['Aguascalientes','Baja California','Baja California Sur','Campeche','Chiapas','Chihuahua','Ciudad de México','Coahuila','Colima','Durango','Guanajuato','Guerrero','Hidalgo','Jalisco','México','Michoacán','Morelos','Nayarit','Nuevo León','Oaxaca','Puebla','Querétaro','Quintana Roo','San Luis Potosí','Sinaloa','Sonora','Tabasco','Tamaulipas','Tlaxcala','Veracruz','Yucatán','Zacatecas'],
  'Pakistan': ['Balochistan','Khyber Pakhtunkhwa','Punjab','Sindh','Azad Jammu and Kashmir','Gilgit-Baltistan','Islamabad Capital Territory'],
};

// Renders the State/Province field as a dropdown when we know that
// country's subdivisions, or a free-text input otherwise (covers every
// other country in COUNTRIES, plus "no country selected yet").
function StateField(country, value, onChange) {
  const options = STATES_BY_COUNTRY[country];
  if (options) {
    return h('select', { onchange: (e) => onChange(e.target.value) },
      h('option', { value: '' }, 'Select a state/province'),
      options.map((s) => h('option', { value: s, selected: value === s }, s)));
  }
  return h('input', { value, placeholder: 'State / Province / Region (optional)', oninput: (e) => onChange(e.target.value) });
}

// Major cities for state/province combos we have curated data for. This is
// necessarily a "most well-known cities" list, not exhaustive — anyone whose
// city isn't listed can pick "Other" and type it in directly (see CityField).
const CITIES_BY_STATE = {
  'United States': {
    'Alabama': ['Birmingham','Montgomery','Huntsville','Mobile','Tuscaloosa'],
    'Alaska': ['Anchorage','Fairbanks','Juneau'],
    'Arizona': ['Phoenix','Tucson','Mesa','Scottsdale','Chandler'],
    'Arkansas': ['Little Rock','Fayetteville','Fort Smith'],
    'California': ['Los Angeles','San Diego','San Francisco','Sacramento','San Jose','Oakland','Fresno'],
    'Colorado': ['Denver','Colorado Springs','Aurora','Fort Collins'],
    'Connecticut': ['Hartford','New Haven','Stamford','Bridgeport'],
    'Delaware': ['Wilmington','Dover','Newark'],
    'District of Columbia': ['Washington'],
    'Florida': ['Miami','Orlando','Tampa','Jacksonville','Tallahassee','St. Petersburg'],
    'Georgia': ['Atlanta','Savannah','Augusta','Columbus','Athens'],
    'Hawaii': ['Honolulu','Hilo','Kailua'],
    'Idaho': ['Boise','Meridian','Idaho Falls'],
    'Illinois': ['Chicago','Springfield','Aurora','Naperville','Rockford'],
    'Indiana': ['Indianapolis','Fort Wayne','Evansville'],
    'Iowa': ['Des Moines','Cedar Rapids','Davenport'],
    'Kansas': ['Wichita','Overland Park','Kansas City','Topeka'],
    'Kentucky': ['Louisville','Lexington','Bowling Green'],
    'Louisiana': ['New Orleans','Baton Rouge','Shreveport','Lafayette'],
    'Maine': ['Portland','Augusta','Bangor'],
    'Maryland': ['Baltimore','Annapolis','Rockville','Frederick'],
    'Massachusetts': ['Boston','Worcester','Springfield','Cambridge'],
    'Michigan': ['Detroit','Grand Rapids','Ann Arbor','Lansing'],
    'Minnesota': ['Minneapolis','Saint Paul','Rochester','Duluth'],
    'Mississippi': ['Jackson','Gulfport','Biloxi'],
    'Missouri': ['Kansas City','St. Louis','Springfield','Columbia'],
    'Montana': ['Billings','Missoula','Helena'],
    'Nebraska': ['Omaha','Lincoln'],
    'Nevada': ['Las Vegas','Reno','Henderson'],
    'New Hampshire': ['Manchester','Nashua','Concord'],
    'New Jersey': ['Newark','Jersey City','Trenton','Atlantic City'],
    'New Mexico': ['Albuquerque','Santa Fe','Las Cruces'],
    'New York': ['New York City','Buffalo','Rochester','Albany','Syracuse'],
    'North Carolina': ['Charlotte','Raleigh','Durham','Greensboro'],
    'North Dakota': ['Fargo','Bismarck'],
    'Ohio': ['Columbus','Cleveland','Cincinnati','Toledo','Akron'],
    'Oklahoma': ['Oklahoma City','Tulsa','Norman'],
    'Oregon': ['Portland','Salem','Eugene'],
    'Pennsylvania': ['Philadelphia','Pittsburgh','Allentown','Harrisburg'],
    'Rhode Island': ['Providence','Warwick'],
    'South Carolina': ['Charleston','Columbia','Greenville'],
    'South Dakota': ['Sioux Falls','Rapid City','Pierre'],
    'Tennessee': ['Nashville','Memphis','Knoxville','Chattanooga'],
    'Texas': ['Houston','San Antonio','Dallas','Austin','Fort Worth','El Paso'],
    'Utah': ['Salt Lake City','Provo','Ogden'],
    'Vermont': ['Burlington','Montpelier'],
    'Virginia': ['Virginia Beach','Richmond','Norfolk','Arlington'],
    'Washington': ['Seattle','Spokane','Tacoma','Olympia'],
    'West Virginia': ['Charleston','Huntington'],
    'Wisconsin': ['Milwaukee','Madison','Green Bay'],
    'Wyoming': ['Cheyenne','Casper'],
  },
  'Canada': {
    'Alberta': ['Calgary','Edmonton','Red Deer'],
    'British Columbia': ['Vancouver','Victoria','Surrey','Kelowna'],
    'Manitoba': ['Winnipeg','Brandon'],
    'New Brunswick': ['Moncton','Saint John','Fredericton'],
    'Newfoundland and Labrador': ["St. John's"],
    'Northwest Territories': ['Yellowknife'],
    'Nova Scotia': ['Halifax','Sydney'],
    'Nunavut': ['Iqaluit'],
    'Ontario': ['Toronto','Ottawa','Hamilton','London','Mississauga'],
    'Prince Edward Island': ['Charlottetown'],
    'Quebec': ['Montreal','Quebec City','Laval','Gatineau'],
    'Saskatchewan': ['Saskatoon','Regina'],
    'Yukon': ['Whitehorse'],
  },
  'United Kingdom': {
    'England': ['London','Manchester','Birmingham','Liverpool','Leeds'],
    'Scotland': ['Edinburgh','Glasgow','Aberdeen','Dundee'],
    'Wales': ['Cardiff','Swansea','Newport'],
    'Northern Ireland': ['Belfast','Derry'],
  },
  'Nigeria': {
    'Abia': ['Umuahia','Aba'], 'Adamawa': ['Yola'], 'Akwa Ibom': ['Uyo'], 'Anambra': ['Awka','Onitsha'],
    'Bauchi': ['Bauchi'], 'Bayelsa': ['Yenagoa'], 'Benue': ['Makurdi'], 'Borno': ['Maiduguri'],
    'Cross River': ['Calabar'], 'Delta': ['Asaba','Warri'], 'Ebonyi': ['Abakaliki'], 'Edo': ['Benin City'],
    'Ekiti': ['Ado Ekiti'], 'Enugu': ['Enugu'], 'Gombe': ['Gombe'], 'Imo': ['Owerri'], 'Jigawa': ['Dutse'],
    'Kaduna': ['Kaduna'], 'Kano': ['Kano'], 'Katsina': ['Katsina'], 'Kebbi': ['Birnin Kebbi'], 'Kogi': ['Lokoja'],
    'Kwara': ['Ilorin'], 'Lagos': ['Lagos','Ikeja'], 'Nasarawa': ['Lafia'], 'Niger': ['Minna'], 'Ogun': ['Abeokuta'],
    'Ondo': ['Akure'], 'Osun': ['Osogbo'], 'Oyo': ['Ibadan'], 'Plateau': ['Jos'], 'Rivers': ['Port Harcourt'],
    'Sokoto': ['Sokoto'], 'Taraba': ['Jalingo'], 'Yobe': ['Damaturu'], 'Zamfara': ['Gusau'],
    'Federal Capital Territory (Abuja)': ['Abuja'],
  },
  'Ghana': {
    'Ahafo': ['Goaso'], 'Ashanti': ['Kumasi'], 'Bono': ['Sunyani'], 'Bono East': ['Techiman'],
    'Central': ['Cape Coast'], 'Eastern': ['Koforidua'], 'Greater Accra': ['Accra','Tema'],
    'North East': ['Nalerigu'], 'Northern': ['Tamale'], 'Oti': ['Dambai'], 'Savannah': ['Damongo'],
    'Upper East': ['Bolgatanga'], 'Upper West': ['Wa'], 'Volta': ['Ho'], 'Western': ['Sekondi-Takoradi'],
    'Western North': ['Sefwi Wiawso'],
  },
  'Kenya': {
    'Baringo': ['Kabarnet'], 'Bomet': ['Bomet'], 'Bungoma': ['Bungoma'], 'Busia': ['Busia'],
    'Elgeyo-Marakwet': ['Iten'], 'Embu': ['Embu'], 'Garissa': ['Garissa'], 'Homa Bay': ['Homa Bay'],
    'Isiolo': ['Isiolo'], 'Kajiado': ['Kajiado'], 'Kakamega': ['Kakamega'], 'Kericho': ['Kericho'],
    'Kiambu': ['Kiambu','Thika'], 'Kilifi': ['Kilifi','Malindi'], 'Kirinyaga': ['Kerugoya'], 'Kisii': ['Kisii'],
    'Kisumu': ['Kisumu'], 'Kitui': ['Kitui'], 'Kwale': ['Kwale'], 'Laikipia': ['Nanyuki'], 'Lamu': ['Lamu'],
    'Machakos': ['Machakos'], 'Makueni': ['Wote'], 'Mandera': ['Mandera'], 'Marsabit': ['Marsabit'],
    'Meru': ['Meru'], 'Migori': ['Migori'], 'Mombasa': ['Mombasa'], "Murang'a": ["Murang'a"],
    'Nairobi': ['Nairobi'], 'Nakuru': ['Nakuru','Naivasha'], 'Nandi': ['Kapsabet'], 'Narok': ['Narok'],
    'Nyamira': ['Nyamira'], 'Nyandarua': ['Ol Kalou'], 'Nyeri': ['Nyeri'], 'Samburu': ['Maralal'],
    'Siaya': ['Siaya'], 'Taita-Taveta': ['Voi'], 'Tana River': ['Hola'], 'Tharaka-Nithi': ['Chuka'],
    'Trans Nzoia': ['Kitale'], 'Turkana': ['Lodwar'], 'Uasin Gishu': ['Eldoret'], 'Vihiga': ['Mbale'],
    'Wajir': ['Wajir'], 'West Pokot': ['Kapenguria'],
  },
  'South Africa': {
    'Eastern Cape': ['Gqeberha (Port Elizabeth)','East London','Mthatha'],
    'Free State': ['Bloemfontein','Welkom'],
    'Gauteng': ['Johannesburg','Pretoria','Soweto'],
    'KwaZulu-Natal': ['Durban','Pietermaritzburg'],
    'Limpopo': ['Polokwane'],
    'Mpumalanga': ['Nelspruit (Mbombela)','Witbank'],
    'North West': ['Mahikeng','Rustenburg'],
    'Northern Cape': ['Kimberley'],
    'Western Cape': ['Cape Town','Stellenbosch'],
  },
  'Australia': {
    'Australian Capital Territory': ['Canberra'],
    'New South Wales': ['Sydney','Newcastle','Wollongong'],
    'Northern Territory': ['Darwin','Alice Springs'],
    'Queensland': ['Brisbane','Gold Coast','Cairns','Townsville'],
    'South Australia': ['Adelaide'],
    'Tasmania': ['Hobart','Launceston'],
    'Victoria': ['Melbourne','Geelong'],
    'Western Australia': ['Perth','Fremantle'],
  },
  'India': {
    'Andhra Pradesh': ['Visakhapatnam','Vijayawada'], 'Arunachal Pradesh': ['Itanagar'], 'Assam': ['Guwahati'],
    'Bihar': ['Patna','Gaya'], 'Chhattisgarh': ['Raipur'], 'Goa': ['Panaji','Margao'],
    'Gujarat': ['Ahmedabad','Surat','Vadodara'], 'Haryana': ['Gurugram','Faridabad'], 'Himachal Pradesh': ['Shimla'],
    'Jharkhand': ['Ranchi','Jamshedpur'], 'Karnataka': ['Bengaluru','Mysuru'], 'Kerala': ['Kochi','Thiruvananthapuram'],
    'Madhya Pradesh': ['Bhopal','Indore'], 'Maharashtra': ['Mumbai','Pune','Nagpur'], 'Manipur': ['Imphal'],
    'Meghalaya': ['Shillong'], 'Mizoram': ['Aizawl'], 'Nagaland': ['Kohima'], 'Odisha': ['Bhubaneswar'],
    'Punjab': ['Ludhiana','Amritsar'], 'Rajasthan': ['Jaipur','Jodhpur'], 'Sikkim': ['Gangtok'],
    'Tamil Nadu': ['Chennai','Coimbatore'], 'Telangana': ['Hyderabad'], 'Tripura': ['Agartala'],
    'Uttar Pradesh': ['Lucknow','Kanpur','Noida'], 'Uttarakhand': ['Dehradun'], 'West Bengal': ['Kolkata','Howrah'],
    'Andaman and Nicobar Islands': ['Port Blair'], 'Chandigarh': ['Chandigarh'],
    'Dadra and Nagar Haveli and Daman and Diu': ['Daman'], 'Delhi': ['New Delhi'],
    'Jammu and Kashmir': ['Srinagar','Jammu'], 'Ladakh': ['Leh'], 'Lakshadweep': ['Kavaratti'],
    'Puducherry': ['Puducherry'],
  },
  'Germany': {
    'Baden-Württemberg': ['Stuttgart','Karlsruhe'], 'Bavaria': ['Munich','Nuremberg'], 'Berlin': ['Berlin'],
    'Brandenburg': ['Potsdam'], 'Bremen': ['Bremen'], 'Hamburg': ['Hamburg'],
    'Hesse': ['Frankfurt','Wiesbaden'], 'Lower Saxony': ['Hanover'], 'Mecklenburg-Vorpommern': ['Schwerin','Rostock'],
    'North Rhine-Westphalia': ['Cologne','Düsseldorf','Dortmund'], 'Rhineland-Palatinate': ['Mainz'],
    'Saarland': ['Saarbrücken'], 'Saxony': ['Dresden','Leipzig'], 'Saxony-Anhalt': ['Magdeburg'],
    'Schleswig-Holstein': ['Kiel'], 'Thuringia': ['Erfurt'],
  },
  'Brazil': {
    'Acre': ['Rio Branco'], 'Alagoas': ['Maceió'], 'Amapá': ['Macapá'], 'Amazonas': ['Manaus'],
    'Bahia': ['Salvador'], 'Ceará': ['Fortaleza'], 'Distrito Federal': ['Brasília'], 'Espírito Santo': ['Vitória'],
    'Goiás': ['Goiânia'], 'Maranhão': ['São Luís'], 'Mato Grosso': ['Cuiabá'], 'Mato Grosso do Sul': ['Campo Grande'],
    'Minas Gerais': ['Belo Horizonte'], 'Pará': ['Belém'], 'Paraíba': ['João Pessoa'], 'Paraná': ['Curitiba'],
    'Pernambuco': ['Recife'], 'Piauí': ['Teresina'], 'Rio de Janeiro': ['Rio de Janeiro','Niterói'],
    'Rio Grande do Norte': ['Natal'], 'Rio Grande do Sul': ['Porto Alegre'], 'Rondônia': ['Porto Velho'],
    'Roraima': ['Boa Vista'], 'Santa Catarina': ['Florianópolis'], 'São Paulo': ['São Paulo','Campinas'],
    'Sergipe': ['Aracaju'], 'Tocantins': ['Palmas'],
  },
  'Mexico': {
    'Aguascalientes': ['Aguascalientes'], 'Baja California': ['Tijuana','Mexicali'], 'Baja California Sur': ['La Paz'],
    'Campeche': ['Campeche'], 'Chiapas': ['Tuxtla Gutiérrez'], 'Chihuahua': ['Chihuahua','Ciudad Juárez'],
    'Ciudad de México': ['Mexico City'], 'Coahuila': ['Saltillo','Torreón'], 'Colima': ['Colima'],
    'Durango': ['Durango'], 'Guanajuato': ['León','Guanajuato'], 'Guerrero': ['Acapulco','Chilpancingo'],
    'Hidalgo': ['Pachuca'], 'Jalisco': ['Guadalajara'], 'México': ['Toluca','Ecatepec'],
    'Michoacán': ['Morelia'], 'Morelos': ['Cuernavaca'], 'Nayarit': ['Tepic'], 'Nuevo León': ['Monterrey'],
    'Oaxaca': ['Oaxaca City'], 'Puebla': ['Puebla'], 'Querétaro': ['Querétaro'], 'Quintana Roo': ['Cancún','Chetumal'],
    'San Luis Potosí': ['San Luis Potosí'], 'Sinaloa': ['Culiacán','Mazatlán'], 'Sonora': ['Hermosillo'],
    'Tabasco': ['Villahermosa'], 'Tamaulipas': ['Reynosa','Tampico'], 'Tlaxcala': ['Tlaxcala'],
    'Veracruz': ['Veracruz','Xalapa'], 'Yucatán': ['Mérida'], 'Zacatecas': ['Zacatecas'],
  },
  'Pakistan': {
    'Balochistan': ['Quetta'], 'Khyber Pakhtunkhwa': ['Peshawar'], 'Punjab': ['Lahore','Faisalabad'],
    'Sindh': ['Karachi','Hyderabad'], 'Azad Jammu and Kashmir': ['Muzaffarabad'], 'Gilgit-Baltistan': ['Gilgit'],
    'Islamabad Capital Territory': ['Islamabad'],
  },
};

// Renders City as a dropdown of that state's major cities when we have
// curated data for the country+state combo, with an "Other" option that
// switches to free text (so an unlisted city never blocks anyone). Falls
// back to plain free text when we don't have city data for that state, or
// no state/country has been picked yet.
function CityField(country, state, value, custom, onChange, onToggleCustom) {
  const cities = STATES_BY_COUNTRY[country] && CITIES_BY_STATE[country] && CITIES_BY_STATE[country][state];
  if (!cities) {
    return h('input', { value, placeholder: 'City', oninput: (e) => onChange(e.target.value) });
  }
  if (custom || (value && !cities.includes(value))) {
    return h('div', {},
      h('input', { value, placeholder: 'City', oninput: (e) => onChange(e.target.value) }),
      h('button', { type: 'button', class: 'secondary', style: 'margin-top:6px', onclick: () => onToggleCustom(false) }, `← Choose from ${state} cities`)
    );
  }
  return h('select', { onchange: (e) => {
    if (e.target.value === '__other__') onToggleCustom(true);
    else onChange(e.target.value);
  } },
    h('option', { value: '' }, 'Select a city'),
    cities.map((c) => h('option', { value: c, selected: value === c }, c)),
    h('option', { value: '__other__' }, 'Other — type my city')
  );
}

/* ---------- talent categories & event types ---------- */
// Broad talent role groups a musician/performer can tag themselves with, in
// addition to their own free-text instrument/genre fields. Flattened into
// TALENT_CATEGORIES for the search filter dropdown.
const TALENT_CATEGORY_GROUPS = [
  ['Vocals', ['Lead vocalist', 'Background vocalist', 'Choir singer', 'Worship leader', 'Cantor']],
  ['Guitar', ['Acoustic guitar', 'Electric guitar', 'Lead guitar', 'Rhythm guitar']],
  ['Keys', ['Keyboard', 'Piano', 'Organ', 'Synthesizer']],
  ['Rhythm', ['Drums', 'Percussion', 'Cajón']],
  ['Bass', ['Electric bass', 'Upright bass']],
  ['Strings', ['Violin', 'Viola', 'Cello']],
  ['Brass/Woodwinds', ['Saxophone', 'Trumpet', 'Flute', 'Trombone']],
  ['DJ & MC', ['DJ', 'MC / Host', 'Rapper / Spoken word']],
  ['Performance', ['Comedian', 'Dancer', 'Magician', "Children's entertainer"]],
  ['Production', ['Sound engineer', 'Lighting technician', 'Live-stream technician', 'Music director']],
];
const TALENT_CATEGORIES = TALENT_CATEGORY_GROUPS.flatMap(([, opts]) => opts);

// Homepage "featured category" tiles — AirGigs' front page leads with a grid
// of big, named category cards (their exact example: "Session Drummers")
// that jump straight into a pre-filtered search, rather than making people
// find the right checkbox themselves. `category` here must be one of the
// exact TALENT_CATEGORIES values above so clicking a tile filters correctly.
const FEATURED_CATEGORIES = [
  { label: 'Session Drummers', icon: '🥁', category: 'Drums', desc: 'Live drum tracks & pocket grooves' },
  { label: 'Session Guitarists', icon: '🎸', category: 'Electric guitar', desc: 'Electric & acoustic session players' },
  { label: 'Lead Vocalists', icon: '🎤', category: 'Lead vocalist', desc: 'Powerful voices for any style' },
  { label: 'Session Bassists', icon: '🎸', category: 'Electric bass', desc: 'Rock-solid low end' },
  { label: 'DJs', icon: '🎧', category: 'DJ', desc: 'Weddings, parties & events' },
  { label: 'Session Keys', icon: '🎹', category: 'Keyboard', desc: 'Piano, keys & synth' },
  { label: 'MCs & Hosts', icon: '🎙️', category: 'MC / Host', desc: 'Keep your event moving' },
  { label: 'Horns & Woodwinds', icon: '🎷', category: 'Saxophone', desc: 'Sax, trumpet, flute & more' },
  { label: 'Sound Engineers', icon: '🎚️', category: 'Sound engineer', desc: 'Live mixing & studio gear' },
];
// Category art from the Kaf design system (the `Category` asset group): a
// drum kit for drummers, a mic for vocalists, a turntable for DJs — the way
// AirGigs leads each category with a picture. Each class is a background
// image defined in styles.css; the tile's scrim keeps the label legible.
// Every tile now uses a real photo — drums/keys/mixing are the user's own
// gear, the rest are free-license stock photos picked to match each role.
const CATEGORY_TILE_ART = [
  'cat-drums-photo',
  'cat-guitar-photo',
  'cat-vocals-photo',
  'cat-bass-photo',
  'cat-dj-photo',
  'cat-keys-photo',
  'cat-mc-photo',
  'cat-horns-photo',
  'cat-mixing-photo',
];

function FeaturedCategoriesSection() {
  return h('div', { style: 'margin:22px 0 28px' },
    h('h2', { style: 'font-size:24px;margin:0 0 4px' }, 'Browse by role'),
    h('p', { class: 'muted', style: 'margin:0 0 14px' }, "Jump straight to the talent you need — each spot below is its own pre-filtered search."),
    h('div', { class: 'category-grid' },
      FEATURED_CATEGORIES.map((cat, i) => h('div', {
        class: `category-tile ${CATEGORY_TILE_ART[i % CATEGORY_TILE_ART.length]}`,
        role: 'link', tabindex: '0',
        onclick: () => navigate('home', { category: cat.category, qs: `?category=${encodeURIComponent(cat.category)}` }),
      },
        h('h3', {}, cat.label),
        h('p', {}, cat.desc),
        h('div', { class: 'cat-explore' }, 'Explore →')
      ))
    )
  );
}

// Event types a performer can opt into being found for. An empty selection
// on a profile means "open to all event types."
const EVENT_TYPES = [
  ['church', 'Church / worship service'],
  ['wedding_ceremony', 'Wedding ceremony'],
  ['wedding_reception', 'Wedding reception'],
  ['private_party', 'Private party (birthday, anniversary, etc.)'],
  ['bar_nightlife', 'Bar, club, or lounge'],
  ['school', 'School (graduation, prom, program)'],
  ['corporate', 'Corporate event'],
  ['festival', 'Festival or concert'],
  ['restaurant_hotel', 'Restaurant or hotel'],
  ['community', 'Community / nonprofit event'],
  ['funeral', 'Funeral or memorial'],
];
function eventTypeLabel(key) { const m = EVENT_TYPES.find(([k]) => k === key); return m ? m[1] : key; }

// Reusable checkbox-group control: `options` is an array of either plain
// strings or [value, label] pairs; `selected` is the live array to mutate
// in place (so the caller's closure variable stays in sync without a
// re-render). `onChange` optionally fires after each toggle.
function CheckboxGroup(options, selected, onChange) {
  return h('div', { class: 'checkbox-group' },
    options.map((opt) => {
      const [value, label] = Array.isArray(opt) ? opt : [opt, opt];
      return h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text);margin-bottom:4px' },
        h('input', {
          type: 'checkbox', style: 'width:auto',
          checked: selected.includes(value),
          onchange: (e) => {
            if (e.target.checked) { if (!selected.includes(value)) selected.push(value); }
            else { const i = selected.indexOf(value); if (i !== -1) selected.splice(i, 1); }
            if (onChange) onChange();
          },
        }), label);
    })
  );
}

/* ================= BROWSE MUSICIANS ================= */

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
      <stop offset="0%" stop-color="#f6c977"/>
      <stop offset="55%" stop-color="#f0b544"/>
      <stop offset="100%" stop-color="#8a4d05"/>
    </radialGradient>
    <radialGradient id="vinylSheen" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="rgba(255,255,255,.20)"/>
      <stop offset="40%" stop-color="rgba(255,255,255,.03)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <circle cx="100" cy="100" r="98" fill="#14110e"/>
  <circle cx="100" cy="100" r="97" fill="none" stroke="#3a322a" stroke-width="1.5"/>
  <circle cx="100" cy="100" r="86" fill="none" stroke="#2a241e" stroke-width="2"/>
  <circle cx="100" cy="100" r="74" fill="none" stroke="#2a241e" stroke-width="2"/>
  <circle cx="100" cy="100" r="62" fill="none" stroke="#2a241e" stroke-width="2"/>
  <circle cx="100" cy="100" r="50" fill="none" stroke="#2a241e" stroke-width="2"/>
  <circle cx="100" cy="100" r="40" fill="url(#vinylLabel)"/>
  <circle cx="100" cy="100" r="40" fill="none" stroke="#000" stroke-width="1" opacity=".35"/>
  <circle cx="100" cy="100" r="5" fill="#14110e"/>
  <path d="M100 18 A82 82 0 0 1 165 55" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="100" cy="100" r="98" fill="url(#vinylSheen)"/>
</svg>`;

const TONEARM_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="88" cy="12" r="9" fill="#2a241e" stroke="#7b6e5f" stroke-width="1.5"/>
  <line x1="88" y1="12" x2="32" y2="66" stroke="#e9e2d8" stroke-width="4" stroke-linecap="round"/>
  <rect x="20" y="60" width="20" height="11" rx="2.5" fill="#f0b544"/>
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
    shoulders += `<ellipse cx="${x.toFixed(1)}" cy="${shoulderY.toFixed(1)}" rx="${(shoulderW / 2).toFixed(1)}" ry="34" fill="#14110e"/>`;
    shoulders += `<circle cx="${x.toFixed(1)}" cy="${headY.toFixed(1)}" r="${headR.toFixed(1)}" fill="#14110e"/>`;
    if (r1 > 0.35) {
      const side = r2 > 0.5 ? 1 : -1;
      const handX = x + side * (headR + 12 + r1 * 16);
      const handY = headY - 42 - r2 * 58;
      const delay = (r1 * 2.6).toFixed(2);
      const dur = (2.8 + r2 * 1.6).toFixed(2);
      arms += `<g class="crowd-arm" style="--cdelay:${delay}s;--cdur:${dur}s;transform-origin:${x.toFixed(1)}px ${shoulderY.toFixed(1)}px">
        <line x1="${x.toFixed(1)}" y1="${(shoulderY - 14).toFixed(1)}" x2="${handX.toFixed(1)}" y2="${handY.toFixed(1)}" stroke="#14110e" stroke-width="10" stroke-linecap="round"/>
        <circle cx="${handX.toFixed(1)}" cy="${handY.toFixed(1)}" r="7.5" fill="#14110e"/>
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
    top: warm ? '#ffe0b0' : '#e7f7f1',
    bottom: warm ? '#c8901f' : '#4fc9ae',
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
  wrap.appendChild(StageHero('Find your musician, singer, MC, DJ, or performer',
    'Try natural language — e.g. "gospel piano player less than $100 an hour" — or filter by role, event type, city/state, or search within a radius of where you are.'));
  wrap.appendChild(h('div', { class: 'full-bleed keys-glow-below', 'aria-hidden': 'true' }));

  // The category grid is a landing-page thing (like AirGigs' homepage) — once
  // someone has actually searched or filtered, showing it again above the
  // results would just be clutter, so it only appears on a clean arrival.
  const isLanding = !state.params.q && !state.params.city && !state.params.stateCode &&
    !state.params.country && !state.params.category && !state.params.eventType && !state.params.radius;
  if (isLanding) wrap.appendChild(FeaturedCategoriesSection());

  let q = state.params.q || '';
  let city = state.params.city || '';
  let stateCode = state.params.stateCode || '';
  let country = state.params.country || '';
  let cityCustom = state.params.cityCustom || false;
  let radius = state.params.radius || '';
  let category = state.params.category || '';
  let eventType = state.params.eventType || '';
  let emergency = false;
  const locationStatus = h('span', { class: 'muted' },
    state.params.lat ? `Using your location — searching by real distance worldwide, based on each talent's own set location.` : '');

  function doSearch() {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (city) qs.set('city', city);
    if (stateCode) qs.set('state', stateCode);
    if (country) qs.set('country', country);
    if (emergency) qs.set('emergency', '1');
    if (category) qs.set('category', category);
    if (eventType) qs.set('eventType', eventType);
    if (radius && state.params.lat && state.params.lng) {
      qs.set('radius', radius);
      qs.set('lat', state.params.lat);
      qs.set('lng', state.params.lng);
    }
    state.params.q = q;
    state.params.city = city;
    state.params.stateCode = stateCode;
    state.params.country = country;
    state.params.radius = radius;
    state.params.category = category;
    state.params.eventType = eventType;
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
      h('select', { style: 'max-width:170px', onchange: (e) => {
        country = e.target.value; stateCode = ''; city = ''; cityCustom = false;
        state.params.cityCustom = false;
        doSearch();
      } },
        h('option', { value: '' }, 'Any country'),
        COUNTRIES.map((c) => h('option', { value: c, selected: country === c }, c))
      ),
      STATES_BY_COUNTRY[country]
        ? h('select', { style: 'max-width:160px', onchange: (e) => {
            stateCode = e.target.value; city = ''; cityCustom = false;
            state.params.cityCustom = false;
            doSearch();
          } },
            h('option', { value: '' }, 'Any state/province'),
            STATES_BY_COUNTRY[country].map((s) => h('option', { value: s, selected: stateCode === s }, s)))
        : h('input', { placeholder: 'State / region', value: stateCode, style: 'max-width:140px', oninput: (e) => stateCode = e.target.value,
            onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      (CITIES_BY_STATE[country] && CITIES_BY_STATE[country][stateCode] && !cityCustom)
        ? h('select', { style: 'max-width:160px', onchange: (e) => {
            if (e.target.value === '__other__') { state.params.cityCustom = true; state.params.city = ''; render(); return; }
            city = e.target.value; doSearch();
          } },
            h('option', { value: '' }, 'Any city'),
            CITIES_BY_STATE[country][stateCode].map((c) => h('option', { value: c, selected: city === c }, c)),
            h('option', { value: '__other__' }, 'Other — type a city'))
        : h('input', { placeholder: 'City', value: city, style: 'max-width:160px', oninput: (e) => city = e.target.value,
            onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      (CITIES_BY_STATE[country] && CITIES_BY_STATE[country][stateCode] && cityCustom)
        ? h('button', { type: 'button', class: 'secondary', onclick: () => { state.params.cityCustom = false; state.params.city = ''; render(); } }, `← Choose from ${stateCode} cities`)
        : null
    ),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('select', { style: 'max-width:200px', onchange: (e) => { category = e.target.value; doSearch(); } },
        h('option', { value: '' }, 'Any role/category'),
        TALENT_CATEGORY_GROUPS.map(([group, opts]) => h('optgroup', { label: group },
          opts.map((o) => h('option', { value: o, selected: category === o }, o))))
      ),
      h('select', { style: 'max-width:200px', onchange: (e) => { eventType = e.target.value; doSearch(); } },
        h('option', { value: '' }, 'Any event type'),
        EVENT_TYPES.map(([k, label]) => h('option', { value: k, selected: eventType === k }, label))
      )
    ),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('label', { style: 'display:flex;align-items:center;gap:6px;margin:0;font-weight:400;color:var(--text)' },
        h('input', { type: 'checkbox', style: 'width:auto', onchange: (e) => emergency = e.target.checked }), 'Emergency/last-minute available only'),
      h('input', { type: 'number', min: 1, placeholder: 'Miles', value: radius, style: 'max-width:90px', oninput: (e) => radius = e.target.value }),
      h('button', { type: 'button', class: 'secondary', title: 'Works worldwide — distance is measured using each talent\'s own set location. Talent who haven\'t set a location are always included regardless of radius.', onclick: useMyLocation }, 'Search near me'),
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
    grid.appendChild(h('div', { class: 'card photo-card musician-card' },
      CardPhoto(p.photoUrl, p.stageName || p.name),
      h('div', { class: 'photo-card-body' },
        h('div', { class: 'row between', style: 'gap:6px' }, h('h3', { style: 'margin:0' }, p.stageName || p.name),
          p.emergencyAvailable ? h('span', { class: 'badge emergency' }, 'Emergency OK') : null),
        h('p', { class: 'muted', style: 'margin:2px 0 0' }, [p.city, p.state, p.country].filter(Boolean).join(', ') || 'Location not set'),
        h('p', { class: 'stars', style: 'margin:2px 0 0' }, stars(p.avgRating)),
        h('div', { class: 'pill-row', style: 'margin-top:10px' }, (p.instruments || []).slice(0, 4).map((i) => h('span', { class: 'pill' }, i))),
        h('p', {}, `${money(p.hourlyRate)}/hr`),
        p.idVerified ? h('span', { class: 'badge' }, '✓ ID Verified') : null,
        h('div', { style: 'margin-top:10px' }, h('button', { onclick: () => navigate('musicianDetail', { id: p.id }) }, 'View profile'))
      )
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
    h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
      Avatar(p.stageName || p.name, p.photoUrl, 'avatar-xl'),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { class: 'row between' },
          h('h1', {}, p.stageName || p.name),
          h('div', {}, p.idVerified ? h('span', { class: 'badge' }, '✓ ID Verified') : null,
            p.emergencyAvailable ? h('span', { class: 'badge emergency' }, ' Emergency OK') : null)),
        h('p', { class: 'muted' }, [p.city, p.state, p.country].filter(Boolean).join(', ') || 'Location not set'),
        h('p', { class: 'stars' }, stars(p.avgRating), ` · ${p.reviewCount} review(s)`))),
    h('p', {}, p.bio || 'No bio provided yet.'),
    h('div', { class: 'pill-row' }, (p.instruments || []).map((i) => h('span', { class: 'pill' }, i)), (p.genres || []).map((g) => h('span', { class: 'pill' }, g))),
    h('h2', { style: 'margin-top:16px' }, `${money(p.hourlyRate)}/hr`),
    (p.videoUrl || (p.mediaUrls && p.mediaUrls.length)) ? h('div', { style: 'margin:12px 0' },
      h('label', {}, 'Demo'),
      p.videoUrl ? h('p', {}, h('a', { href: p.videoUrl, target: '_blank', rel: 'noopener noreferrer' }, '▶ Watch/listen to demo')) : null,
      (p.mediaUrls || []).map((m) => h('div', { class: 'row', style: 'align-items:center;gap:10px;margin-bottom:8px' },
        (m.mimeType || '').startsWith('video/')
          ? h('video', { src: m.url, controls: true, style: 'max-width:260px;max-height:150px' })
          : h('audio', { src: m.url, controls: true }),
        h('span', { class: 'muted' }, m.fileName || 'Demo')))
    ) : null,
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
  const v = { eventDate: '', eventTime: '', durationHours: 2, location: '', offeredRate: profile.hourlyRate, isEmergency: false, isGroup: false, groupDetails: '', eventType: '' };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  const modal = h('div', { class: 'modal' },
    h('h2', {}, `Request to hire ${profile.stageName || profile.name}`),
    h('div', { class: 'safety-notice' },
      '⚠️ Make sure this is the right person before you send this request — check reviews and ID verification, and keep all communication and payment on Musician Connect.'),
    h('label', {}, 'Event type'),
    h('select', { onchange: (e) => v.eventType = e.target.value },
      h('option', { value: '' }, 'Prefer not to say'),
      EVENT_TYPES.map(([k, label]) => h('option', { value: k }, label))),
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
    booking.eventType ? h('span', { class: 'pill' }, eventTypeLabel(booking.eventType)) : null,
    h('p', {}, `${money(booking.offeredRate)}/hr × ${booking.durationHours}hr — total ${money(booking.total)} (incl. ${money(booking.serviceFee)} service fee)`),
    booking.location ? h('p', { class: 'muted' }, booking.location) : null,
    booking.status === 'countered' ? h('p', { class: 'muted' }, `Counter-offer: ${money(booking.counterRate)}/hr`) : null,
    booking.noShowReport ? h('p', { class: 'muted' }, `No-show report: ${booking.noShowReport}`) : null,
    h('div', { class: 'row', style: 'margin-top:8px' }, actions));
}

/* ================= CLIENT DASHBOARD ================= */
let clientData = { bookings: [], rentals: [], favorites: [], jobs: [] };
async function loadClientDashboardData() {
  const [b, r, f, j] = await Promise.all([
    api('GET', '/api/bookings/mine'),
    api('GET', '/api/rentals/mine'),
    api('GET', '/api/favorites/mine'),
    api('GET', '/api/jobs/mine'),
  ]);
  clientData = { bookings: b.bookings, rentals: r.rentals, favorites: f.profiles, jobs: j.jobs };
}

function ClientDashboardPage() {
  const tab = state.params.tab || 'bookings';
  const wrap = h('div', {});
  wrap.appendChild(h('h1', {}, 'My Dashboard'));
  wrap.appendChild(Tabs([
    ['bookings', 'My Bookings'], ['rentals', 'My Rentals'], ['jobs', 'My Job Postings'], ['favorites', 'Favorites'],
  ], tab, (t) => { state.params.tab = t; render(); }));

  if (tab === 'bookings') {
    wrap.appendChild(clientData.bookings.length
      ? h('div', {}, clientData.bookings.map((b) => BookingCard(b, 'client')))
      : h('div', { class: 'empty-state' }, "You haven't requested any bookings yet."));
  } else if (tab === 'jobs') {
    wrap.appendChild(ClientJobsSection());
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

/* ================= ACCOUNT SETTINGS ================= */
function AccountPage() {
  if (!state.user) { navigate('login'); return h('div', {}); }
  const u = state.user;
  return h('div', {},
    h('h1', {}, 'Account settings'),
    h('div', { class: 'card', style: 'max-width:560px' },
      h('h3', {}, 'Your info'),
      h('p', {}, h('strong', {}, 'Name: '), u.name),
      h('p', {}, h('strong', {}, 'Email: '), u.email),
      h('p', {}, h('strong', {}, 'Role: '), u.role.replace('_', ' '))
    ),
    DangerZoneCard(u)
  );
}

function DangerZoneCard(u) {
  if (u.role === 'admin') {
    return h('div', { class: 'card', style: 'max-width:560px; margin-top:16px; border-color:var(--danger)' },
      h('h3', { style: 'color:var(--danger)' }, 'Danger zone'),
      h('p', { class: 'muted' }, "Admin accounts can't be deleted from here — ask another admin to remove this account from the Admin panel."));
  }
  return h('div', { class: 'card', style: 'max-width:560px; margin-top:16px; border-color:var(--danger)' },
    h('h3', { style: 'color:var(--danger)' }, 'Danger zone'),
    h('p', { class: 'muted' },
      'Deleting your account removes your public profile and listings, your favorites, and your notifications, and signs you out everywhere immediately. Some booking or rental records may be kept in anonymized form for the other party\'s history, as described in our ',
      h('a', { href: '/privacy-policy.html', class: 'footer-link' }, 'privacy policy'), '.'),
    h('button', { class: 'danger', onclick: openDeleteAccountModal }, 'Delete my account'));
}

function openDeleteAccountModal() {
  let password = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, 'Delete your account?'),
    h('p', {}, 'This can\'t be undone. Enter your password to confirm.'),
    h('label', {}, 'Password'),
    h('input', { type: 'password', oninput: (e) => password = e.target.value }),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'danger', onclick: async () => {
        try {
          await api('POST', '/api/account/delete', { password });
          close();
          state.user = null; state.musicianProfile = null; state.equipmentOwnerProfile = null;
          navigate('home', {}, { type: 'success', message: 'Your account has been deleted.' });
        } catch (err) { showBanner('error', err.message); }
      } }, 'Yes, delete my account'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
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
let musicianData = { bookings: [], jobResponses: [] };
async function loadMusicianDashboardData() {
  const [b, j] = await Promise.all([
    api('GET', '/api/bookings/mine'),
    api('GET', '/api/jobs/my-responses'),
  ]);
  musicianData = { bookings: b.bookings, jobResponses: j.responses };
}

function MusicianDashboardPage() {
  const tab = state.params.tab || 'profile';
  const wrap = h('div', {});
  wrap.appendChild(h('h1', {}, 'My Dashboard'));
  wrap.appendChild(Tabs([['profile', 'My Profile'], ['bookings', 'Incoming Bookings'], ['jobResponses', 'Job Responses']], tab, (t) => { state.params.tab = t; render(); }));

  if (tab === 'profile') wrap.appendChild(MusicianProfileForm());
  else if (tab === 'jobResponses') wrap.appendChild(MusicianJobResponsesSection());
  else wrap.appendChild(musicianData.bookings.length
    ? h('div', {}, musicianData.bookings.map((b) => BookingCard(b, 'musician')))
    : h('div', { class: 'empty-state' }, 'No booking requests yet.'));
  return wrap;
}

function MusicianProfileForm() {
  const p = state.musicianProfile || {};
  const v = {
    stageName: p.stageName || '', bio: p.bio || '', hourlyRate: p.hourlyRate || 0,
    city: p.city || '', state: p.state || '', country: p.country || '',
    lat: p.lat != null ? p.lat : null, lng: p.lng != null ? p.lng : null,
    emergencyAvailable: !!p.emergencyAvailable, hasInsurance: !!p.hasInsurance,
    instruments: [...(p.instruments || [])], genres: (p.genres || []).join(', '),
    eventTypes: [...(p.eventTypes || [])],
    videoUrl: p.videoUrl || '', mediaUrls: [...(p.mediaUrls || [])],
    photoUrl: p.photoUrl || null,
  };
  const wrap = h('div', {});
  const rerender = () => { clear(wrap); wrap.appendChild(build()); };
  let uploadingDemo = false;
  let uploadingPhoto = false;
  let cityCustom = false;
  let demoStatus = null; // { type: 'success'|'error', message } — shown inline so it never
  // triggers the app-wide render() (via showBanner) that would wipe any of this
  // form's other not-yet-saved fields (e.g. a typed demo link, edited bio, etc.)
  let photoStatus = null; // same reasoning as demoStatus, for the profile-photo upload below

  async function uploadPhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { photoStatus = { type: 'error', message: 'Please choose an image file.' }; rerender(); return; }
    if (file.size > 5 * 1024 * 1024) { photoStatus = { type: 'error', message: 'Profile photos must be under 5MB.' }; rerender(); return; }
    uploadingPhoto = true; photoStatus = null; rerender();
    try {
      const base64 = await readFileAsBase64(file);
      const data = await api('POST', '/api/musicians/photo-upload', { fileName: file.name, mimeType: file.type, dataBase64: base64 });
      // Only merge in photoUrl, same reasoning as the demo upload below —
      // this form may have other not-yet-saved edits.
      state.musicianProfile = { ...state.musicianProfile, photoUrl: data.profile.photoUrl };
      v.photoUrl = data.profile.photoUrl;
      photoStatus = { type: 'success', message: 'Photo updated.' };
    } catch (err) {
      photoStatus = { type: 'error', message: err.message };
    } finally {
      uploadingPhoto = false;
      rerender();
    }
  }

  async function removePhoto() {
    try {
      const data = await api('POST', '/api/musicians/photo-delete');
      state.musicianProfile = { ...state.musicianProfile, photoUrl: data.profile.photoUrl };
      v.photoUrl = data.profile.photoUrl;
      photoStatus = { type: 'success', message: 'Photo removed.' };
      rerender();
    } catch (err) { photoStatus = { type: 'error', message: err.message }; rerender(); }
  }

  function useMyLocationForProfile() {
    if (!navigator.geolocation) { showBanner('error', 'Your browser does not support geolocation.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        v.lat = pos.coords.latitude;
        v.lng = pos.coords.longitude;
        rerender();
      },
      () => showBanner('error', 'Could not get your location — check your browser/site permissions and try again.'),
      { timeout: 8000 }
    );
  }

  function uploadDemoFile(file) {
    if (!file) return;
    if (!/^(audio|video)\//.test(file.type)) {
      demoStatus = { type: 'error', message: 'Please choose an audio or video file.' };
      rerender();
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      demoStatus = { type: 'error', message: 'Demo files must be under 10MB — try a shorter or more compressed clip.' };
      rerender();
      return;
    }
    uploadingDemo = true;
    demoStatus = null;
    rerender();
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1] || '';
      try {
        const data = await api('POST', '/api/musicians/demo-upload', {
          fileName: file.name, mimeType: file.type, dataBase64: base64,
        });
        // Only merge in the field this endpoint actually changed (mediaUrls)
        // rather than replacing state.musicianProfile/v wholesale — this form
        // may have other, not-yet-saved edits (like a typed demo link) that a
        // full profile replacement would silently wipe.
        state.musicianProfile = { ...state.musicianProfile, mediaUrls: data.profile.mediaUrls };
        v.mediaUrls = [...(data.profile.mediaUrls || [])];
        demoStatus = { type: 'success', message: 'Demo uploaded.' };
      } catch (err) {
        demoStatus = { type: 'error', message: err.message };
      } finally {
        uploadingDemo = false;
        rerender();
      }
    };
    reader.onerror = () => { uploadingDemo = false; demoStatus = { type: 'error', message: 'Could not read that file.' }; rerender(); };
    reader.readAsDataURL(file);
  }

  async function removeDemoFile(url) {
    try {
      const data = await api('POST', '/api/musicians/demo-delete', { url });
      state.musicianProfile = { ...state.musicianProfile, mediaUrls: data.profile.mediaUrls };
      v.mediaUrls = [...(data.profile.mediaUrls || [])];
      demoStatus = { type: 'success', message: 'Demo removed.' };
      rerender();
    } catch (err) { demoStatus = { type: 'error', message: err.message }; rerender(); }
  }

  function build() {
    return h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const data = await api('POST', '/api/musicians/profile', {
          ...v,
          hourlyRate: parseFloat(v.hourlyRate) || 0,
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
      !v.photoUrl ? h('div', { class: 'nudge-banner' }, '📸 Add a profile photo — profiles with a real photo get noticed first in search and feel far more trustworthy to clients.') : null,
      h('label', {}, 'Profile photo — shown on your card in search results and at the top of your profile'),
      PhotoUploadField(v.stageName, v.photoUrl, uploadingPhoto, photoStatus, uploadPhoto, removePhoto),
      h('label', {}, 'Stage name'), h('input', { value: v.stageName, oninput: (e) => v.stageName = e.target.value }),
      h('label', {}, 'Bio'), h('textarea', { rows: 3, oninput: (e) => v.bio = e.target.value }, v.bio),
      h('label', {}, 'Hourly rate ($)'), h('input', { type: 'number', value: v.hourlyRate, oninput: (e) => v.hourlyRate = e.target.value }),
      h('label', {}, 'Country'), h('select', { onchange: (e) => {
        v.country = e.target.value;
        if (STATES_BY_COUNTRY[v.country] && !STATES_BY_COUNTRY[v.country].includes(v.state)) v.state = '';
        v.city = ''; cityCustom = false;
        rerender();
      } },
        h('option', { value: '' }, 'Select a country'),
        COUNTRIES.map((c) => h('option', { value: c, selected: v.country === c }, c))),
      h('label', {}, 'State / Province / Region'), StateField(v.country, v.state, (val) => {
        v.state = val;
        // Only re-render for an actual dropdown pick (fires once per
        // selection); free-text typing would otherwise re-render — and
        // detach the input — on every keystroke.
        if (STATES_BY_COUNTRY[v.country]) { v.city = ''; cityCustom = false; rerender(); }
      }),
      h('label', {}, 'City'), CityField(v.country, v.state, v.city, cityCustom,
        (val) => { v.city = val; },
        (isCustom) => { cityCustom = isCustom; v.city = ''; rerender(); }),
      h('div', { class: 'row', style: 'align-items:center;gap:10px;margin:6px 0 14px' },
        h('button', { type: 'button', class: 'secondary', onclick: useMyLocationForProfile }, '📍 Use my current location'),
        h('span', { class: 'muted' }, v.lat != null
          ? 'Location set — clients searching "near me" worldwide can find you by real distance.'
          : "Optional, but recommended — without it you'll still show up in city/state/country searches, just not distance (\"near me\") searches.")),
      h('label', {}, 'Roles / instruments — check everything that applies'),
      h('div', { class: 'card', style: 'background:var(--surface-2, transparent);margin-bottom:10px' },
        TALENT_CATEGORY_GROUPS.map(([group, opts]) => h('div', { style: 'margin-bottom:10px' },
          h('strong', {}, group),
          CheckboxGroup(opts, v.instruments)))),
      h('label', {}, 'Genres (comma-separated)'), h('input', { value: v.genres, oninput: (e) => v.genres = e.target.value }),
      h('label', {}, 'Demo — link to an existing recording (YouTube, SoundCloud, Instagram, etc.)'),
      h('input', { value: v.videoUrl, placeholder: 'https://...', oninput: (e) => v.videoUrl = e.target.value }),
      h('label', {}, 'Or upload a short demo clip (audio or video, up to 10MB) — you can add either, both, or neither'),
      h('div', { class: 'card', style: 'background:var(--surface-2, transparent);margin-bottom:10px' },
        h('input', { type: 'file', accept: 'audio/*,video/*', disabled: uploadingDemo,
          onchange: (e) => { uploadDemoFile(e.target.files[0]); e.target.value = ''; } }),
        uploadingDemo ? h('p', { class: 'muted' }, 'Uploading…') : null,
        demoStatus ? h('p', { class: demoStatus.type === 'error' ? 'error-box' : 'success-box' }, demoStatus.message) : null,
        v.mediaUrls.length ? h('div', { style: 'margin-top:10px' },
          v.mediaUrls.map((m) => h('div', { class: 'row', style: 'align-items:center;gap:10px;margin-bottom:8px' },
            (m.mimeType || '').startsWith('video/')
              ? h('video', { src: m.url, controls: true, style: 'max-width:220px;max-height:120px' })
              : h('audio', { src: m.url, controls: true }),
            h('span', { class: 'muted' }, m.fileName || 'Demo'),
            h('button', { type: 'button', class: 'danger', onclick: () => removeDemoFile(m.url) }, 'Remove')
          ))
        ) : h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'No uploaded demo files yet.')
      ),
      h('label', {}, "Event types you're open to — leave all unchecked to be shown for every event type"),
      h('div', { class: 'card', style: 'background:var(--surface-2, transparent);margin-bottom:10px' },
        CheckboxGroup(EVENT_TYPES.map(([k, label]) => [k, label]), v.eventTypes)),
      h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text)' },
        h('input', { type: 'checkbox', style: 'width:auto', checked: v.emergencyAvailable, onchange: (e) => v.emergencyAvailable = e.target.checked }), 'Available for emergency / last-minute bookings'),
      h('label', { style: 'display:flex;align-items:center;gap:6px;font-weight:400;color:var(--text)' },
        h('input', { type: 'checkbox', style: 'width:auto', checked: v.hasInsurance, onchange: (e) => v.hasInsurance = e.target.checked }), 'I carry liability insurance (self-reported)'),
      h('div', { style: 'margin-top:14px' }, h('button', { type: 'submit' }, 'Save profile'))
    );
  }
  wrap.appendChild(build());
  return wrap;
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
  const v = { businessName: p.businessName || '', bio: p.bio || '', city: p.city || '', state: p.state || '', country: p.country || '', photoUrl: p.photoUrl || null };
  const wrap = h('div', {});
  const rerender = () => { clear(wrap); wrap.appendChild(build()); };
  let cityCustom = false;
  let uploadingPhoto = false;
  let photoStatus = null; // shown inline, not via showBanner — see MusicianProfileForm for why

  async function uploadPhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { photoStatus = { type: 'error', message: 'Please choose an image file.' }; rerender(); return; }
    if (file.size > 5 * 1024 * 1024) { photoStatus = { type: 'error', message: 'Profile photos must be under 5MB.' }; rerender(); return; }
    uploadingPhoto = true; photoStatus = null; rerender();
    try {
      const base64 = await readFileAsBase64(file);
      const data = await api('POST', '/api/equipment-owner/photo-upload', { fileName: file.name, mimeType: file.type, dataBase64: base64 });
      state.equipmentOwnerProfile = { ...state.equipmentOwnerProfile, photoUrl: data.profile.photoUrl };
      v.photoUrl = data.profile.photoUrl;
      photoStatus = { type: 'success', message: 'Photo updated.' };
    } catch (err) {
      photoStatus = { type: 'error', message: err.message };
    } finally {
      uploadingPhoto = false;
      rerender();
    }
  }

  async function removePhoto() {
    try {
      const data = await api('POST', '/api/equipment-owner/photo-delete');
      state.equipmentOwnerProfile = { ...state.equipmentOwnerProfile, photoUrl: data.profile.photoUrl };
      v.photoUrl = data.profile.photoUrl;
      photoStatus = { type: 'success', message: 'Photo removed.' };
      rerender();
    } catch (err) { photoStatus = { type: 'error', message: err.message }; rerender(); }
  }

  function build() {
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
      !v.photoUrl ? h('div', { class: 'nudge-banner' }, '📸 Add a profile photo — listings from a verified, recognizable business get more rental requests.') : null,
      h('label', {}, 'Profile photo — shown on your listings'),
      PhotoUploadField(v.businessName, v.photoUrl, uploadingPhoto, photoStatus, uploadPhoto, removePhoto),
      h('label', {}, 'Business name'), h('input', { value: v.businessName, oninput: (e) => v.businessName = e.target.value }),
      h('label', {}, 'Bio'), h('textarea', { rows: 3, oninput: (e) => v.bio = e.target.value }, v.bio),
      h('label', {}, 'Country'), h('select', { onchange: (e) => {
        v.country = e.target.value;
        if (STATES_BY_COUNTRY[v.country] && !STATES_BY_COUNTRY[v.country].includes(v.state)) v.state = '';
        v.city = ''; cityCustom = false;
        rerender();
      } },
        h('option', { value: '' }, 'Select a country'),
        COUNTRIES.map((c) => h('option', { value: c, selected: v.country === c }, c))),
      h('label', {}, 'State / Province / Region'), StateField(v.country, v.state, (val) => {
        v.state = val;
        // Only re-render for an actual dropdown pick (fires once per
        // selection); free-text typing would otherwise re-render — and
        // detach the input — on every keystroke.
        if (STATES_BY_COUNTRY[v.country]) { v.city = ''; cityCustom = false; rerender(); }
      }),
      h('label', {}, 'City'), CityField(v.country, v.state, v.city, cityCustom,
        (val) => { v.city = val; },
        (isCustom) => { cityCustom = isCustom; v.city = ''; rerender(); }),
      h('div', { style: 'margin-top:14px' }, h('button', { type: 'submit' }, 'Save profile')));
  }
  wrap.appendChild(build());
  return wrap;
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
      h('div', { class: 'row', style: 'align-items:center;gap:8px;margin:2px 0' },
        Avatar(eq.ownerBusinessName, eq.ownerPhotoUrl, 'avatar-sm'),
        h('span', { class: 'muted' }, [eq.ownerCity, eq.ownerState, eq.ownerCountry].filter(Boolean).join(', ') || eq.ownerBusinessName)),
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
    h('div', { class: 'row', style: 'align-items:center;gap:8px' },
      Avatar(eq.ownerBusinessName, eq.ownerPhotoUrl, 'avatar-sm'),
      h('p', { class: 'muted', style: 'margin:0' }, `Listed by ${eq.ownerBusinessName}${eq.ownerIdVerified ? ' · ✓ ID Verified' : ''}`)),
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

/* ================= JOB POSTINGS ================= */
// A client posts an opening ("need a drummer this Sunday, 8am call time")
// that any matching talent can browse and respond to — an alternative to
// the client having to find and directly book one specific musician.
function JobCard(job, opts) {
  opts = opts || {};
  return h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('h3', {}, job.title),
      h('span', { class: `badge ${job.status}` }, statusLabel(job.status))),
    h('p', { class: 'muted', style: 'margin:2px 0 0' },
      `${job.eventDate}${job.eventTime ? ' · ' + job.eventTime : ''}`),
    h('p', { class: 'muted', style: 'margin:2px 0 0' }, [job.city, job.state, job.country].filter(Boolean).join(', ') || 'Location not set'),
    h('div', { class: 'pill-row', style: 'margin-top:8px' },
      job.category ? h('span', { class: 'pill' }, job.category) : null,
      job.eventType ? h('span', { class: 'pill' }, eventTypeLabel(job.eventType)) : null),
    job.payRate ? h('p', {}, job.payRate) : null,
    job.clientName ? h('p', { class: 'muted' }, `Posted by ${job.clientName}`) : null,
    opts.footer || null);
}

function BrowseJobsPage() {
  const wrap = h('div', {});
  wrap.appendChild(Hero('📋', 'Job postings', 'Openings posted by churches, venues, and event organizers — browse and respond directly.'));

  let q = state.params.q || '';
  let category = state.params.category || '';
  let eventType = state.params.eventType || '';
  let city = state.params.city || '';
  let stateCode = state.params.stateCode || '';
  let country = state.params.country || '';

  function doSearch() {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    if (eventType) qs.set('eventType', eventType);
    if (city) qs.set('city', city);
    if (stateCode) qs.set('state', stateCode);
    if (country) qs.set('country', country);
    state.params.q = q; state.params.category = category; state.params.eventType = eventType;
    state.params.city = city; state.params.stateCode = stateCode; state.params.country = country;
    state.params.qs = qs.toString() ? `?${qs}` : '';
    loadPageData();
  }

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('input', { placeholder: 'Search job postings (title, category, location)...', value: q, style: 'flex:2;min-width:240px',
        oninput: (e) => q = e.target.value, onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      h('select', { style: 'max-width:200px', onchange: (e) => { category = e.target.value; doSearch(); } },
        h('option', { value: '' }, 'Any role/category'),
        TALENT_CATEGORY_GROUPS.map(([group, opts]) => h('optgroup', { label: group },
          opts.map((o) => h('option', { value: o, selected: category === o }, o))))),
      h('select', { style: 'max-width:200px', onchange: (e) => { eventType = e.target.value; doSearch(); } },
        h('option', { value: '' }, 'Any event type'),
        EVENT_TYPES.map(([k, label]) => h('option', { value: k, selected: eventType === k }, label)))
    ),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('input', { placeholder: 'City', value: city, style: 'max-width:160px', oninput: (e) => city = e.target.value,
        onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      h('input', { placeholder: 'State / region', value: stateCode, style: 'max-width:160px', oninput: (e) => stateCode = e.target.value,
        onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      h('input', { placeholder: 'Country', value: country, style: 'max-width:160px', oninput: (e) => country = e.target.value,
        onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } }),
      h('button', { onclick: doSearch }, 'Search')
    )
  ));

  const grid = h('div', { class: 'grid' });
  if (!state.jobs.length) grid.appendChild(h('div', { class: 'empty-state' }, 'No open job postings right now. Try a different search.'));
  state.jobs.forEach((job) => {
    grid.appendChild(JobCard(job, {
      footer: h('div', { style: 'margin-top:10px' }, h('button', { onclick: () => navigate('jobDetail', { id: job.id }) }, 'View & respond')),
    }));
  });
  wrap.appendChild(grid);

  if (state.user && state.user.role === 'client') {
    wrap.appendChild(h('p', { class: 'muted', style: 'margin-top:10px' },
      'Looking to post an opening of your own? Head to ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('clientDashboard', { tab: 'jobs' }); } }, 'My Dashboard → My Job Postings'), '.'));
  }
  return wrap;
}

function JobDetailPage() {
  const detail = state.params.detail;
  if (!detail) return h('p', {}, 'Loading...');
  const job = detail.job;
  const wrap = h('div', {});
  wrap.appendChild(h('button', { class: 'secondary', onclick: () => navigate('jobsBrowse') }, '← Back to job postings'));
  wrap.appendChild(h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'row between' }, h('h1', {}, job.title), h('span', { class: `badge ${job.status}` }, statusLabel(job.status))),
    h('p', { class: 'muted' }, `${job.eventDate}${job.eventTime ? ' · ' + job.eventTime : ''}`),
    h('p', { class: 'muted' }, [job.city, job.state, job.country].filter(Boolean).join(', ') || 'Location not set'),
    h('div', { class: 'pill-row', style: 'margin-top:8px' },
      job.category ? h('span', { class: 'pill' }, job.category) : null,
      job.eventType ? h('span', { class: 'pill' }, eventTypeLabel(job.eventType)) : null),
    job.payRate ? h('h3', { style: 'margin-top:10px' }, job.payRate) : null,
    h('p', { style: 'margin-top:10px' }, job.description || 'No further details provided.'),
    job.clientName ? h('p', { class: 'muted' }, `Posted by ${job.clientName}`) : null,
    h('div', { class: 'safety-notice' },
      '⚠️ Keep all communication and payment on Musician Connect. Confirm event details directly with the poster before you travel or commit time.'),
    jobResponseAction(job, detail.myResponse)
  ));
  return wrap;
}

function jobResponseAction(job, myResponse) {
  if (!state.user) {
    return h('p', { class: 'muted', style: 'margin-top:14px' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('login'); } }, 'Log in as talent'), ' to respond to this posting.');
  }
  if (state.user.role !== 'musician') return null;
  if (myResponse) {
    return h('div', { style: 'margin-top:14px' },
      h('span', { class: `badge ${myResponse.status}` }, `Your response: ${statusLabel(myResponse.status)}`));
  }
  if (job.status !== 'open') {
    return h('p', { class: 'muted', style: 'margin-top:14px' }, 'This posting is no longer open.');
  }
  return h('div', { style: 'margin-top:14px' },
    h('button', { onclick: () => openJobResponseModal(job) }, 'Respond to this posting'));
}

function openJobResponseModal(job) {
  let message = '';
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); }
  backdrop.appendChild(h('div', { class: 'modal' },
    h('h2', {}, `Respond to "${job.title}"`),
    h('label', {}, 'Message to the poster (optional)'),
    h('textarea', { rows: 3, oninput: (e) => message = e.target.value }),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { onclick: async () => {
        try {
          await api('POST', `/api/jobs/${job.id}/respond`, { message });
          close();
          navigate('jobDetail', { id: job.id }, { type: 'success', message: 'Response sent!' });
        } catch (err) { showBanner('error', err.message); }
      } }, 'Send response'),
      h('button', { class: 'secondary', onclick: close }, 'Cancel'))));
  document.body.appendChild(backdrop);
}

async function jobAction(id, path, body) {
  try { await api('POST', `/api/jobs/${id}${path}`, body || {}); showBanner('success', 'Done.'); loadPageData(); }
  catch (err) { showBanner('error', err.message); }
}

function NewJobPostingForm() {
  const v = { title: '', category: '', description: '', eventDate: '', eventTime: '', city: '', state: '', country: '', eventType: '', payRate: '' };
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/jobs', v);
      showBanner('success', 'Job posting created.');
      form.reset();
      loadPageData();
    } catch (err) { showBanner('error', err.message); }
  } },
    h('label', {}, 'Title'), h('input', { required: true, placeholder: 'e.g. Need a drummer this Sunday, 8am call time', oninput: (e) => v.title = e.target.value }),
    h('label', {}, 'Role / category'),
    h('select', { onchange: (e) => v.category = e.target.value },
      h('option', { value: '' }, 'Any / not sure'),
      TALENT_CATEGORY_GROUPS.map(([group, opts]) => h('optgroup', { label: group },
        opts.map((o) => h('option', { value: o }, o))))),
    h('label', {}, 'Event type'),
    h('select', { onchange: (e) => v.eventType = e.target.value },
      h('option', { value: '' }, 'Prefer not to say'),
      EVENT_TYPES.map(([k, label]) => h('option', { value: k }, label))),
    h('label', {}, 'Event date'), h('input', { type: 'date', required: true, oninput: (e) => v.eventDate = e.target.value }),
    h('label', {}, 'Call time (optional)'), h('input', { type: 'time', oninput: (e) => v.eventTime = e.target.value }),
    h('label', {}, 'City'), h('input', { oninput: (e) => v.city = e.target.value }),
    h('label', {}, 'State / region'), h('input', { oninput: (e) => v.state = e.target.value }),
    h('label', {}, 'Country'), h('input', { oninput: (e) => v.country = e.target.value }),
    h('label', {}, 'Pay (optional — e.g. "$150 flat", "$50/hr", "volunteer")'), h('input', { oninput: (e) => v.payRate = e.target.value }),
    h('label', {}, 'Details'), h('textarea', { rows: 3, oninput: (e) => v.description = e.target.value }),
    h('div', { style: 'margin-top:12px' }, h('button', { type: 'submit' }, 'Post job')));
  return form;
}

function JobPostingWithResponsesCard(job) {
  const actions = [];
  if (job.status === 'open') {
    actions.push(h('button', { class: 'danger', onclick: () => { if (confirm('Close this job posting?')) jobAction(job.id, '/close'); } }, 'Close posting'));
  }
  const responseRows = (job.responses || []).map((r) => h('div', { class: 'row between', style: 'padding:8px 0;border-bottom:1px solid var(--border)' },
    h('div', {},
      h('div', { class: 'row', style: 'align-items:center;gap:8px' }, Avatar(r.stageName, r.photoUrl, 'avatar-sm'),
        h('strong', {}, r.stageName), h('span', { class: `badge ${r.status}` }, statusLabel(r.status))),
      r.hourlyRate ? h('p', { class: 'muted', style: 'margin:2px 0 0' }, `${money(r.hourlyRate)}/hr`) : null,
      r.message ? h('p', { style: 'margin:4px 0 0' }, r.message) : null),
    r.status === 'pending' ? h('div', { class: 'row' },
      h('button', { onclick: () => jobAction(job.id, `/responses/${r.id}/respond`, { action: 'accept' }) }, 'Accept'),
      h('button', { class: 'danger', onclick: () => jobAction(job.id, `/responses/${r.id}/respond`, { action: 'decline' }) }, 'Decline')) : null));

  return h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', {}, job.title), h('span', { class: `badge ${job.status}` }, statusLabel(job.status))),
    h('p', { class: 'muted', style: 'margin:2px 0 0' }, `${job.eventDate}${job.eventTime ? ' · ' + job.eventTime : ''}`),
    h('p', { class: 'muted', style: 'margin:2px 0 0' }, [job.city, job.state, job.country].filter(Boolean).join(', ') || 'Location not set'),
    h('div', { class: 'row', style: 'margin-top:8px' }, actions),
    h('h4', { style: 'margin-top:14px' }, `Responses (${(job.responses || []).length})`),
    responseRows.length ? h('div', {}, responseRows) : h('p', { class: 'muted' }, 'No responses yet.'));
}

function ClientJobsSection() {
  const wrap = h('div', {});
  wrap.appendChild(h('div', { class: 'card' }, h('h2', {}, 'Post a job'), NewJobPostingForm()));
  wrap.appendChild(clientData.jobs.length
    ? h('div', {}, clientData.jobs.map(JobPostingWithResponsesCard))
    : h('div', { class: 'empty-state' }, "You haven't posted any jobs yet."));
  return wrap;
}

function MusicianJobResponsesSection() {
  const wrap = h('div', {});
  if (!musicianData.jobResponses.length) {
    wrap.appendChild(h('div', { class: 'empty-state' },
      "You haven't responded to any job postings yet. ",
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); navigate('jobsBrowse'); } }, 'Browse open postings →')));
    return wrap;
  }
  musicianData.jobResponses.forEach((r) => {
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h3', {}, r.jobTitle),
        h('span', { class: `badge ${r.status}` }, statusLabel(r.status))),
      h('p', { class: 'muted', style: 'margin:2px 0 0' }, `${r.jobEventDate}${r.jobEventTime ? ' · ' + r.jobEventTime : ''}`),
      h('p', { class: 'muted', style: 'margin:2px 0 0' }, [r.jobCity, r.jobState, r.jobCountry].filter(Boolean).join(', ') || 'Location not set'),
      r.jobPayRate ? h('p', {}, r.jobPayRate) : null,
      r.jobStatus !== 'open' && r.status === 'pending' ? h('p', { class: 'muted' }, 'This posting is no longer open.') : null,
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'secondary', onclick: () => navigate('jobDetail', { id: r.jobPostingId }) }, 'View posting'))));
  });
  return wrap;
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
  // A password-reset email link lands here as /?resetToken=... — route
  // straight to the reset-password screen and strip the token from the
  // visible URL so it doesn't linger in history/bookmarks.
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('resetToken');
  if (resetToken) {
    state.page = 'resetPassword';
    state.params = { token: resetToken };
    window.history.replaceState({}, '', window.location.pathname);
  }
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
