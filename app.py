"""Brightloop subscription management demo. Run with: python app.py"""

from __future__ import annotations

import calendar
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("BRIGHTLOOP_DB", str(ROOT / "data" / "brightloop.db")))
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
PASSWORD_RE = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{9,}$")


class AppError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 10000")
    return db


def one(db, sql, args=()):
    row = db.execute(sql, args).fetchone()
    return dict(row) if row else None


def many(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args).fetchall()]


def required(value, label, max_len=200):
    value = str(value or "").strip()
    if not value or len(value) > max_len:
        raise AppError(400, f"{label} is required (maximum {max_len} characters).")
    return value


def integer(value, label, minimum=None, maximum=None):
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise AppError(400, f"{label} must be a whole number.")
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        raise AppError(400, f"{label} is out of range.")
    return result


def cents(value, label, minimum=0):
    try:
        result = round(float(value) * 100)
    except (TypeError, ValueError):
        raise AppError(400, f"{label} must be a number.")
    if result < minimum or result > 100_000_000_00:
        raise AppError(400, f"{label} is out of range.")
    return result


def iso(value, label):
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise AppError(400, f"{label} must be a valid date.")


def optional_iso(value, label):
    return iso(value, label) if value else None


def now():
    return datetime.now().replace(microsecond=0).isoformat()


def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 210_000)
    return f"{salt.hex()}:{digest.hex()}"


def check_password(password, stored):
    try:
        salt_hex, hash_hex = stored.split(":", 1)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 210_000)
        return hmac.compare_digest(actual, bytes.fromhex(hash_hex))
    except (ValueError, AttributeError):
        return False


def add_cycle(current: date, cycle: str, anchor: date):
    if cycle == "daily":
        return current + timedelta(days=1)
    if cycle == "weekly":
        return current + timedelta(days=7)
    if cycle == "monthly":
        month = current.month + 1
        year = current.year + (month > 12)
        month = 1 if month > 12 else month
        return date(year, month, min(anchor.day, calendar.monthrange(year, month)[1]))
    if cycle == "yearly":
        year = current.year + 1
        return date(year, anchor.month, min(anchor.day, calendar.monthrange(year, anchor.month)[1]))
    raise AppError(400, "Unknown billing cycle.")


