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

function toast(message, error=false) {
  toastRoot.textContent = message;
  toastRoot.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastRoot.timer);
  toastRoot.timer = setTimeout(() => { toastRoot.className = ''; toastRoot.textContent = ''; }, 4200);
}

const navByRole = {
  admin: [['dashboard','Overview'],['catalog','Catalog & rules'],['templates','Quote templates'],['staff','Staff access'],['customers','Customers'],['subscriptions','Subscriptions'],['renewals','Renewals'],['invoices','Invoices'],['payments','Payments'],['reports','Reports']],
  staff: [['dashboard','Overview'],['customers','Customers'],['templates','Quote templates'],['subscriptions','Subscriptions'],['renewals','Renewals'],['invoices','Invoices'],['payments','Payments'],['reports','Reports']],
  customer: [['dashboard','My overview'],['subscriptions','My subscriptions'],['renewals','My renewals'],['invoices','My invoices'],['account','My account']]
};
const pageTitles = {dashboard:'Overview',catalog:'Catalog & rules',templates:'Quote templates',staff:'Staff access',customers:'Customers',subscriptions:'Subscriptions',renewals:'Renewal calendar',invoices:'Invoices',payments:'Payments',reports:'Reports',account:'My account'};
const pageDescriptions = {dashboard:'Your subscription business at a glance.',catalog:'Create the products, plans, taxes and discounts that power billing.',templates:'Reusable starting points for customer quotations.',staff:'Only admins can invite team members.',customers:'Customer accounts and contact details.',subscriptions:'Every quote, active plan and renewal in one place.',renewals:'See what is coming due, what needs attention, and what has been billed.',invoices:'Review, send and track recurring invoices.',payments:'Payments matched to the right invoices.',reports:'A clear view of revenue, collections and what is still owed.',account:'Your account details and access.'};

async function loadData() {
  if (!state.user) return;
  const reportFrom=state.filter.reportFrom||`${today().slice(0,8)}01`;
  const reportTo=state.filter.reportTo||today();
  state.renewalMonth ||= today().slice(0,7);
  const renewalPath = `/api/renewals?month=${state.renewalMonth}`;
  const paths = role() === 'customer'
    ? {dashboard:'/api/dashboard',subscriptions:'/api/subscriptions?limit=100',renewals:renewalPath,invoices:'/api/invoices?limit=100',payments:'/api/payments?limit=100'}
    : {dashboard:'/api/dashboard',reports:`/api/reports?from=${reportFrom}&to=${reportTo}`,products:'/api/products',plans:'/api/plans',taxes:'/api/taxes',discounts:'/api/discounts',templates:'/api/templates',customers:'/api/customers?limit=100',subscriptions:'/api/subscriptions?limit=100',renewals:renewalPath,invoices:'/api/invoices?limit=100',payments:'/api/payments?limit=100',...(role() === 'admin' ? {staff:'/api/staff'} : {})};
  const values = await Promise.all(Object.entries(paths).map(async ([key,path]) => [key, await api(path)]));
  state.data = Object.fromEntries(values);
}

async function refresh(message) {
  await loadData();
  renderApp();
  if (message) toast(message);
}

