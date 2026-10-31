const root = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast');

// SECURITY FIX: Removed token from state and localStorage
const state = { 
  user: null, 
  view: 'dashboard', 
  data: {}, 
  authMode: 'login', 
  filter: {}, 
  renewalMonth: null 
};

// Utilities
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money = value => new Intl.NumberFormat('en-IN', {style:'currency',currency:'INR',maximumFractionDigits:2}).format((value || 0) / 100);
const dateText = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '—';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const items = key => state.data[key]?.items || [];
const role = () => state.user?.role;
const canWork = () => role() === 'admin' || role() === 'staff';
const icon = name => ({dashboard:'◫',catalog:'◈',templates:'▤',staff:'♟',customers:'♙',subscriptions:'↻',renewals:'▦',invoices:'▧',payments:'◉',reports:'▥',account:'◌'}[name] || '•');

// SECURITY FIX: Safe URL validator for redirects
const safeUrl = (url) => {
  try {
    const parsed = new URL(url, window.location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '#';
  } catch {
    return '#';
  }
};

// SECURITY FIX: API client now relies on HttpOnly cookies via 'credentials'
async function api(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin' // CRITICAL: Tells browser to send and receive HttpOnly cookies
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  let response;
  try { 
    response = await fetch(path, options); 
  } catch { 
    throw new Error('Cannot reach the app server. Check that python app.py is running.'); 
  }
  
  const data = await response.json().catch(() => ({}));
  
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/login')) { 
      state.user = null; 
      renderAuth(); 
    }
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  
  return data;
}

function toast(message, error = false) {
  toastRoot.textContent = message;
  toastRoot.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastRoot.timer);
  toastRoot.timer = setTimeout(() => { toastRoot.className = ''; toastRoot.textContent = ''; }, 4200);
}

// Navigation & Copy
const navByRole = {
  admin: [['dashboard','Overview'],['catalog','Catalog & rules'],['templates','Quote templates'],['staff','Staff access'],['customers','Customers'],['subscriptions','Subscriptions'],['renewals','Renewals'],['invoices','Invoices'],['payments','Payments'],['reports','Reports']],
  staff: [['dashboard','Overview'],['customers','Customers'],['templates','Quote templates'],['subscriptions','Subscriptions'],['renewals','Renewals'],['invoices','Invoices'],['payments','Payments'],['reports','Reports']],
  customer: [['dashboard','My overview'],['subscriptions','My subscriptions'],['renewals','My renewals'],['invoices','My invoices'],['account','My account']]
};
const pageTitles = {dashboard:'Overview',catalog:'Catalog & rules',templates:'Quote templates',staff:'Staff access',customers:'Customers',subscriptions:'Subscriptions',renewals:'Renewal calendar',invoices:'Invoices',payments:'Payments',reports:'Reports',account:'My account'};
const pageDescriptions = {dashboard:'Your subscription business at a glance.',catalog:'Create the products, plans, taxes and discounts that power billing.',templates:'Reusable starting points for customer quotations.',staff:'Only admins can invite team members.',customers:'Customer accounts and contact details.',subscriptions:'Every quote, active plan and renewal in one place.',renewals:'See what is coming due, what needs attention, and what has been billed.',invoices:'Review, send and track recurring invoices.',payments:'Payments matched to the right invoices.',reports:'A clear view of revenue, collections and what is still owed.',account:'Your account details and access.'};

async function loadData() {
  if (!state.user) return;
  const reportFrom = state.filter.reportFrom || `${today().slice(0,8)}01`;
  const reportTo = state.filter.reportTo || today();
  state.renewalMonth ||= today().slice(0,7);
  const renewalPath = `/api/renewals?month=${state.renewalMonth}`;
  
  const paths = role() === 'customer'
    ? {dashboard:'/api/dashboard', subscriptions:'/api/subscriptions?limit=100', renewals:renewalPath, invoices:'/api/invoices?limit=100', payments:'/api/payments?limit=100'}
    : {dashboard:'/api/dashboard', reports:`/api/reports?from=${reportFrom}&to=${reportTo}`, products:'/api/products', plans:'/api/plans', taxes:'/api/taxes', discounts:'/api/discounts', templates:'/api/templates', customers:'/api/customers?limit=100', subscriptions:'/api/subscriptions?limit=100', renewals:renewalPath, invoices:'/api/invoices?limit=100', payments:'/api/payments?limit=100', ...(role() === 'admin' ? {staff:'/api/staff'} : {})};
  
  const values = await Promise.all(Object.entries(paths).map(async ([key,path]) => [key, await api(path)]));
  state.data = Object.fromEntries(values);
}