def validate_password(password):
    if not PASSWORD_RE.match(str(password or "")):
        raise AppError(400, "Password needs 9+ characters, uppercase, lowercase, and a special character.")


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = connect()
    db.executescript("""
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','staff','customer')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS taxes (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, rate REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      sales_price_cents INTEGER NOT NULL, cost_price_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '', tax_id INTEGER REFERENCES taxes(id), active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS variants (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
      name TEXT NOT NULL, price_delta_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
      price_cents INTEGER NOT NULL, cycle TEXT NOT NULL CHECK(cycle IN ('daily','weekly','monthly','yearly')),
      min_quantity INTEGER NOT NULL DEFAULT 1, available_from TEXT, available_until TEXT,
      allow_pause INTEGER NOT NULL DEFAULT 0, allow_early_close INTEGER NOT NULL DEFAULT 0,
      allow_renew INTEGER NOT NULL DEFAULT 1, auto_close INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS discounts (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('fixed','percent')),
      value REAL NOT NULL, min_purchase_cents INTEGER NOT NULL DEFAULT 0,
      min_quantity INTEGER NOT NULL DEFAULT 1, starts_on TEXT, ends_on TEXT,
      usage_limit INTEGER, usage_count INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL CHECK(scope IN ('subscription','product')),
      product_id INTEGER REFERENCES products(id), active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan_id INTEGER NOT NULL REFERENCES plans(id),
      quantity INTEGER NOT NULL DEFAULT 1, valid_days INTEGER NOT NULL DEFAULT 14,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES users(id), plan_id INTEGER NOT NULL REFERENCES plans(id),
      start_date TEXT NOT NULL, expiry_date TEXT, next_billing_date TEXT,
      payment_terms_days INTEGER NOT NULL DEFAULT 14, quote_valid_until TEXT,
      status TEXT NOT NULL CHECK(status IN ('Draft','Quotation','Confirmed','Active','Paused','Closed')),
      discount_id INTEGER REFERENCES discounts(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscription_items (
      id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), variant_id INTEGER REFERENCES variants(id),
      description TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
      tax_id INTEGER REFERENCES taxes(id)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
      customer_id INTEGER NOT NULL REFERENCES users(id),
      period_start TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT NOT NULL,
      subtotal_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Draft','Confirmed','Paid','Cancelled')),
      sent_at TEXT, created_at TEXT NOT NULL,
      UNIQUE(subscription_id, period_start)
    );
    CREATE TABLE IF NOT EXISTS invoice_lines (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL, tax_rate REAL NOT NULL,
      tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL, method TEXT NOT NULL, paid_on TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_status_due ON subscriptions(status, next_billing_date);
    CREATE INDEX IF NOT EXISTS idx_sub_customer ON subscriptions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_customer ON invoices(customer_id);
    CREATE INDEX IF NOT EXISTS idx_invoice_due_status ON invoices(status, due_date);
    CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(invoice_date);
    CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(paid_on);
    """)
    if one(db, "SELECT id FROM users LIMIT 1"):
        db.close()
        return
    db.execute("BEGIN")
    try:
        demo_users = [
            ("Maya Admin", "admin@brightloop.test", "Admin@123!", "admin"),
            ("Sam Staff", "staff@brightloop.test", "Staff@123!", "staff"),
            ("Asha Customer", "asha@demo.test", "Customer@123!", "customer"),
        ]
        for name, email, password, role in demo_users:
            db.execute("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                       (name, email, password_hash(password), role, now()))
        tax_id = db.execute("INSERT INTO taxes(name,rate) VALUES('Demo tax',18)").lastrowid
        core_id = db.execute("INSERT INTO products(name,type,sales_price_cents,cost_price_cents,notes,tax_id) VALUES(?,?,?,?,?,?)",
                             ("Brightloop Suite", "Software", 120000, 30000, "Core business subscription", tax_id)).lastrowid
        addon_id = db.execute("INSERT INTO products(name,type,sales_price_cents,cost_price_cents,notes,tax_id) VALUES(?,?,?,?,?,?)",
                              ("Analytics Add-on", "Add-on", 35000, 8000, "Advanced insights", tax_id)).lastrowid
        db.execute("INSERT INTO variants(product_id,name,price_delta_cents) VALUES(?,?,?)", (core_id, "Odoo brand", 56000))
        monthly_id = db.execute("INSERT INTO plans(name,product_id,price_cents,cycle,min_quantity,allow_pause,allow_early_close,allow_renew) VALUES(?,?,?,?,?,?,?,?)",
                                ("Growth Monthly", core_id, 120000, "monthly", 1, 1, 1, 1)).lastrowid
        db.execute("INSERT INTO plans(name,product_id,price_cents,cycle,min_quantity,allow_pause,allow_early_close,allow_renew) VALUES(?,?,?,?,?,?,?,?)",
                   ("Growth Yearly", core_id, 1200000, "yearly", 1, 0, 0, 1))
        discount_id = db.execute("INSERT INTO discounts(code,kind,value,min_quantity,scope) VALUES(?,?,?,?,?)",
                                 ("WELCOME10", "percent", 10, 1, "subscription")).lastrowid
        db.execute("INSERT INTO templates(name,plan_id,quantity,valid_days,notes) VALUES(?,?,?,?,?)",
                   ("Growth starter offer", monthly_id, 1, 14, "Ready to send to a new customer"))
        customer_id = one(db, "SELECT id FROM users WHERE email='asha@demo.test'")["id"]
        start = date.today().isoformat()
        sub_id = db.execute("""INSERT INTO subscriptions(number,customer_id,plan_id,start_date,next_billing_date,
                     payment_terms_days,status,discount_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                            ("SUB-0001", customer_id, monthly_id, start, start, 14, "Active", discount_id, now(), now())).lastrowid
        db.execute("""INSERT INTO subscription_items(subscription_id,product_id,description,quantity,unit_price_cents,tax_id)
                   VALUES(?,?,?,?,?,?)""", (sub_id, core_id, "Brightloop Suite", 1, 120000, tax_id))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db, user_id):
    token = secrets.token_urlsafe(32)
    expiry = (datetime.now() + timedelta(days=7)).replace(microsecond=0).isoformat()
    db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", (token_hash(token), user_id, expiry))
    return token


def current_user(db, headers):
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise AppError(401, "Please sign in.")
    user = one(db, """SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id
                  WHERE s.token_hash=? AND s.expires_at>?""", (token_hash(auth[7:]), now()))
    if not user:
        raise AppError(401, "Session expired. Please sign in again.")
    return user


def allow(user, *roles):
    if user["role"] not in roles:
        raise AppError(403, "You do not have access to this action.")


def paged(db, sql, args, params):
    page = integer(params.get("page", ["1"])[0], "page", 1)
    limit = integer(params.get("limit", ["25"])[0], "limit", 1, 100)
    total = one(db, f"SELECT COUNT(*) AS n FROM ({sql})", args)["n"]
    return {"items": many(db, sql + " LIMIT ? OFFSET ?", (*args, limit, (page - 1) * limit)),
            "total": total, "page": page, "limit": limit}


def product_list(db):
    products = many(db, """SELECT p.*,t.name AS tax_name,t.rate AS tax_rate FROM products p
                     LEFT JOIN taxes t ON t.id=p.tax_id ORDER BY p.id DESC""")
    variants = many(db, "SELECT * FROM variants ORDER BY id")
    for product in products:
        product["variants"] = [v for v in variants if v["product_id"] == product["id"]]
    return products


def subscription_list(db, user, params):
    where = "WHERE s.customer_id=?" if user["role"] == "customer" else "WHERE 1=1"
    args = (user["id"],) if user["role"] == "customer" else ()
    q = params.get("q", [""])[0].strip()
    if q:
        where += " AND (s.number LIKE ? OR u.name LIKE ? OR p.name LIKE ?)"
        args += tuple(f"%{q}%" for _ in range(3))
    status = params.get("status", [""])[0]
    if status:
        where += " AND s.status=?"
        args += (status,)
    sql = f"""SELECT s.*,u.name AS customer_name,u.email AS customer_email,
              p.name AS plan_name,p.cycle,p.allow_pause,p.allow_early_close,p.allow_renew,
              d.code AS discount_code FROM subscriptions s
              JOIN users u ON u.id=s.customer_id JOIN plans p ON p.id=s.plan_id
              LEFT JOIN discounts d ON d.id=s.discount_id {where} ORDER BY s.id DESC"""
    result = paged(db, sql, args, params)
    if result["items"]:
        ids = [s["id"] for s in result["items"]]
        placeholders = ",".join("?" for _ in ids)
        items = many(db, f"SELECT * FROM subscription_items WHERE subscription_id IN ({placeholders})", ids)
        for sub in result["items"]:
            sub["lines"] = [item for item in items if item["subscription_id"] == sub["id"]]
    return result


def invoice_list(db, user, params):
    where = "WHERE i.customer_id=?" if user["role"] == "customer" else "WHERE 1=1"
    args = (user["id"],) if user["role"] == "customer" else ()
    status = params.get("status", [""])[0]
    if status:
        where += " AND i.status=?"
        args += (status,)
    sql = f"""SELECT i.*,u.name AS customer_name,s.number AS subscription_number,
              COALESCE((SELECT SUM(amount_cents) FROM payments WHERE invoice_id=i.id),0) AS paid_cents
              FROM invoices i JOIN users u ON u.id=i.customer_id
              JOIN subscriptions s ON s.id=i.subscription_id {where} ORDER BY i.id DESC"""
    result = paged(db, sql, args, params)
    if result["items"]:
        ids = [i["id"] for i in result["items"]]
        placeholders = ",".join("?" for _ in ids)
        lines = many(db, f"SELECT * FROM invoice_lines WHERE invoice_id IN ({placeholders})", ids)
        for invoice in result["items"]:
            invoice["lines"] = [line for line in lines if line["invoice_id"] == invoice["id"]]
            invoice["outstanding_cents"] = max(0, invoice["total_cents"] - invoice["paid_cents"])
            invoice["overdue"] = invoice["status"] not in ("Paid", "Cancelled") and invoice["due_date"] < date.today().isoformat()
    return result


def dashboard(db, user):
    if user["role"] == "customer":
        uid = user["id"]
        return {
            "active": one(db, "SELECT COUNT(*) n FROM subscriptions WHERE customer_id=? AND status='Active'", (uid,))["n"],
            "invoices": one(db, "SELECT COUNT(*) n FROM invoices WHERE customer_id=?", (uid,))["n"],
            "outstanding_cents": one(db, """SELECT COALESCE(SUM(i.total_cents-COALESCE(p.paid,0)),0) n FROM invoices i
                         LEFT JOIN (SELECT invoice_id,SUM(amount_cents) paid FROM payments GROUP BY invoice_id) p ON p.invoice_id=i.id
                         WHERE i.customer_id=? AND i.status NOT IN ('Paid','Cancelled')""", (uid,))["n"],
            "next_billing_date": one(db, """SELECT MIN(next_billing_date) n FROM subscriptions
                           WHERE customer_id=? AND status='Active'""", (uid,))["n"],
        }
    active = one(db, "SELECT COUNT(*) n FROM subscriptions WHERE status='Active'")["n"]
    revenue = one(db, "SELECT COALESCE(SUM(amount_cents),0) n FROM payments")["n"]
    outstanding = one(db, """SELECT COALESCE(SUM(i.total_cents-COALESCE(p.paid,0)),0) n FROM invoices i
                     LEFT JOIN (SELECT invoice_id,SUM(amount_cents) paid FROM payments GROUP BY invoice_id) p ON p.invoice_id=i.id
                     WHERE i.status NOT IN ('Paid','Cancelled')""")["n"]
    overdue = one(db, """SELECT COUNT(*) n FROM invoices WHERE status NOT IN ('Paid','Cancelled') AND due_date<?""",
                  (date.today().isoformat(),))["n"]
    due = one(db, "SELECT COUNT(*) n FROM subscriptions WHERE status='Active' AND next_billing_date<=?",
              (date.today().isoformat(),))["n"]
    plans = many(db, """SELECT s.id,p.cycle,SUM(si.quantity*si.unit_price_cents) AS amount_cents
                    FROM subscriptions s JOIN plans p ON p.id=s.plan_id
                    JOIN subscription_items si ON si.subscription_id=s.id
                    WHERE s.status='Active' GROUP BY s.id""")
    factors = {"daily": 30, "weekly": 52 / 12, "monthly": 1, "yearly": 1 / 12}
    mrr = round(sum(r["amount_cents"] * factors[r["cycle"]] for r in plans))
    return {"active": active, "revenue_cents": revenue, "outstanding_cents": outstanding,
            "overdue": overdue, "due_today": due, "mrr_cents": mrr,
            "customers": one(db, "SELECT COUNT(*) n FROM users WHERE role='customer'")["n"]}


def create_invoice(db, sub, period_start):
    items = many(db, """SELECT si.*,t.rate AS tax_rate FROM subscription_items si
                    LEFT JOIN taxes t ON t.id=si.tax_id WHERE subscription_id=?""", (sub["id"],))
    if not items:
        raise AppError(400, "Subscription has no product lines.")
    bases = [i["quantity"] * i["unit_price_cents"] for i in items]
    subtotal = sum(bases)
    discounts = [0] * len(items)
    rule = one(db, "SELECT * FROM discounts WHERE id=?", (sub["discount_id"],)) if sub["discount_id"] else None
    if rule and rule["active"] and (not rule["starts_on"] or rule["starts_on"] <= period_start) and (
        not rule["ends_on"] or rule["ends_on"] >= period_start) and (
        rule["usage_limit"] is None or rule["usage_count"] < rule["usage_limit"]):
        eligible = [j for j, i in enumerate(items) if rule["scope"] == "subscription" or i["product_id"] == rule["product_id"]]
        eligible_base = sum(bases[j] for j in eligible)
        eligible_qty = sum(items[j]["quantity"] for j in eligible)
        if eligible and eligible_base >= rule["min_purchase_cents"] and eligible_qty >= rule["min_quantity"]:
            amount = min(eligible_base, round(eligible_base * rule["value"] / 100) if rule["kind"] == "percent"
                         else round(rule["value"] * 100))
            allocated = 0
            for j in eligible[:-1]:
                discounts[j] = round(amount * bases[j] / eligible_base)
                allocated += discounts[j]
            discounts[eligible[-1]] = amount - allocated
            db.execute("UPDATE discounts SET usage_count=usage_count+1 WHERE id=?", (rule["id"],))
    tax_amounts = [round((bases[j] - discounts[j]) * (items[j]["tax_rate"] or 0) / 100) for j in range(len(items))]
    total_discount = sum(discounts)
    total_tax = sum(tax_amounts)
    total = subtotal - total_discount + total_tax
    due = (date.fromisoformat(period_start) + timedelta(days=sub["payment_terms_days"])).isoformat()
    number = f"INV-{db.execute('SELECT COALESCE(MAX(id),0)+1 FROM invoices').fetchone()[0]:05d}"
    invoice_id = db.execute("""INSERT INTO invoices(number,subscription_id,customer_id,period_start,invoice_date,due_date,
                    subtotal_cents,discount_cents,tax_cents,total_cents,status,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (number, sub["id"], sub["customer_id"], period_start, date.today().isoformat(), due,
                     subtotal, total_discount, total_tax, total, "Draft", now())).lastrowid
    for j, item in enumerate(items):
        db.execute("""INSERT INTO invoice_lines(invoice_id,description,product_id,quantity,unit_price_cents,
                    discount_cents,tax_rate,tax_cents,total_cents) VALUES(?,?,?,?,?,?,?,?,?)""",
                   (invoice_id, item["description"], item["product_id"], item["quantity"],
                    item["unit_price_cents"], discounts[j], item["tax_rate"] or 0, tax_amounts[j],
                    bases[j] - discounts[j] + tax_amounts[j]))
    return invoice_id


def run_billing(db, target):
    db.execute("BEGIN IMMEDIATE")
    try:
        subscriptions = many(db, """SELECT s.*,p.cycle,p.auto_close FROM subscriptions s JOIN plans p ON p.id=s.plan_id
                            WHERE s.status='Active' AND s.next_billing_date<=? ORDER BY s.next_billing_date,s.id""", (target,))
        created = 0
        already = 0
        for sub in subscriptions:
            cursor = date.fromisoformat(sub["next_billing_date"])
            anchor = date.fromisoformat(sub["start_date"])
            processed = 0
            while cursor.isoformat() <= target and (not sub["expiry_date"] or cursor.isoformat() <= sub["expiry_date"]):
                if not one(db, "SELECT id FROM invoices WHERE subscription_id=? AND period_start=?",
                           (sub["id"], cursor.isoformat())):
                    create_invoice(db, sub, cursor.isoformat())
                    created += 1
                else:
                    already += 1
                cursor = add_cycle(cursor, sub["cycle"], anchor)
                processed += 1
                if processed > 366:
                    raise AppError(400, "Billing backlog exceeds one year of daily periods. Run a shorter date range.")
            next_date = cursor.isoformat()
            status = "Closed" if sub["auto_close"] and sub["expiry_date"] and next_date > sub["expiry_date"] else "Active"
            db.execute("UPDATE subscriptions SET next_billing_date=?,status=?,updated_at=? WHERE id=?",
                       (next_date, status, now(), sub["id"]))
        db.execute("COMMIT")
        return {"created": created, "already_exists": already, "subscriptions_checked": len(subscriptions)}
    except Exception:
        db.execute("ROLLBACK")
        raise


class Handler(BaseHTTPRequestHandler):
    server_version = "BrightloopDemo/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, data, status=200):
        raw = json.dumps(data, separators=(",", ":"), default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        length = integer(self.headers.get("Content-Length", "0"), "Content-Length", 0, 100_000)
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            raise AppError(400, "Invalid JSON body.")
        if not isinstance(data, dict):
            raise AppError(400, "Expected a JSON object.")
        return data

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def dispatch(self, method):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return self.static(parsed.path)
        db = connect()
        try:
            result, status = self.api(db, method, parsed.path, parse_qs(parsed.query))
            self.send_json(result, status)
        except AppError as error:
            self.send_json({"error": error.message}, error.status)
        except sqlite3.IntegrityError as error:
            self.send_json({"error": "This record conflicts with an existing record or invalid reference."}, 409)
        except Exception as error:
            sys.stderr.write(f"API error: {error!r}\n")
            self.send_json({"error": "Unexpected server error."}, 500)
        finally:
            db.close()

    def static(self, path):
        files = {"/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js"}
        if path not in files:
            return self.send_error(404)
        file = ROOT / files[path]
        if not file.exists():
            return self.send_error(404)
        raw = file.read_bytes()
        mime = "text/html" if file.suffix == ".html" else "text/css" if file.suffix == ".css" else "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def api(self, db, method, path, params):
        data = self.body() if method in ("POST", "PATCH") else {}
        if path == "/api/auth/register" and method == "POST":
            name = required(data.get("name"), "Name", 100)
            email = required(data.get("email"), "Email", 150).lower()
            password = str(data.get("password") or "")
            validate_password(password)
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                raise AppError(400, "Enter a valid email address.")
            uid = db.execute("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                             (name, email, password_hash(password), "customer", now())).lastrowid
            return {"token": create_session(db, uid), "user": one(db, "SELECT id,name,email,role FROM users WHERE id=?", (uid,))}, 201
        if path == "/api/auth/login" and method == "POST":
            email = str(data.get("email") or "").strip().lower()
            user = one(db, "SELECT * FROM users WHERE email=?", (email,))
            if not user or not check_password(str(data.get("password") or ""), user["password_hash"]):
                raise AppError(401, "Incorrect email or password.")
            return {"token": create_session(db, user["id"]),
                    "user": {key: user[key] for key in ("id", "name", "email", "role")}}, 200
        if path == "/api/auth/forgot" and method == "POST":
            email = str(data.get("email") or "").strip().lower()
            user = one(db, "SELECT id FROM users WHERE email=?", (email,))
            response = {"message": "If this account exists, a reset link has been prepared."}
            if user:
                token = secrets.token_urlsafe(32)
                expiry = (datetime.now() + timedelta(minutes=30)).replace(microsecond=0).isoformat()
                db.execute("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)",
                           (token_hash(token), user["id"], expiry))
                # Local hackathon mode: show the link in the browser because no email service is configured.
                response["demo_reset_link"] = f"http://{HOST}:{PORT}/?reset={token}"
            return response, 200
        if path == "/api/auth/reset" and method == "POST":
            token = required(data.get("token"), "Reset token", 200)
            password = str(data.get("password") or "")
            validate_password(password)
            reset = one(db, "SELECT * FROM password_resets WHERE token_hash=? AND used=0 AND expires_at>?",
                        (token_hash(token), now()))
            if not reset:
                raise AppError(400, "Reset link is invalid or expired.")
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash(password), reset["user_id"]))
            db.execute("UPDATE password_resets SET used=1 WHERE token_hash=?", (token_hash(token),))
            db.execute("DELETE FROM sessions WHERE user_id=?", (reset["user_id"],))
            return {"message": "Password changed. Please sign in."}, 200

        user = current_user(db, self.headers)
        if path == "/api/me" and method == "GET":
            return {"user": user}, 200
        if path == "/api/auth/logout" and method == "POST":
            db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(self.headers["Authorization"][7:]),))
            return {"ok": True}, 200
        if path == "/api/dashboard" and method == "GET":
            return dashboard(db, user), 200
        if path == "/api/reports" and method == "GET":
            allow(user, "admin", "staff")
            start = iso(params.get("from", [date.today().replace(day=1).isoformat()])[0], "From date")
            end = iso(params.get("to", [date.today().isoformat()])[0], "To date")
            if end < start:
                raise AppError(400, "Report end date must follow its start date.")
            status_rows = many(db, """SELECT status,COUNT(*) AS n FROM invoices
                                WHERE invoice_date BETWEEN ? AND ? GROUP BY status""", (start, end))
            amounts = one(db, """SELECT COALESCE(SUM(CASE WHEN i.status!='Cancelled' THEN i.total_cents ELSE 0 END),0) invoiced,
                            COALESCE(SUM(CASE WHEN i.status NOT IN ('Paid','Cancelled')
                              THEN i.total_cents-COALESCE(p.paid,0) ELSE 0 END),0) outstanding,
                            COALESCE(SUM(CASE WHEN i.status NOT IN ('Paid','Cancelled') AND i.due_date<?
                              THEN 1 ELSE 0 END),0) overdue
                            FROM invoices i LEFT JOIN (SELECT invoice_id,SUM(amount_cents) paid FROM payments
                            GROUP BY invoice_id) p ON p.invoice_id=i.id
                            WHERE i.invoice_date BETWEEN ? AND ?""", (date.today().isoformat(), start, end))
            revenue = one(db, "SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE paid_on BETWEEN ? AND ?",
                          (start, end))["n"]
            return {"from": start, "to": end, "invoiced_cents": amounts["invoiced"],
                    "revenue_cents": revenue, "outstanding_cents": amounts["outstanding"],
                    "overdue": amounts["overdue"],
                    "status_counts": {row["status"]: row["n"] for row in status_rows}}, 200
        if path == "/api/products":
            if method == "GET":
                allow(user, "admin", "staff")
                products = product_list(db)
                if user["role"] == "staff":
                    for product in products:
                        product.pop("cost_price_cents", None)
                return {"items": products}, 200
            allow(user, "admin")
            name = required(data.get("name"), "Product name")
            kind = required(data.get("type"), "Product type", 50)
            tax_id = data.get("tax_id") or None
            pid = db.execute("""INSERT INTO products(name,type,sales_price_cents,cost_price_cents,notes,tax_id)
                         VALUES(?,?,?,?,?,?)""", (name, kind, cents(data.get("sales_price"), "Sales price"),
                         cents(data.get("cost_price", 0), "Cost price"), str(data.get("notes") or "")[:1000], tax_id)).lastrowid
            return {"id": pid}, 201
        if path == "/api/variants" and method == "POST":
            allow(user, "admin")
            pid = integer(data.get("product_id"), "Product", 1)
            if not one(db, "SELECT id FROM products WHERE id=?", (pid,)):
                raise AppError(404, "Product not found.")
            vid = db.execute("INSERT INTO variants(product_id,name,price_delta_cents) VALUES(?,?,?)",
                             (pid, required(data.get("name"), "Variant name"), cents(data.get("price_delta", 0), "Price addition"))).lastrowid
            return {"id": vid}, 201
        if path == "/api/taxes":
            if method == "GET":
                allow(user, "admin", "staff")
                return {"items": many(db, "SELECT * FROM taxes ORDER BY id DESC")}, 200
            allow(user, "admin")
            try:
                rate = float(data.get("rate", -1))
            except (TypeError, ValueError):
                raise AppError(400, "Tax rate must be a number.")
            if rate < 0 or rate > 100:
                raise AppError(400, "Tax rate must be between 0 and 100.")
            tid = db.execute("INSERT INTO taxes(name,rate) VALUES(?,?)", (required(data.get("name"), "Tax name"), rate)).lastrowid
            return {"id": tid}, 201
        if path == "/api/plans":
            if method == "GET":
                return {"items": many(db, """SELECT p.*,pr.name AS product_name FROM plans p
                                  JOIN products pr ON pr.id=p.product_id ORDER BY p.id DESC""")}, 200
            allow(user, "admin")
            cycle = str(data.get("cycle") or "")
            if cycle not in ("daily", "weekly", "monthly", "yearly"):
                raise AppError(400, "Choose a billing cycle.")
            product_id = integer(data.get("product_id"), "Product", 1)
            if not one(db, "SELECT id FROM products WHERE id=?", (product_id,)):
                raise AppError(404, "Product not found.")
            start = optional_iso(data.get("available_from"), "Available from")
            end = optional_iso(data.get("available_until"), "Available until")
            if start and end and end < start:
                raise AppError(400, "Plan end date must follow its start date.")
            pid = db.execute("""INSERT INTO plans(name,product_id,price_cents,cycle,min_quantity,available_from,
                  available_until,allow_pause,allow_early_close,allow_renew,auto_close)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (required(data.get("name"), "Plan name"), product_id,
                  cents(data.get("price"), "Plan price"), cycle, integer(data.get("min_quantity", 1), "Minimum quantity", 1),
                  start, end, int(bool(data.get("allow_pause"))), int(bool(data.get("allow_early_close"))),
                  int(bool(data.get("allow_renew", True))), int(bool(data.get("auto_close"))))).lastrowid
            return {"id": pid}, 201
        if path == "/api/discounts":
            if method == "GET":
                allow(user, "admin", "staff")
                return {"items": many(db, """SELECT d.*,p.name AS product_name FROM discounts d
                                  LEFT JOIN products p ON p.id=d.product_id ORDER BY d.id DESC""")}, 200
            allow(user, "admin")
            kind = str(data.get("kind") or "")
            scope = str(data.get("scope") or "")
            if kind not in ("fixed", "percent") or scope not in ("subscription", "product"):
                raise AppError(400, "Choose a discount type and scope.")
            try:
                value = float(data.get("value", -1))
            except (TypeError, ValueError):
                raise AppError(400, "Discount value must be a number.")
            if value <= 0 or kind == "percent" and value > 100:
                raise AppError(400, "Discount value is out of range.")
            product_id = integer(data.get("product_id"), "Product", 1) if scope == "product" else None
            starts = optional_iso(data.get("starts_on"), "Start date")
            ends = optional_iso(data.get("ends_on"), "End date")
            if starts and ends and ends < starts:
                raise AppError(400, "Discount end date must follow its start date.")
            limit = integer(data.get("usage_limit"), "Usage limit", 1) if data.get("usage_limit") else None
            did = db.execute("""INSERT INTO discounts(code,kind,value,min_purchase_cents,min_quantity,starts_on,
                    ends_on,usage_limit,scope,product_id) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (required(data.get("code"), "Discount code", 50).upper(), kind, value,
                     cents(data.get("min_purchase", 0), "Minimum purchase"),
                     integer(data.get("min_quantity", 1), "Minimum quantity", 1), starts, ends, limit, scope, product_id)).lastrowid
            return {"id": did}, 201
        if path == "/api/templates":
            if method == "GET":
                allow(user, "admin", "staff")
                return {"items": many(db, """SELECT t.*,p.name AS plan_name FROM templates t
                                  JOIN plans p ON p.id=t.plan_id ORDER BY t.id DESC""")}, 200
            allow(user, "admin", "staff")
            tid = db.execute("INSERT INTO templates(name,plan_id,quantity,valid_days,notes) VALUES(?,?,?,?,?)",
                             (required(data.get("name"), "Template name"), integer(data.get("plan_id"), "Plan", 1),
                              integer(data.get("quantity", 1), "Quantity", 1), integer(data.get("valid_days", 14), "Validity", 1, 365),
                              str(data.get("notes") or "")[:1000])).lastrowid
            return {"id": tid}, 201
        if path == "/api/customers" and method == "GET":
            allow(user, "admin", "staff")
            return paged(db, "SELECT id,name,email,created_at FROM users WHERE role='customer' ORDER BY id DESC", (), params), 200
        if path == "/api/staff":
            allow(user, "admin")
            if method == "GET":
                return {"items": many(db, "SELECT id,name,email,created_at FROM users WHERE role='staff' ORDER BY id DESC")}, 200
            name = required(data.get("name"), "Staff name", 100)
            email = required(data.get("email"), "Email", 150).lower()
            password = str(data.get("password") or "")
            validate_password(password)
            uid = db.execute("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                             (name, email, password_hash(password), "staff", now())).lastrowid
            return {"id": uid}, 201
        if path == "/api/subscriptions":
            if method == "GET":
                return subscription_list(db, user, params), 200
            allow(user, "admin", "staff")
            customer_id = integer(data.get("customer_id"), "Customer", 1)
            customer = one(db, "SELECT id FROM users WHERE id=? AND role='customer'", (customer_id,))
            if not customer:
                raise AppError(404, "Customer not found.")
            plan_id = integer(data.get("plan_id"), "Plan", 1)
            plan = one(db, "SELECT * FROM plans WHERE id=? AND active=1", (plan_id,))
            if not plan:
                raise AppError(404, "Plan not found.")
            quantity = integer(data.get("quantity", 1), "Quantity", plan["min_quantity"])
            start = iso(data.get("start_date"), "Start date")
            expiry = optional_iso(data.get("expiry_date"), "Expiry date")
            if expiry and expiry < start:
                raise AppError(400, "Expiry date must follow start date.")
            if plan["available_from"] and start < plan["available_from"] or plan["available_until"] and start > plan["available_until"]:
                raise AppError(400, "Plan is not available on that date.")
            variant_id = integer(data.get("variant_id"), "Variant", 1) if data.get("variant_id") else None
            variant = one(db, "SELECT * FROM variants WHERE id=? AND product_id=?", (variant_id, plan["product_id"])) if variant_id else None
            if variant_id and not variant:
                raise AppError(400, "Variant does not belong to this product.")
            discount_id = integer(data.get("discount_id"), "Discount", 1) if data.get("discount_id") else None
            if discount_id and not one(db, "SELECT id FROM discounts WHERE id=? AND active=1", (discount_id,)):
                raise AppError(404, "Discount not found.")
            quote_days = integer(data.get("valid_days", 14), "Quote validity", 1, 365)
            status = str(data.get("status") or "Quotation")
            if status not in ("Draft", "Quotation"):
                raise AppError(400, "New subscriptions start as Draft or Quotation.")
            addon_id = integer(data.get("addon_product_id"), "Add-on", 1) if data.get("addon_product_id") else None
            addon = one(db, "SELECT * FROM products WHERE id=? AND active=1", (addon_id,)) if addon_id else None
            if addon_id and (not addon or addon_id == plan["product_id"]):
                raise AppError(400, "Choose a valid add-on product.")
            addon_quantity = integer(data.get("addon_quantity", 1), "Add-on quantity", 1) if addon else None
            number = f"SUB-{db.execute('SELECT COALESCE(MAX(id),0)+1 FROM subscriptions').fetchone()[0]:04d}"
            sid = db.execute("""INSERT INTO subscriptions(number,customer_id,plan_id,start_date,expiry_date,
                       payment_terms_days,quote_valid_until,status,discount_id,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (number, customer_id, plan_id, start, expiry,
                       integer(data.get("payment_terms_days", 14), "Payment terms", 0, 365),
                       (date.today() + timedelta(days=quote_days)).isoformat(), status, discount_id, now(), now())).lastrowid
            product = one(db, "SELECT * FROM products WHERE id=?", (plan["product_id"],))
            desc = product["name"] + (f" · {variant['name']}" if variant else "")
            db.execute("""INSERT INTO subscription_items(subscription_id,product_id,variant_id,description,quantity,unit_price_cents,tax_id)
                     VALUES(?,?,?,?,?,?,?)""", (sid, product["id"], variant_id, desc, quantity,
                     plan["price_cents"] + (variant["price_delta_cents"] if variant else 0), product["tax_id"]))
            if addon:
                db.execute("""INSERT INTO subscription_items(subscription_id,product_id,description,quantity,unit_price_cents,tax_id)
                         VALUES(?,?,?,?,?,?)""", (sid, addon_id, addon["name"],
                         addon_quantity, addon["sales_price_cents"], addon["tax_id"]))
            return {"id": sid, "number": number}, 201
        sub_match = re.fullmatch(r"/api/subscriptions/(\d+)/status", path)
        if sub_match and method == "PATCH":
            sid = int(sub_match.group(1))
            sub = one(db, """SELECT s.*,p.allow_pause,p.allow_early_close,p.allow_renew FROM subscriptions s
                         JOIN plans p ON p.id=s.plan_id WHERE s.id=?""", (sid,))
            if not sub:
                raise AppError(404, "Subscription not found.")
            action = str(data.get("action") or "")
            if user["role"] == "customer":
                if sub["customer_id"] != user["id"] or action not in ("pause", "resume", "close", "renew"):
                    raise AppError(403, "You cannot change this subscription.")
            else:
                allow(user, "admin", "staff")
            transitions = {"quote": ("Draft", "Quotation"), "confirm": ("Quotation", "Confirmed"),
                           "activate": ("Confirmed", "Active"), "pause": ("Active", "Paused"),
                           "resume": ("Paused", "Active"), "close": (("Active", "Paused", "Confirmed"), "Closed"),
                           "renew": (("Closed", "Active"), "Active")}
            if action not in transitions:
                raise AppError(400, "Unknown subscription action.")
            source, target = transitions[action]
            if sub["status"] not in (source if isinstance(source, tuple) else (source,)):
                raise AppError(400, f"Cannot {action} a {sub['status'].lower()} subscription.")
            if action in ("pause", "resume") and not sub["allow_pause"]:
                raise AppError(400, "This plan cannot be paused.")
            if action == "close" and not sub["allow_early_close"] and sub["status"] != "Confirmed":
                raise AppError(400, "This plan cannot be closed early.")
            if action == "renew" and not sub["allow_renew"]:
                raise AppError(400, "This plan cannot be renewed.")
            if action == "renew" and sub["status"] == "Active" and (
                not sub["expiry_date"] or sub["expiry_date"] >= date.today().isoformat()):
                raise AppError(400, "This active subscription has not expired.")
            if action == "confirm" and sub["quote_valid_until"] and sub["quote_valid_until"] < date.today().isoformat():
                raise AppError(400, "This quotation has expired.")
            if action == "renew":
                db.execute("""UPDATE subscriptions SET status='Active',start_date=?,expiry_date=NULL,
                            next_billing_date=?,updated_at=? WHERE id=?""",
                           (date.today().isoformat(), date.today().isoformat(), now(), sid))
            else:
                next_billing = sub["start_date"] if action == "activate" else sub["next_billing_date"]
                if action == "resume" and next_billing:
                    plan = one(db, "SELECT cycle FROM plans WHERE id=?", (sub["plan_id"],))
                    cursor = date.fromisoformat(next_billing)
                    anchor = date.fromisoformat(sub["start_date"])
                    while cursor < date.today():
                        cursor = add_cycle(cursor, plan["cycle"], anchor)
                    next_billing = cursor.isoformat()
                db.execute("UPDATE subscriptions SET status=?,next_billing_date=?,updated_at=? WHERE id=?",
                           (target, next_billing, now(), sid))
            return {"status": target}, 200
        if path == "/api/billing/run" and method == "POST":
            allow(user, "admin", "staff")
            target = iso(data.get("through_date") or date.today().isoformat(), "Billing date")
            if target > (date.today() + timedelta(days=365)).isoformat():
                raise AppError(400, "Billing date cannot be more than one year ahead.")
            return run_billing(db, target), 200
        if path == "/api/invoices" and method == "GET":
            return invoice_list(db, user, params), 200
        invoice_match = re.fullmatch(r"/api/invoices/(\d+)/action", path)
        if invoice_match and method == "PATCH":
            allow(user, "admin", "staff")
            invoice_id = int(invoice_match.group(1))
            invoice = one(db, "SELECT * FROM invoices WHERE id=?", (invoice_id,))
            if not invoice:
                raise AppError(404, "Invoice not found.")
            action = str(data.get("action") or "")
            if action == "confirm" and invoice["status"] == "Draft":
                db.execute("UPDATE invoices SET status='Confirmed' WHERE id=?", (invoice_id,))
            elif action == "send" and invoice["status"] in ("Draft", "Confirmed"):
                db.execute("UPDATE invoices SET status='Confirmed',sent_at=? WHERE id=?", (now(), invoice_id))
            elif action == "cancel" and invoice["status"] in ("Draft", "Confirmed"):
                if one(db, "SELECT id FROM payments WHERE invoice_id=? LIMIT 1", (invoice_id,)):
                    raise AppError(400, "A partially paid invoice cannot be cancelled.")
                db.execute("UPDATE invoices SET status='Cancelled' WHERE id=?", (invoice_id,))
            else:
                raise AppError(400, "This invoice action is not allowed in its current state.")
            return {"ok": True}, 200
        if path == "/api/payments":
            if method == "GET":
                where = "WHERE i.customer_id=?" if user["role"] == "customer" else ""
                args = (user["id"],) if user["role"] == "customer" else ()
                sql = f"""SELECT p.*,i.number AS invoice_number,u.name AS customer_name FROM payments p
                          JOIN invoices i ON i.id=p.invoice_id JOIN users u ON u.id=i.customer_id {where} ORDER BY p.id DESC"""
                return paged(db, sql, args, params), 200
            allow(user, "admin", "staff")
            invoice_id = integer(data.get("invoice_id"), "Invoice", 1)
            invoice = one(db, """SELECT i.*,COALESCE((SELECT SUM(amount_cents) FROM payments WHERE invoice_id=i.id),0) paid
                        FROM invoices i WHERE i.id=?""", (invoice_id,))
            if not invoice:
                raise AppError(404, "Invoice not found.")
            if invoice["status"] not in ("Confirmed", "Paid"):
                raise AppError(400, "Confirm the invoice before recording payment.")
            amount = cents(data.get("amount"), "Payment amount", 1)
            if amount > invoice["total_cents"] - invoice["paid"]:
                raise AppError(400, "Payment exceeds the outstanding amount.")
            pid = db.execute("INSERT INTO payments(invoice_id,amount_cents,method,paid_on,note,created_at) VALUES(?,?,?,?,?,?)",
                             (invoice_id, amount, required(data.get("method"), "Payment method", 50),
                              iso(data.get("paid_on"), "Payment date"), str(data.get("note") or "")[:500], now())).lastrowid
            if invoice["paid"] + amount == invoice["total_cents"]:
                db.execute("UPDATE invoices SET status='Paid' WHERE id=?", (invoice_id,))
            return {"id": pid}, 201
        raise AppError(404, "API route not found.")


if __name__ == "__main__":
    init_db()
    print(f"Brightloop is running at http://{HOST}:{PORT}")
    print("Demo users: admin@brightloop.test / Admin@123! | staff@brightloop.test / Staff@123! | asha@demo.test / Customer@123!")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