function badge(status) {
  const color = ({Active:'green',Paid:'green',Confirmed:'blue',Quotation:'blue',Draft:'gray',Paused:'amber',Closed:'gray',Cancelled:'red'})[status] || 'gray';
  return `<span class="badge badge-${color}">${esc(status)}</span>`;
}
function empty(title, note='There is nothing here yet.') { return `<div class="empty"><div class="empty-icon">◈</div><strong>${esc(title)}</strong><span>${esc(note)}</span></div>`; }
function stat(label, value, hint='', alert=false) { return `<div class="card stat-card ${alert?'alert':''}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`; }
function sectionHead(title, button='') { return `<div class="list-head"><h2>${esc(title)}</h2>${button}</div>`; }
function table(headers, rows, fallback='Nothing to show yet') {
  if (!rows.length) return empty(fallback);
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

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

function renderApp() {
  if (!state.user) return renderAuth();
  const nav = navByRole[role()];
  if (!nav.some(([id])=>id===state.view)) state.view='dashboard';
  const name = state.user.name.split(' ')[0];
  const action = state.view === 'subscriptions' && canWork() ? `<button class="btn btn-primary" data-action="new-quote">+ New quotation</button>`
    : state.view === 'invoices' && canWork() ? `<button class="btn btn-primary" data-action="run-billing">↻ Run billing</button>`
    : state.view === 'payments' && canWork() ? `<button class="btn btn-primary" data-action="new-payment">+ Record payment</button>` : '';
  root.innerHTML = `<div class="app-shell"><aside class="sidebar" id="sidebar"><div class="brand brand-light"><div class="brand-mark">b</div>brightloop</div><div class="sidebar-label">WORKSPACE</div><nav class="nav-list" aria-label="Main navigation">${nav.map(([id,label])=>`<button class="nav-item ${state.view===id?'active':''}" data-action="nav" data-view="${id}"><span class="nav-icon">${icon(id)}</span>${esc(label)}</button>`).join('')}</nav><div class="side-bottom"><div class="user-mini"><div class="avatar">${esc(state.user.name[0].toUpperCase())}</div><div><strong>${esc(state.user.name)}</strong><span>${esc(role())} workspace</span></div></div><button class="nav-item" data-action="logout"><span class="nav-icon">↪</span>Sign out</button></div></aside><main class="main"><header class="topbar"><div><button class="btn btn-ghost btn-sm mobile-menu" data-action="menu">☰ Menu</button><div class="eyebrow">${role()==='customer'?'CUSTOMER PORTAL':'BRIGHTLOOP OPERATIONS'}</div><h1>${state.view==='dashboard'?`Good ${new Date().getHours()<12?'morning':new Date().getHours()<17?'afternoon':'evening'}, ${esc(name)}.`:esc(pageTitles[state.view])}</h1><p>${state.view==='dashboard'&&role()==='customer'?'Your plans, invoices and billing dates at a glance.':esc(pageDescriptions[state.view])}</p></div><div class="header-actions"><span class="date-pill">${dateText(today())}</span>${action}</div></header><div id="page-content">${renderPage()}</div></main></div>`;
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

function renderDashboard() {
  const d = state.data.dashboard || {};
  const invoices = items('invoices').slice(0,5);
  const subs = items('subscriptions').slice(0,5);
  const renewal = state.data.renewals?.summary || {};
  const renewalNotice = `<div class="renewal-dashboard-note"><div><strong>${renewal.due_soon || 0} due in the next 7 days${renewal.overdue ? ` · ${renewal.overdue} overdue` : ''}</strong><span>${role() === 'customer' ? 'See your upcoming billing dates and estimated amounts.' : 'Review the calendar before running billing.'}</span></div><button class="btn btn-sm btn-soft" data-action="nav" data-view="renewals">${role() === 'customer' ? 'My renewals' : 'Open renewal calendar'} →</button></div>`;
  if (role() === 'customer') {
    return `<div class="welcome-card card"><div><div class="eyebrow" style="color:#82e6d0">YOUR SUBSCRIPTIONS</div><h2>Everything about your plan, in one place.</h2><p>See your billing dates, invoices and plan status whenever you need them.</p></div><button class="btn" data-action="nav" data-view="subscriptions">View my plans →</button></div>${renewalNotice}<div class="stat-grid">${stat('Active subscriptions',d.active,'Your current plans')}${stat('Next billing date',d.next_billing_date?dateText(d.next_billing_date):'—','Upcoming renewal')}${stat('Open balance',money(d.outstanding_cents),'Across your invoices',d.outstanding_cents>0)}${stat('Invoices',d.invoices,'Your billing history')}</div><div class="section-grid"><div class="card"><div class="card-pad card-head"><div><h2>My latest invoices</h2><p>Keep track of what is due and what is paid.</p></div><button class="btn-link" data-action="nav" data-view="invoices">View all →</button></div>${renderInvoiceTable(invoices,true)}</div><div class="card card-pad"><div class="card-head"><h2>My subscriptions</h2></div>${subs.length?`<div class="mini-list">${subs.map(s=>`<div class="mini-row"><div><strong>${esc(s.plan_name)}</strong><small>${esc(s.number)} · ${esc(s.cycle)}</small></div>${badge(s.status)}</div>`).join('')}</div>`:empty('No subscriptions yet','Your team will add one when your quotation is accepted.')}</div></div>`;
  }
  return `<div class="welcome-card card"><div><div class="eyebrow" style="color:#82e6d0">BILLING DAY, HANDLED</div><h2>${d.due_today?`${d.due_today} subscription${d.due_today===1?' is':'s are'} ready to bill.`:'Your billing queue is clear.'}</h2><p>Generate invoices from active subscriptions, with discounts and taxes applied automatically. The same period cannot be invoiced twice.</p></div><button class="btn" data-action="run-billing">Run billing →</button></div>${renewalNotice}<div class="stat-grid">${stat('Active subscriptions',d.active,'Currently running')}${stat('Gross monthly equivalent',money(d.mrr_cents),'Before discounts and tax')}${stat('Payments received',money(d.revenue_cents),'All recorded payments')}${stat('Outstanding',money(d.outstanding_cents),`${d.overdue} overdue invoice${d.overdue===1?'':'s'}`,d.outstanding_cents>0)}</div><div class="section-grid"><div class="card"><div class="card-pad card-head"><div><h2>Latest invoices</h2><p>Recent billing activity across customers.</p></div><button class="btn-link" data-action="nav" data-view="invoices">View all →</button></div>${renderInvoiceTable(invoices,false)}</div><div class="card card-pad"><div class="card-head"><h2>Quick actions</h2></div><div class="stack"><button class="btn btn-soft" data-action="new-quote">+ Create a quotation</button><button class="btn btn-ghost" data-action="new-payment">◉ Record a payment</button>${role()==='admin'?`<button class="btn btn-ghost" data-action="new-plan">◈ Add a new plan</button>`:''}</div><div class="role-note" style="margin:1.2rem 0 0">${d.customers} customer${d.customers===1?'':'s'} · ${d.due_today} due for billing today</div></div></div>`;
}

function renewalLabel(event) {
  if (event.kind === 'billed') return `Billed · ${event.invoice_status}`;
  if (event.phase === 'overdue') return 'Overdue';
  if (event.phase === 'due_today') return 'Due today';
  return event.days_until <= 7 ? 'Due soon' : 'Scheduled';
}

function renewalAlertList(events, emptyMessage) {
  if (!events.length) return `<p class="renewal-empty">${esc(emptyMessage)}</p>`;
  return `<div class="renewal-alert-list">${events.map(event => `<button class="renewal-alert-row" data-action="renewal-detail" data-key="${esc(event.key)}"><span><strong>${esc(canWork() ? event.customer_name : event.plan_name)}</strong><small>${esc(canWork() ? event.plan_name + ' · ' + event.subscription_number : event.subscription_number)} · ${dateText(event.renewal_date)}</small></span><span class="renewal-alert-right"><strong>${money(event.amount_due_cents)}</strong><small class="renewal-phase ${esc(event.phase)}">${esc(renewalLabel(event))}</small></span></button>`).join('')}</div>`;
}

function renderRenewals() {
  const data = state.data.renewals;
  if (!data) return empty('Renewals are loading');
  const [year, monthNumber] = data.month.split('-').map(Number);
  const first = new Date(year, monthNumber - 1, 1, 12);
  const daysInMonth = new Date(year, monthNumber, 0, 12).getDate();
  const offset = (first.getDay() + 6) % 7;
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;
  const eventsByDay = new Map();
  for (const event of data.calendar) {
    const day = Number(event.renewal_date.slice(-2));
    if (!eventsByDay.has(day)) eventsByDay.set(day, []);
    eventsByDay.get(day).push(event);
  }
  const cells = Array.from({length:cellCount}, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > daysInMonth) return '<div class="renewal-day outside" aria-hidden="true"></div>';
    const dayIso = `${data.month}-${String(day).padStart(2,'0')}`;
    const events = eventsByDay.get(day) || [];
    return `<div class="renewal-day ${dayIso === data.today ? 'today' : ''}"><div class="renewal-day-number">${day}${dayIso === data.today ? '<span>Today</span>' : ''}</div>${events.map(event => `<button class="renewal-event ${esc(event.phase)}" data-action="renewal-detail" data-key="${esc(event.key)}" title="${esc(event.plan_name + ' · ' + renewalLabel(event) + ' · ' + money(event.amount_due_cents))}"><strong>${esc(canWork() ? event.customer_name : event.plan_name)}</strong><span>${money(event.amount_due_cents)}</span></button>`).join('')}</div>`;
  }).join('');
  const summary = data.summary;
  return `<div class="stat-grid">${stat('Due in 7 days',summary.due_soon,'Active renewals')}${stat('Overdue',summary.overdue,'Billing date has passed',summary.overdue>0)}${stat('Scheduled this month',summary.scheduled_month,'Next billing dates')}${stat('Billed this month',summary.billed_month,'Invoice periods created')}</div>
    <div class="card renewal-calendar"><div class="renewal-calendar-head"><div><div class="eyebrow">RENEWAL SCHEDULE</div><h2>${first.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</h2><p>Select a renewal to see the subscription, customer, and amount.</p></div><div class="button-row"><button class="btn btn-sm btn-ghost" data-action="renewal-prev" aria-label="Previous month">←</button><button class="btn btn-sm btn-soft" data-action="renewal-today">This month</button><button class="btn btn-sm btn-ghost" data-action="renewal-next" aria-label="Next month">→</button></div></div><div class="renewal-legend"><span><i class="legend-dot upcoming"></i>Scheduled</span><span><i class="legend-dot due_today"></i>Due today</span><span><i class="legend-dot overdue"></i>Overdue</span><span><i class="legend-dot billed"></i>Billed</span></div><div class="renewal-calendar-scroll"><div class="renewal-grid">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => `<div class="renewal-weekday">${day}</div>`).join('')}${cells}</div></div></div>
    <div class="renewal-alert-grid"><section class="card card-pad"><div class="renewal-alert-head"><h2>Upcoming renewals</h2><span class="pill">Next 7 days · ${summary.due_soon}</span></div>${renewalAlertList(data.alerts.upcoming,'No renewals are due in the next 7 days.')}</section><section class="card card-pad"><div class="renewal-alert-head"><h2>Overdue renewals</h2><span class="pill">${summary.overdue} need billing</span></div>${renewalAlertList(data.alerts.overdue,'No overdue renewals.')}</section><section class="card card-pad"><div class="renewal-alert-head"><h2>Already billed</h2><span class="pill">${summary.billed_month} this month</span></div>${renewalAlertList(data.alerts.billed,'No renewal invoices for this month.')}</section></div>`;
}