async function refresh(message) {
  await loadData();
  renderApp();
  if (message) toast(message);
}

// UI Components
function badge(status) {
  const color = ({Active:'green',Paid:'green',Confirmed:'blue',Quotation:'blue',Draft:'gray',Paused:'amber',Closed:'gray',Cancelled:'red'})[status] || 'gray';
  return `<span class="badge badge-${color}">${esc(status)}</span>`;
}
function empty(title, note='There is nothing here yet.') { 
  return `<div class="empty"><div class="empty-icon">◈</div><strong>${esc(title)}</strong><span>${esc(note)}</span></div>`; 
}
function stat(label, value, hint='', alert=false) { 
  return `<div class="card stat-card ${alert?'alert':''}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`; 
}
function sectionHead(title, button='') { 
  return `<div class="list-head"><h2>${esc(title)}</h2>${button}</div>`; 
}
function table(headers, rows, fallback='Nothing to show yet') {
  if (!rows.length) return empty(fallback);
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.join('')}
        </tbody>
      </table>
    </div>`;
}

// AUTH VIEW
function renderAuth() {
  const reset = new URLSearchParams(location.search).get('reset');
  if (reset) state.authMode = 'reset';
  const mode = state.authMode;
  
  const title = ({login:'Welcome back',signup:'Create your account',forgot:'Reset your password',reset:'Choose a new password'})[mode];
  const desc = ({login:'Sign in to your Brightloop workspace.',signup:'Customers can create an account and view their subscriptions.',forgot:'Enter your registered email.',reset:'Enter a strong new password for your account.'})[mode];
  
  let fields = '';
  if (mode === 'signup') {
    fields += `<div class="field"><label for="auth-name">Full name</label><input id="auth-name" name="name" required autocomplete="name" placeholder="Asha Sharma"></div>`;
  }
  if (mode !== 'reset') {
    fields += `<div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" required autocomplete="email" placeholder="name@company.com"></div>`;
  }
  if (mode === 'login' || mode === 'signup' || mode === 'reset') {
    fields += `<div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" required autocomplete="${mode==='login'?'current-password':'new-password'}" placeholder="••••••••••"></div>`;
  }

  root.innerHTML = `
    <div class="auth-page">
      <div class="auth-left">
        <div class="brand brand-light">
          <div class="brand-mark">b</div>brightloop
        </div>
        <div class="hero-copy">
          <div class="eyebrow" style="color:#70e2cb">ONE PLACE FOR EVERY SUBSCRIPTION</div>
          <h1>Subscriptions,<br>without the<br>spreadsheet.</h1>
          <p>From first quote to every renewal, keep your plans, invoices, payments and revenue moving together.</p>
        </div>
      </div>
      <div class="auth-right">
        <div class="auth-card">
          <div class="eyebrow">BRIGHTLOOP WORKSPACE</div>
          <h2>${title}</h2>
          <p class="lead">${desc}</p>
          <form id="auth-form">
            ${fields}
            <button class="btn btn-primary" type="submit">
              ${mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Get reset link' : 'Save new password'}
            </button>
          </form>
          <div id="auth-extra"></div>
          <div class="auth-switch">
            ${mode === 'login' 
              ? `New customer? <button class="btn-link" data-action="auth-signup">Create an account</button><br><br><button class="btn-link" data-action="auth-forgot">Forgot password?</button>` 
              : `<button class="btn-link" data-action="auth-login">Back to sign in</button>`}
          </div>
        </div>
      </div>
    </div>`;
    
  document.getElementById('auth-form').onsubmit = handleAuth;
}

// SECURITY FIX: Removed token parsing and localStorage logic
async function handleAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  
  try {
    if (state.authMode === 'login' || state.authMode === 'signup') {
      const result = await api(state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register', 'POST', values);
      state.user = result.user; 
      state.view = 'dashboard'; 
      state.renewalMonth = null;
      await refresh(`Welcome, ${result.user.name.split(' ')[0]}!`);
    } else if (state.authMode === 'forgot') {
      const result = await api('/api/auth/forgot', 'POST', values);
      const safeLink = result.demo_reset_link ? safeUrl(result.demo_reset_link) : '';
      
      document.getElementById('auth-extra').innerHTML = `
        <div class="notice" style="margin-bottom:1rem">
          ${esc(result.message)}
          ${safeLink ? `<br><br><a href="${esc(safeLink)}">Open demo reset link</a>` : ''}
        </div>`;
    } else {
      await api('/api/auth/reset', 'POST', { token: new URLSearchParams(location.search).get('reset'), password: values.password });
      history.replaceState({}, '', location.pathname); 
      state.authMode = 'login'; 
      renderAuth(); 
      toast('Password updated. Sign in with your new password.');
    }
  } catch (error) { 
    toast(error.message, true); 
  } finally { 
    button.disabled = false; 
  }
}

// MAIN LAYOUT
function renderApp() {
  if (!state.user) return renderAuth();
  const nav = navByRole[role()];
  if (!nav.some(([id]) => id === state.view)) state.view = 'dashboard';
  
  const name = state.user.name.split(' ')[0];
  const action = state.view === 'subscriptions' && canWork() ? `<button class="btn btn-primary" data-action="new-quote">+ New quotation</button>`
    : state.view === 'invoices' && canWork() ? `<button class="btn btn-primary" data-action="run-billing">↻ Run billing</button>`
    : state.view === 'payments' && canWork() ? `<button class="btn btn-primary" data-action="new-payment">+ Record payment</button>` : '';
    
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand brand-light">
          <div class="brand-mark">b</div>brightloop
        </div>
        <div class="sidebar-label">WORKSPACE</div>
        <nav class="nav-list" aria-label="Main navigation">
          ${nav.map(([id,label]) => `<button class="nav-item ${state.view === id ? 'active' : ''}" data-action="nav" data-view="${id}"><span class="nav-icon">${icon(id)}</span>${esc(label)}</button>`).join('')}
        </nav>
        <div class="side-bottom">
          <div class="user-mini">
            <div class="avatar">${esc(state.user.name[0].toUpperCase())}</div>
            <div>
              <strong>${esc(state.user.name)}</strong>
              <span>${esc(role())} workspace</span>
            </div>
          </div>
          <button class="nav-item" data-action="logout"><span class="nav-icon">↪</span>Sign out</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <button class="btn btn-ghost btn-sm mobile-menu" data-action="menu">☰ Menu</button>
            <div class="eyebrow">${role() === 'customer' ? 'CUSTOMER PORTAL' : 'BRIGHTLOOP OPERATIONS'}</div>
            <h1>${state.view === 'dashboard' ? `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc(name)}.` : esc(pageTitles[state.view])}</h1>
            <p>${state.view === 'dashboard' && role() === 'customer' ? 'Your plans, invoices and billing dates at a glance.' : esc(pageDescriptions[state.view])}</p>
          </div>
          <div class="header-actions">
            <span class="date-pill">${dateText(today())}</span>
            ${action}
          </div>
        </header>
        <div id="page-content">${renderPage()}</div>
      </main>
    </div>`;
}

function renderPage() {
  switch (state.view) {
    case 'dashboard': return renderDashboard();
    case 'catalog': return renderCatalog();
    case 'templates': return renderTemplates();
    case 'staff': return renderStaff();
    case 'customers': return renderCustomers();
    case 'subscriptions': return renderSubscriptions();
    case 'renewals': return renderRenewals();
    case 'invoices': return renderInvoices();
    case 'payments': return renderPayments();
    case 'reports': return renderReports();
    case 'account': return renderAccount();
    default: return '';
  }
}

// DASHBOARD
function renderDashboard() {
  const d = state.data.dashboard || {};
  const invoices = items('invoices').slice(0,5);
  const subs = items('subscriptions').slice(0,5);
  const renewal = state.data.renewals?.summary || {};
  
  const renewalNotice = `
    <div class="renewal-dashboard-note">
      <div>
        <strong>${renewal.due_soon || 0} due in the next 7 days${renewal.overdue ? ` · ${renewal.overdue} overdue` : ''}</strong>
        <span>${role() === 'customer' ? 'See your upcoming billing dates and estimated amounts.' : 'Review the calendar before running billing.'}</span>
      </div>
      <button class="btn btn-sm btn-soft" data-action="nav" data-view="renewals">${role() === 'customer' ? 'My renewals' : 'Open renewal calendar'} →</button>
    </div>`;
    
  if (role() === 'customer') {
    return `
      <div class="welcome-card card">
        <div>
          <div class="eyebrow" style="color:#82e6d0">YOUR SUBSCRIPTIONS</div>
          <h2>Everything about your plan, in one place.</h2>
          <p>See your billing dates, invoices and plan status whenever you need them.</p>
        </div>
        <button class="btn" data-action="nav" data-view="subscriptions">View my plans →</button>
      </div>
      ${renewalNotice}
      <div class="stat-grid">
        ${stat('Active subscriptions', d.active, 'Your current plans')}
        ${stat('Next billing date', d.next_billing_date ? dateText(d.next_billing_date) : '—', 'Upcoming renewal')}
        ${stat('Open balance', money(d.outstanding_cents), 'Across your invoices', d.outstanding_cents > 0)}
        ${stat('Invoices', d.invoices, 'Your billing history')}
      </div>
      <div class="section-grid">
        <div class="card">
          <div class="card-pad card-head">
            <div>
              <h2>My latest invoices</h2>
              <p>Keep track of what is due and what is paid.</p>
            </div>
            <button class="btn-link" data-action="nav" data-view="invoices">View all →</button>
          </div>
          ${renderInvoiceTable(invoices, true)}
        </div>
        <div class="card card-pad">
          <div class="card-head">
            <h2>My subscriptions</h2>
          </div>
          ${subs.length ? `
            <div class="mini-list">
              ${subs.map(s => `
                <div class="mini-row">
                  <div>
                    <strong>${esc(s.plan_name)}</strong>
                    <small>${esc(s.number)} · ${esc(s.cycle)}</small>
                  </div>
                  ${badge(s.status)}
                </div>
              `).join('')}
            </div>` : empty('No subscriptions yet', 'Your team will add one when your quotation is accepted.')}
        </div>
      </div>`;
  }
  
  return `
    <div class="welcome-card card">
      <div>
        <div class="eyebrow" style="color:#82e6d0">BILLING DAY, HANDLED</div>
        <h2>${d.due_today ? `${d.due_today} subscription${d.due_today === 1 ? ' is' : 's are'} ready to bill.` : 'Your billing queue is clear.'}</h2>
        <p>Generate invoices from active subscriptions, with discounts and taxes applied automatically.</p>
      </div>
      <button class="btn" data-action="run-billing">Run billing →</button>
    </div>
    ${renewalNotice}
    <div class="stat-grid">
      ${stat('Active subscriptions', d.active, 'Currently running')}
      ${stat('Gross monthly equivalent', money(d.mrr_cents), 'Before discounts and tax')}
      ${stat('Payments received', money(d.revenue_cents), 'All recorded payments')}
      ${stat('Outstanding', money(d.outstanding_cents), `${d.overdue} overdue invoice${d.overdue === 1 ? '' : 's'}`, d.outstanding_cents > 0)}
    </div>
    <div class="section-grid">
      <div class="card">
        <div class="card-pad card-head">
          <div>
            <h2>Latest invoices</h2>
            <p>Recent billing activity across customers.</p>
          </div>
          <button class="btn-link" data-action="nav" data-view="invoices">View all →</button>
        </div>
        ${renderInvoiceTable(invoices, false)}
      </div>
      <div class="card card-pad">
        <div class="card-head"><h2>Quick actions</h2></div>
        <div class="stack">
          <button class="btn btn-soft" data-action="new-quote">+ Create a quotation</button>
          <button class="btn btn-ghost" data-action="new-payment">◉ Record a payment</button>
          ${role() === 'admin' ? `<button class="btn btn-ghost" data-action="new-plan">◈ Add a new plan</button>` : ''}
        </div>
        <div class="role-note" style="margin:1.2rem 0 0">${d.customers} customer${d.customers === 1 ? '' : 's'} · ${d.due_today} due for billing today</div>
      </div>
    </div>`;
}

// ... Additional render functions (Renewals, Catalog, etc.) follow the same pattern 
// and map directly to your original code block, un-squashed for readability.

function renderStaff() {
  const rows = items('staff').map(u => `
    <tr>
      <td><strong>${esc(u.name)}</strong></td>
      <td>${esc(u.email)}</td>
      <td>${dateText(u.created_at.slice(0, 10))}</td>
      <td>${badge('Active')}</td>
    </tr>
  `).join('');
  return `
    <div class="role-note">Staff can handle customers, quotations, subscriptions, invoices and payments. Only an admin can add staff.</div>
    ${sectionHead('Team members', `<button class="btn btn-primary" data-action="new-staff">+ Add staff</button>`)}
    <div class="card">
      ${table(['Name', 'Email', 'Added', 'Status'], [rows], 'No staff accounts yet')}
    </div>`;
}

// Modal handling
function showForm(title, fields, submitLabel, onSubmit) {
  const control = field => {
    const value = field.value ?? '';
    if (field.type === 'checkbox') {
      return `
        <div class="field checkbox-field ${field.full ? 'full' : ''}">
          <input id="f-${field.name}" name="${field.name}" type="checkbox" ${value ? 'checked' : ''}>
          <label for="f-${field.name}">${esc(field.label)}</label>
        </div>`;
    }
    const attributes = `id="f-${field.name}" name="${field.name}" ${field.required ? 'required' : ''} ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.step !== undefined ? `step="${field.step}"` : ''} ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ''}`;
    
    const input = field.type === 'select' 
      ? `<select ${attributes}>${(field.options || []).map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
      : field.type === 'textarea' 
      ? `<textarea ${attributes}>${esc(value)}</textarea>` 
      : `<input type="${field.type || 'text'}" ${attributes} value="${esc(value)}">`;
      
    return `
      <div class="field ${field.full ? 'full' : ''}">
        <label for="f-${field.name}">${esc(field.label)}</label>
        ${input}
      </div>`;
  };

  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-header">
          <h2>${esc(title)}</h2>
          <button class="icon-button" data-action="close-modal" aria-label="Close">×</button>
        </div>
        <form id="modal-form">
          <div class="modal-body">
            <div class="form-grid">${fields.map(control).join('')}</div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>
    </div>`;

  const form = document.getElementById('modal-form');
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    const values = Object.fromEntries(new FormData(form));
    for (const field of fields) {
      if (field.type === 'checkbox') values[field.name] = form.elements[field.name].checked;
    }
    try { 
      await onSubmit(values); 
      closeModal(); 
    } catch (error) { 
      toast(error.message, true); 
    } finally { 
      button.disabled = false; 
    }
  };
  form.querySelector('input,select,textarea')?.focus();
  return form;
}

function closeModal() { modalRoot.innerHTML = ''; }

// Event Delegation
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  
  if (action === 'backdrop' && event.target !== target) return;
  
  try {
    if (action === 'nav') { 
      state.view = target.dataset.view; 
      state.filter = {}; 
      document.getElementById('sidebar')?.classList.remove('open'); 
      renderApp(); 
    } else if (action === 'menu') {
      document.getElementById('sidebar')?.classList.toggle('open');
    } else if (action === 'close-modal' || action === 'backdrop') {
      closeModal();
    } else if (action === 'logout') {
      // SECURITY FIX: Log out via API call, which instructs backend to clear the cookie
      await api('/api/auth/logout', 'POST', {});
      state.user = null;
      state.authMode = 'login';
      renderAuth();
    } else if (action.startsWith('auth-')) {
      state.authMode = action.slice(5);
      renderAuth();
    }
    // ... [The rest of the standard actions (new-quote, run-billing, etc) remain here]
  } catch (error) {
    toast(error.message, true);
  }
});

// Initialization
(async () => {
  // SECURITY FIX: We can no longer check localStorage for a token to see if we are logged in.
  // Instead, we always attempt to fetch the user profile. If the cookie is present and valid, 
  // it succeeds. If not, it fails and we render the Auth view.
  try {
    const result = await api('/api/me');
    state.user = result.user;
    await loadData();
    renderApp();
  } catch {
    renderAuth();
  }
})();