function renewalDetail(key) {
  const data = state.data.renewals;
  const event = [...data.calendar, ...data.alerts.upcoming, ...data.alerts.overdue, ...data.alerts.billed].find(item => item.key === key);
  if (!event) return;
  const customer = canWork() ? `<div><dt>Customer</dt><dd>${esc(event.customer_name)}<br><span class="muted">${esc(event.customer_email)}</span></dd></div>` : '';
  const invoice = event.kind === 'billed' ? `<div><dt>Invoice</dt><dd>${esc(event.invoice_number)} · ${badge(event.invoice_status)}</dd></div>` : '';
  const body = `<dl class="detail-list">${customer}<div><dt>Subscription</dt><dd>${esc(event.subscription_number)}</dd></div><div><dt>Plan</dt><dd>${esc(event.plan_name)} · ${esc(event.cycle)}</dd></div><div><dt>Renewal date</dt><dd>${dateText(event.renewal_date)}</dd></div><div><dt>Status</dt><dd>${esc(renewalLabel(event))}</dd></div><div><dt>${event.kind === 'billed' ? 'Invoiced amount' : 'Estimated amount due'}</dt><dd>${money(event.amount_due_cents)}</dd></div>${invoice}</dl>${event.kind === 'scheduled' ? `<h3>Estimated charges</h3>${table(['Product','Qty','Total'],event.lines.map(line => `<tr><td>${esc(line.description)}</td><td>${line.quantity}</td><td>${money(line.total_cents)}</td></tr>`))}<div class="renewal-price-lines"><div><span>Subtotal</span><strong>${money(event.subtotal_cents)}</strong></div><div><span>Discount</span><strong>−${money(event.discount_cents)}</strong></div><div><span>Tax</span><strong>${money(event.tax_cents)}</strong></div><div class="grand"><span>Estimated total</span><strong>${money(event.amount_due_cents)}</strong></div></div><p class="small muted">Estimate uses the current discount and tax rules. The invoice is final when billing runs.</p>` : `<p class="small muted">This renewal has an invoice. Open Invoices to review its payment status and full details.</p>`}`;
  const footerAction = event.kind === 'billed' ? `<button class="btn btn-primary" data-action="renewal-invoices">View invoices</button>`
    : canWork() && ['overdue','due_today'].includes(event.phase) ? `<button class="btn btn-primary" data-action="run-billing">Run billing</button>` : '';
  showDetails(event.kind === 'billed' ? 'Billed renewal' : 'Scheduled renewal', body, `<button class="btn btn-ghost" data-action="close-modal">Close</button>${footerAction}`);
}

async function changeRenewalMonth(offset) {
  const [year, month] = (state.renewalMonth || today().slice(0,7)).split('-').map(Number);
  const next = new Date(year, month - 1 + offset, 1, 12);
  const candidate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2,'0')}`;
  await selectRenewalMonth(candidate);
}

async function selectRenewalMonth(candidate) {
  const data = await api(`/api/renewals?month=${candidate}`);
  state.renewalMonth = candidate;
  state.data.renewals = data;
  renderApp();
}

function renderCatalog() {
  const products = items('products'), plans = items('plans'), taxes=items('taxes'), discounts=items('discounts');
  const per={daily:'day',weekly:'week',monthly:'month',yearly:'year'};
  return `<div class="role-note">Only admins can create billing rules. Staff use these rules when preparing subscriptions and invoices.</div><section class="catalog-section">${sectionHead('Products & variants',`<div class="button-row"><button class="btn btn-sm btn-ghost" data-action="new-variant">+ Variant</button><button class="btn btn-sm btn-primary" data-action="new-product">+ Product</button></div>`)}<div class="grid-three">${products.map(p=>`<div class="card catalog-card"><div class="type">${esc(p.type)}</div><h3>${esc(p.name)}</h3><div class="price">${money(p.sales_price_cents)}</div><p class="meta">Cost ${money(p.cost_price_cents)} · ${p.tax_name?`${esc(p.tax_name)} ${p.tax_rate}%`:'No tax'}<br>${p.variants.length?`Variants: ${p.variants.map(v=>`${esc(v.name)} (+${money(v.price_delta_cents)})`).join(', ')}`:'No variants yet'}</p></div>`).join('') || empty('No products yet')}</div></section><section class="catalog-section">${sectionHead('Billing plans',`<button class="btn btn-sm btn-primary" data-action="new-plan">+ Plan</button>`)}<div class="grid-three">${plans.map(p=>`<div class="card catalog-card"><div class="type">${esc(p.product_name)} · ${esc(p.cycle)}</div><h3>${esc(p.name)}</h3><div class="price">${money(p.price_cents)} <span class="small muted">/ ${per[p.cycle]}</span></div><p class="meta">Minimum ${p.min_quantity} · ${p.allow_pause?'Can pause':'No pause'} · ${p.allow_early_close?'Can close early':'Fixed term'}${p.available_until?`<br>Available until ${dateText(p.available_until)}`:''}</p></div>`).join('') || empty('No plans yet')}</div></section><div class="grid-two catalog-section"><section><div class="list-head"><h2>Tax rules</h2><button class="btn btn-sm btn-primary" data-action="new-tax">+ Tax</button></div><div class="card card-pad">${taxes.length?taxes.map(t=>`<div class="mini-row"><div><strong>${esc(t.name)}</strong><small>Applied to products using this tax</small></div><strong>${esc(t.rate)}%</strong></div>`).join(''):empty('No taxes')}</div></section><section><div class="list-head"><h2>Discount rules</h2><button class="btn btn-sm btn-primary" data-action="new-discount">+ Discount</button></div><div class="card card-pad">${discounts.length?discounts.map(d=>`<div class="mini-row"><div><strong>${esc(d.code)}</strong><small>${esc(d.scope)} · ${d.usage_limit?`${d.usage_count}/${d.usage_limit} uses`:'Unlimited uses'}</small></div><strong>${d.kind==='percent'?`${d.value}%`:money(Math.round(d.value*100))}</strong></div>`).join(''):empty('No discounts')}</div></section></div>`;
}

function renderTemplates() {
  const rows=items('templates').map(t=>`<tr><td><strong>${esc(t.name)}</strong><span class="subtext">${esc(t.notes)}</span></td><td>${esc(t.plan_name)}</td><td>${t.quantity}</td><td>${t.valid_days} days</td><td><button class="btn btn-sm btn-soft" data-action="quote-from-template" data-id="${t.id}">Use template</button></td></tr>`);
  return `${sectionHead('Reusable offers',`<button class="btn btn-primary" data-action="new-template">+ New template</button>`)}<div class="card">${table(['Template','Plan','Quantity','Valid for','Action'],rows,'No quotation templates yet')}</div>`;
}
function renderStaff() {
  const rows=items('staff').map(u=>`<tr><td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td><td>${dateText(u.created_at.slice(0,10))}</td><td>${badge('Active')}</td></tr>`);
  return `<div class="role-note">Staff can handle customers, quotations, subscriptions, invoices and payments. Only an admin can add staff or set tax and discount rules.</div>${sectionHead('Team members',`<button class="btn btn-primary" data-action="new-staff">+ Add staff</button>`)}<div class="card">${table(['Name','Email','Added','Status'],rows,'No staff accounts yet')}</div>`;
}
function renderCustomers() {
  const rows=items('customers').map(u=>`<tr><td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td><td>${dateText(u.created_at.slice(0,10))}</td><td>${items('subscriptions').filter(s=>s.customer_id===u.id).length} recent</td></tr>`);
  return `<div class="role-note">Customers can sign up themselves. Their portal shows only their own subscriptions and invoices.</div>${sectionHead('Customer directory')}<div class="card">${table(['Customer','Email','Joined','Subscriptions'],rows,'No customers yet')}</div>`;
}

function subActions(sub) {
  const actions=[];
  if (canWork()) {
    if (sub.status==='Draft') actions.push(['quote','Send to quote']);
    if (sub.status==='Quotation') actions.push(['confirm','Confirm']);
    if (sub.status==='Confirmed') actions.push(['activate','Activate']);
  }
  if (sub.status==='Active' && sub.allow_pause) actions.push(['pause','Pause']);
  if (sub.status==='Paused' && sub.allow_pause) actions.push(['resume','Resume']);
  if (['Active','Paused','Confirmed'].includes(sub.status) && sub.allow_early_close) actions.push(['close','Close']);
  if ((sub.status==='Closed' || (sub.status==='Active' && sub.expiry_date && sub.expiry_date < today())) && sub.allow_renew) actions.push(['renew','Renew']);
  return actions.map(([action,label])=>`<button class="btn btn-sm btn-soft" data-action="sub-status" data-id="${sub.id}" data-status="${action}">${label}</button>`).join('');
}
function renderSubscriptions() {
  const subs=items('subscriptions');
  const query=(state.filter.subQuery||'').toLowerCase();
  const status=state.filter.subStatus||'';
  const filtered=subs.filter(s=>(!status||s.status===status)&&(!query||`${s.number} ${s.customer_name} ${s.plan_name}`.toLowerCase().includes(query)));
  const rows=filtered.map(s=>`<tr><td><button class="btn-link" data-action="sub-detail" data-id="${s.id}">${esc(s.number)}</button><span class="subtext">${dateText(s.start_date)}</span></td>${canWork()?`<td><strong>${esc(s.customer_name)}</strong><span class="subtext">${esc(s.customer_email)}</span></td>`:''}<td>${esc(s.plan_name)}<span class="subtext">${esc(s.cycle)} billing</span></td><td>${badge(s.status)}</td><td>${dateText(s.next_billing_date)}</td><td><div class="inline-actions">${subActions(s)||'<span class="muted">—</span>'}</div></td></tr>`);
  return `<div class="list-head"><h2>${canWork()?'Subscription pipeline':'Your plans'}</h2><div class="filters"><input class="search-input" id="sub-search" placeholder="Search subscriptions" value="${esc(state.filter.subQuery||'')}"><select id="sub-filter"><option value="">All statuses</option>${['Draft','Quotation','Confirmed','Active','Paused','Closed'].map(x=>`<option ${status===x?'selected':''}>${x}</option>`).join('')}</select></div></div><div class="card">${table(['Number',...(canWork()?['Customer']:[]),'Plan','Status','Next bill','Actions'],rows,'No subscriptions match')}</div><p class="small muted" style="margin:1rem 0">Showing the latest ${subs.length} subscriptions. Use the filters to narrow this view.</p>`;
}

function invoiceActions(invoice) {
  if (!canWork()) return `<button class="btn btn-sm btn-soft" data-action="invoice-detail" data-id="${invoice.id}">View invoice</button>`;
  const buttons=[];
  if (invoice.status==='Draft') buttons.push(`<button class="btn btn-sm btn-soft" data-action="invoice-action" data-id="${invoice.id}" data-invoice-action="confirm">Confirm</button>`);
  if (['Draft','Confirmed'].includes(invoice.status)) buttons.push(`<button class="btn btn-sm btn-ghost" data-action="invoice-action" data-id="${invoice.id}" data-invoice-action="send">Mark sent</button>`);
  if (invoice.status==='Confirmed' && invoice.outstanding_cents>0) buttons.push(`<button class="btn btn-sm btn-primary" data-action="pay-invoice" data-id="${invoice.id}">Record payment</button>`);
  if (['Draft','Confirmed'].includes(invoice.status)) buttons.push(`<button class="btn btn-sm btn-danger" data-action="invoice-action" data-id="${invoice.id}" data-invoice-action="cancel">Cancel</button>`);
  buttons.push(`<button class="btn btn-sm btn-ghost" data-action="invoice-detail" data-id="${invoice.id}">View</button>`);
  return buttons.join('');
}
function renderInvoiceTable(invoices, customer) {
  return table(['Invoice',...(customer?[]:['Customer']),'Due','Amount','Status','Action'],invoices.map(i=>`<tr><td><strong>${esc(i.number)}</strong><span class="subtext">${esc(i.subscription_number)}</span></td>${customer?'':`<td>${esc(i.customer_name)}</td>`}<td>${dateText(i.due_date)}${i.overdue?'<span class="subtext" style="color:#ba5945">Overdue</span>':''}</td><td><strong>${money(i.total_cents)}</strong><span class="subtext">${i.outstanding_cents?`${money(i.outstanding_cents)} open`:'Settled'}</span></td><td>${badge(i.status)}</td><td><div class="inline-actions">${invoiceActions(i)}</div></td></tr>`),'No invoices yet');
}
function renderInvoices() {
  const invoices=items('invoices');
  const status=state.filter.invoiceStatus||'';
  const filtered=invoices.filter(i=>!status||i.status===status);
  return `<div class="list-head"><h2>${canWork()?'Invoice ledger':'Your invoice history'}</h2><div class="filters"><select id="invoice-filter"><option value="">All statuses</option>${['Draft','Confirmed','Paid','Cancelled'].map(x=>`<option ${status===x?'selected':''}>${x}</option>`).join('')}</select></div></div><div class="card">${renderInvoiceTable(filtered,!canWork())}</div><p class="small muted" style="margin:1rem 0">Invoices are generated once per subscription and billing period. Showing the latest ${invoices.length}.</p>`;
}
function renderPayments() {
  const rows=items('payments').map(p=>`<tr><td><strong>${esc(p.invoice_number)}</strong></td><td>${esc(p.customer_name)}</td><td>${money(p.amount_cents)}</td><td>${esc(p.method)}</td><td>${dateText(p.paid_on)}</td><td>${esc(p.note||'—')}</td></tr>`);
  return `${sectionHead('Recorded payments')}<div class="card">${table(['Invoice','Customer','Amount','Method','Date','Note'],rows,'No payments recorded yet')}</div>`;
}
function renderReports() {
  const d=state.data.dashboard||{};
  const r=state.data.reports||{};
  const statuses=['Draft','Confirmed','Paid','Cancelled'];
  const counts=r.status_counts||{};
  const max=Math.max(1,...statuses.map(s=>counts[s]||0));
  const from=state.filter.reportFrom||`${today().slice(0,8)}01`;
  const to=state.filter.reportTo||today();
  return `<div class="card card-pad" style="margin-bottom:1rem"><div class="split-head"><div><h2 style="margin:0">Choose a date range</h2><p class="small muted" style="margin:.3rem 0 0">Invoice dates and payment dates are filtered separately.</p></div><div class="filters"><input class="search-input" id="report-from" type="date" value="${from}" aria-label="From date"><input class="search-input" id="report-to" type="date" value="${to}" aria-label="To date"><button class="btn btn-primary" data-action="apply-report">Apply</button></div></div></div><div class="stat-grid">${stat('Invoiced',money(r.invoiced_cents),'For selected invoice dates')}${stat('Payments received',money(r.revenue_cents),'For selected payment dates')}${stat('Outstanding',money(r.outstanding_cents),`${r.overdue||0} overdue`,r.outstanding_cents>0)}${stat('Gross monthly equivalent',money(d.mrr_cents),'Current active subscriptions')}</div><div class="section-grid"><div class="card card-pad"><div class="card-head"><div><h2>Invoice pipeline</h2><p>All invoices in the selected range.</p></div></div>${statuses.map(s=>{const count=counts[s]||0;return `<div style="display:grid;grid-template-columns:85px 1fr 35px;gap:.8rem;align-items:center;margin:1rem 0;font-size:.8rem"><strong>${s}</strong><div style="height:11px;border-radius:9px;background:#edf3f0;overflow:hidden"><div style="width:${count/max*100}%;height:100%;border-radius:9px;background:${s==='Paid'?'#1ca888':s==='Confirmed'?'#5b90c6':s==='Cancelled'?'#dc8778':'#a8bdba'}"></div></div><span>${count}</span></div>`}).join('')}</div><div class="card card-pad"><div class="card-head"><h2>Needs attention</h2></div><div class="mini-list"><div class="mini-row"><div><strong>Billing queue</strong><small>Active subscriptions due now</small></div><span class="pill">${d.due_today}</span></div><div class="mini-row"><div><strong>Overdue invoices</strong><small>In selected invoice dates</small></div><span class="pill">${r.overdue||0}</span></div><div class="mini-row"><div><strong>Customer accounts</strong><small>Registered customers</small></div><span class="pill">${d.customers}</span></div></div><button class="btn btn-soft" style="width:100%;margin-top:1rem" data-action="nav" data-view="invoices">Review invoices →</button></div></div>`;
}
function renderAccount() {
  return `<div class="card card-pad profile-card"><div class="card-head"><h2>Profile</h2></div><div class="profile-row"><span class="muted">Name</span><strong>${esc(state.user.name)}</strong></div><div class="profile-row"><span class="muted">Email</span><strong>${esc(state.user.email)}</strong></div><div class="profile-row"><span class="muted">Access</span><strong>Customer portal</strong></div><p class="small muted" style="margin:1.2rem 0 0">Need to change your password? Sign out and use the password reset link on the sign in page.</p></div>`;
}

function showForm(title, fields, submitLabel, onSubmit) {
  const control = field => {
    const value=field.value ?? '';
    if (field.type==='checkbox') return `<div class="field checkbox-field ${field.full?'full':''}"><input id="f-${field.name}" name="${field.name}" type="checkbox" ${value?'checked':''}><label for="f-${field.name}">${esc(field.label)}</label></div>`;
    const attributes=`id="f-${field.name}" name="${field.name}" ${field.required?'required':''} ${field.min!==undefined?`min="${field.min}"`:''} ${field.step!==undefined?`step="${field.step}"`:''} ${field.placeholder?`placeholder="${esc(field.placeholder)}"`:''}`;
    const input=field.type==='select'?`<select ${attributes}>${(field.options||[]).map(option=>`<option value="${esc(option.value)}" ${String(option.value)===String(value)?'selected':''}>${esc(option.label)}</option>`).join('')}</select>`:field.type==='textarea'?`<textarea ${attributes}>${esc(value)}</textarea>`:`<input type="${field.type||'text'}" ${attributes} value="${esc(value)}">`;
    return `<div class="field ${field.full?'full':''}"><label for="f-${field.name}">${esc(field.label)}</label>${input}</div>`;
  };
  modalRoot.innerHTML=`<div class="modal-backdrop" data-action="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h2>${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">×</button></div><form id="modal-form"><div class="modal-body"><div class="form-grid">${fields.map(control).join('')}</div></div><div class="modal-footer"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${esc(submitLabel)}</button></div></form></div></div>`;
  const form=document.getElementById('modal-form');
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=form.querySelector('[type=submit]');button.disabled=true;
    const values=Object.fromEntries(new FormData(form));
    for(const field of fields) if(field.type==='checkbox') values[field.name]=form.elements[field.name].checked;
    try{await onSubmit(values);closeModal();}catch(error){toast(error.message,true);}finally{button.disabled=false;}
  };
  form.querySelector('input,select,textarea')?.focus();
  return form;
}
function closeModal(){modalRoot.innerHTML='';}
const optionList=(list,label='name')=>[{value:'',label:'Choose…'},...list.map(item=>({value:item.id,label:item[label]}))];

function newProduct(){showForm('Add product',[{name:'name',label:'Product name',required:true},{name:'type',label:'Type',type:'select',options:[{value:'Software',label:'Software'},{value:'Add-on',label:'Add-on'},{value:'Service',label:'Service'}]},{name:'sales_price',label:'Sales price (₹)',type:'number',step:'.01',min:0,required:true},{name:'cost_price',label:'Cost price (₹)',type:'number',step:'.01',min:0,value:0},{name:'tax_id',label:'Tax rule',type:'select',options:optionList(items('taxes'))},{name:'notes',label:'Notes',type:'textarea',full:true}], 'Create product',async v=>{await api('/api/products','POST',v);await refresh('Product created.');});}
function newVariant(){showForm('Add product variant',[{name:'product_id',label:'Product',type:'select',options:optionList(items('products')),required:true},{name:'name',label:'Variant name',required:true,placeholder:'e.g. Odoo brand'},{name:'price_delta',label:'Add to price (₹)',type:'number',step:'.01',min:0,value:0,required:true}], 'Create variant',async v=>{await api('/api/variants','POST',v);await refresh('Variant added.');});}
function newPlan(){showForm('Create billing plan',[{name:'name',label:'Plan name',required:true,placeholder:'e.g. Growth Monthly'},{name:'product_id',label:'Product',type:'select',options:optionList(items('products')),required:true},{name:'price',label:'Price per cycle (₹)',type:'number',step:'.01',min:0,required:true},{name:'cycle',label:'Billing frequency',type:'select',options:['daily','weekly','monthly','yearly'].map(x=>({value:x,label:x[0].toUpperCase()+x.slice(1)}))},{name:'min_quantity',label:'Minimum quantity',type:'number',min:1,value:1},{name:'available_from',label:'Available from',type:'date'},{name:'available_until',label:'Available until',type:'date'},{name:'allow_pause',label:'Allow pause and resume',type:'checkbox'},{name:'allow_early_close',label:'Allow early close',type:'checkbox'},{name:'allow_renew',label:'Allow renewal',type:'checkbox',value:true},{name:'auto_close',label:'Close when plan ends',type:'checkbox'}], 'Create plan',async v=>{await api('/api/plans','POST',v);await refresh('Plan created.');});}
function newTax(){showForm('Create tax rule',[{name:'name',label:'Tax name',required:true,placeholder:'e.g. GST'},{name:'rate',label:'Rate (%)',type:'number',step:'.01',min:0,required:true}], 'Create tax',async v=>{await api('/api/taxes','POST',v);await refresh('Tax rule created.');});}
function newDiscount(){const form=showForm('Create discount rule',[{name:'code',label:'Code',required:true,placeholder:'e.g. SAVE10'},{name:'kind',label:'Discount type',type:'select',options:[{value:'percent',label:'Percentage'},{value:'fixed',label:'Fixed amount (₹)'}]},{name:'value',label:'Value',type:'number',step:'.01',min:0,required:true},{name:'scope',label:'Applies to',type:'select',options:[{value:'subscription',label:'Whole subscription'},{value:'product',label:'One product'}]},{name:'product_id',label:'Product (if selected above)',type:'select',options:optionList(items('products'))},{name:'min_purchase',label:'Minimum purchase (₹)',type:'number',step:'.01',min:0,value:0},{name:'min_quantity',label:'Minimum quantity',type:'number',min:1,value:1},{name:'usage_limit',label:'Usage limit (blank = unlimited)',type:'number',min:1},{name:'starts_on',label:'Starts on',type:'date'},{name:'ends_on',label:'Ends on',type:'date'}], 'Create discount',async v=>{await api('/api/discounts','POST',v);await refresh('Discount rule created.');});return form;}
function newTemplate(){showForm('New quotation template',[{name:'name',label:'Template name',required:true},{name:'plan_id',label:'Plan',type:'select',options:optionList(items('plans')),required:true},{name:'quantity',label:'Default quantity',type:'number',min:1,value:1},{name:'valid_days',label:'Valid for (days)',type:'number',min:1,value:14},{name:'notes',label:'Notes',type:'textarea',full:true}], 'Create template',async v=>{await api('/api/templates','POST',v);await refresh('Template created.');});}
function newStaff(){showForm('Add staff member',[{name:'name',label:'Full name',required:true},{name:'email',label:'Email',type:'email',required:true},{name:'password',label:'Temporary password',type:'password',required:true,full:true,placeholder:'9+ characters, upper/lowercase and a symbol'}], 'Add staff',async v=>{await api('/api/staff','POST',v);await refresh('Staff account created.');});}

function newQuote(templateId=null){
  const templates=items('templates'),plans=items('plans'),products=items('products');
  const template=templates.find(t=>t.id===Number(templateId));
  const firstPlan=plans.find(p=>p.id===Number(template?.plan_id))||plans[0];
  if(!items('customers').length){toast('A customer account is needed before you can create a quotation.',true);return;}
  if(!firstPlan){toast('Create a plan before making a quotation.',true);return;}
  const variantOptions=plan=>optionList(products.find(p=>p.id===plan?.product_id)?.variants||[]);
  const form=showForm('Create customer quotation',[{name:'customer_id',label:'Customer',type:'select',options:optionList(items('customers')),required:true},{name:'template_id',label:'Start from template',type:'select',options:optionList(templates)},{name:'plan_id',label:'Billing plan',type:'select',options:optionList(plans),value:firstPlan.id,required:true},{name:'quantity',label:'Quantity',type:'number',min:1,value:template?.quantity||firstPlan.min_quantity||1},{name:'variant_id',label:'Product variant',type:'select',options:variantOptions(firstPlan)},{name:'addon_product_id',label:'Optional add-on',type:'select',options:optionList(products.filter(p=>p.id!==firstPlan.product_id))},{name:'addon_quantity',label:'Add-on quantity',type:'number',min:1,value:1},{name:'discount_id',label:'Discount rule',type:'select',options:optionList(items('discounts'),'code')},{name:'start_date',label:'Start date',type:'date',value:today(),required:true},{name:'expiry_date',label:'Expiry date',type:'date'},{name:'payment_terms_days',label:'Payment terms (days)',type:'number',min:0,value:14},{name:'valid_days',label:'Quote valid for (days)',type:'number',min:1,value:template?.valid_days||14},{name:'status',label:'Save as',type:'select',options:[{value:'Quotation',label:'Quotation'},{value:'Draft',label:'Draft'}]}], 'Create quotation',async v=>{delete v.template_id;await api('/api/subscriptions','POST',v);await refresh('Subscription saved. Confirm and activate it when the customer accepts.');});
  const updatePlan=()=>{const p=plans.find(x=>x.id===Number(form.elements.plan_id.value));form.elements.variant_id.innerHTML=variantOptions(p).map(o=>`<option value="${o.value}">${esc(o.label)}</option>`).join('');form.elements.addon_product_id.innerHTML=optionList(products.filter(x=>x.id!==p?.product_id)).map(o=>`<option value="${o.value}">${esc(o.label)}</option>`).join('');form.elements.quantity.min=p?.min_quantity||1;};
  form.elements.plan_id.addEventListener('change',updatePlan);
  form.elements.template_id.addEventListener('change',()=>{const t=templates.find(x=>x.id===Number(form.elements.template_id.value));if(t){form.elements.plan_id.value=t.plan_id;form.elements.quantity.value=t.quantity;form.elements.valid_days.value=t.valid_days;updatePlan();}});
  if(template)form.elements.template_id.value=template.id;
}

function newPayment(invoiceId=null){
  const invoices=items('invoices').filter(i=>i.status==='Confirmed' && i.outstanding_cents>0);
  if(!invoices.length){toast('Confirm an invoice before recording a payment.',true);return;}
  const initial=invoices.find(i=>i.id===Number(invoiceId))||invoices[0];
  const form=showForm('Record invoice payment',[{name:'invoice_id',label:'Invoice',type:'select',options:invoices.map(i=>({value:i.id,label:`${i.number} · ${i.customer_name} · ${money(i.outstanding_cents)} open`})),value:initial.id},{name:'amount',label:'Amount received (₹)',type:'number',step:'.01',min:.01,value:(initial.outstanding_cents/100).toFixed(2),required:true},{name:'method',label:'Payment method',type:'select',options:['Bank transfer','Card','UPI','Cash','Other'].map(x=>({value:x,label:x}))},{name:'paid_on',label:'Payment date',type:'date',value:today(),required:true},{name:'note',label:'Note or reference',type:'textarea',full:true}], 'Save payment',async v=>{await api('/api/payments','POST',v);await refresh('Payment recorded and invoice balance updated.');});
  form.elements.invoice_id.addEventListener('change',()=>{const i=invoices.find(x=>x.id===Number(form.elements.invoice_id.value));if(i)form.elements.amount.value=(i.outstanding_cents/100).toFixed(2);});
}

function showDetails(title,body,footer=''){
  modalRoot.innerHTML=`<div class="modal-backdrop" data-action="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h2>${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}</div></div>`;
}
function subDetail(id){const s=items('subscriptions').find(x=>x.id===Number(id));if(!s)return;showDetails(s.number,`<dl class="detail-list"><div><dt>Customer</dt><dd>${esc(s.customer_name)}</dd></div><div><dt>Plan</dt><dd>${esc(s.plan_name)}</dd></div><div><dt>Status</dt><dd>${badge(s.status)}</dd></div><div><dt>Billing cycle</dt><dd>${esc(s.cycle)}</dd></div><div><dt>Start date</dt><dd>${dateText(s.start_date)}</dd></div><div><dt>Next billing</dt><dd>${dateText(s.next_billing_date)}</dd></div><div><dt>Expiry</dt><dd>${dateText(s.expiry_date)}</dd></div><div><dt>Payment terms</dt><dd>${s.payment_terms_days} days</dd></div><div><dt>Discount</dt><dd>${esc(s.discount_code||'None')}</dd></div><div><dt>Quote valid until</dt><dd>${dateText(s.quote_valid_until)}</dd></div></dl><h3>Product lines</h3>${table(['Product','Qty','Unit price'],s.lines.map(l=>`<tr><td>${esc(l.description)}</td><td>${l.quantity}</td><td>${money(l.unit_price_cents)}</td></tr>`))}`,`<button class="btn btn-ghost" data-action="close-modal">Close</button>${subActions(s)}`);}
function invoicePaper(i){return `<div class="invoice-paper"><div class="split-head"><div><div class="brand"><div class="brand-mark">b</div>brightloop</div><p class="small muted" style="margin:.5rem 0 0">Subscription invoice</p></div><div style="text-align:right"><h3 style="margin:0">${esc(i.number)}</h3>${badge(i.status)}</div></div><dl class="detail-list" style="margin:1.4rem 0"><div><dt>Billed to</dt><dd>${esc(i.customer_name)}</dd></div><div><dt>Subscription</dt><dd>${esc(i.subscription_number)}</dd></div><div><dt>Billing period begins</dt><dd>${dateText(i.period_start)}</dd></div><div><dt>Due date</dt><dd>${dateText(i.due_date)}</dd></div></dl>${table(['Item','Qty','Unit','Discount','Tax','Total'],i.lines.map(l=>`<tr><td>${esc(l.description)}</td><td>${l.quantity}</td><td>${money(l.unit_price_cents)}</td><td>${money(l.discount_cents)}</td><td>${money(l.tax_cents)}</td><td>${money(l.total_cents)}</td></tr>`))}<div style="max-width:280px;margin:1rem 0 0 auto"><div class="invoice-total"><span>Subtotal</span><span>${money(i.subtotal_cents)}</span></div><div class="invoice-total"><span>Discount</span><span>− ${money(i.discount_cents)}</span></div><div class="invoice-total"><span>Tax</span><span>${money(i.tax_cents)}</span></div><div class="invoice-total grand"><span>Total</span><span>${money(i.total_cents)}</span></div><div class="invoice-total"><span>Paid</span><span>${money(i.paid_cents)}</span></div><div class="invoice-total"><span>Outstanding</span><span>${money(i.outstanding_cents)}</span></div></div></div>`;}
function invoiceDetail(id){const i=items('invoices').find(x=>x.id===Number(id));if(!i)return;showDetails(i.number,invoicePaper(i),`<button class="btn btn-ghost" data-action="print-invoice" data-id="${i.id}">Print invoice</button><button class="btn btn-primary" data-action="close-modal">Done</button>`);}
function printInvoice(id){const i=items('invoices').find(x=>x.id===Number(id));if(!i)return;const win=window.open('','_blank','width=900,height=700');if(!win){toast('Allow pop-ups to print this invoice.',true);return;}win.document.write(`<!doctype html><html><head><title>${esc(i.number)}</title><style>body{font-family:Arial,sans-serif;color:#15313b;padding:30px;max-width:850px;margin:auto}.brand{font-size:24px;font-weight:bold}.brand-mark{display:none}.badge{font-size:12px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd;font-size:13px}th{background:#f3f6f4}.detail-list{display:grid;grid-template-columns:1fr 1fr;gap:10px}dt{font-size:11px;color:#777}dd{margin:3px 0 0;font-weight:bold}.invoice-total{display:flex;justify-content:space-between;padding:7px;border-bottom:1px solid #ddd}</style></head><body>${invoicePaper(i)}</body></html>`);win.document.close();win.focus();setTimeout(()=>win.print(),300);}

async function runBilling(){const result=await api('/api/billing/run','POST',{through_date:today()});await refresh(`${result.created} invoice${result.created===1?'':'s'} created. ${result.subscriptions_checked} subscription${result.subscriptions_checked===1?'':'s'} checked.`);}
async function subscriptionAction(id,action){const result=await api(`/api/subscriptions/${id}/status`,'PATCH',{action});closeModal();await refresh(`Subscription is now ${result.status.toLowerCase()}.`);}
async function invoiceAction(id,action){await api(`/api/invoices/${id}/action`,'PATCH',{action});closeModal();await refresh(action==='send'?'Invoice marked sent in this demo.':'Invoice updated.');}

document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target)return;
  const action=target.dataset.action;
  if(action==='backdrop' && event.target!==target)return;
  try{
    if(action==='nav'){state.view=target.dataset.view;state.filter={};document.getElementById('sidebar')?.classList.remove('open');renderApp();}
    else if(action==='menu')document.getElementById('sidebar')?.classList.toggle('open');
    else if(action==='close-modal'||action==='backdrop')closeModal();
    else if(action==='logout'){await api('/api/auth/logout','POST',{});state.user=null;state.data={};state.authMode='login';renderAuth();}
    else if(action.startsWith('auth-')){state.authMode=action.slice(5);renderAuth();}
    else if(action==='new-product')newProduct();
    else if(action==='new-variant')newVariant();
    else if(action==='new-plan')newPlan();
    else if(action==='new-tax')newTax();
    else if(action==='new-discount')newDiscount();
    else if(action==='new-template')newTemplate();
    else if(action==='new-staff')newStaff();
    else if(action==='new-quote')newQuote();
    else if(action==='quote-from-template')newQuote(target.dataset.id);
    else if(action==='new-payment')newPayment();
    else if(action==='pay-invoice')newPayment(target.dataset.id);
    else if(action==='run-billing')await runBilling();
    else if(action==='renewal-prev')await changeRenewalMonth(-1);
    else if(action==='renewal-next')await changeRenewalMonth(1);
    else if(action==='renewal-today')await selectRenewalMonth(today().slice(0,7));
    else if(action==='renewal-detail')renewalDetail(target.dataset.key);
    else if(action==='renewal-invoices'){closeModal();state.view='invoices';renderApp();}
    else if(action==='apply-report'){const from=document.getElementById('report-from').value,to=document.getElementById('report-to').value;const report=await api(`/api/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);state.filter.reportFrom=from;state.filter.reportTo=to;state.data.reports=report;renderApp();}
    else if(action==='sub-status')await subscriptionAction(target.dataset.id,target.dataset.status);
    else if(action==='invoice-action')await invoiceAction(target.dataset.id,target.dataset.invoiceAction);
    else if(action==='sub-detail')subDetail(target.dataset.id);
    else if(action==='invoice-detail')invoiceDetail(target.dataset.id);
    else if(action==='print-invoice')printInvoice(target.dataset.id);
  }catch(error){toast(error.message,true);}
});
document.addEventListener('change',event=>{if(event.target.id==='sub-filter'){state.filter.subStatus=event.target.value;renderApp();}if(event.target.id==='invoice-filter'){state.filter.invoiceStatus=event.target.value;renderApp();}});
document.addEventListener('input',event=>{if(event.target.id==='sub-search'){state.filter.subQuery=event.target.value;const position=event.target.selectionStart;renderApp();const field=document.getElementById('sub-search');field.focus();field.setSelectionRange(position,position);}});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeModal();});

// Initialization
localStorage.removeItem('brightloop_token'); // Clear tokens saved by older versions of the demo.
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
