"""End-to-end API check against an isolated, temporary Brightloop database."""

import json
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app


class WorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(cls.tmp.name) / "test.db"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.server.daemon_threads = False
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.tmp.cleanup()

    def setUp(self):
        app.DB_PATH = Path(self.tmp.name) / f"{self._testMethodName}.db"
        app.init_db()

    def request(self, path, method="GET", body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Cookie"] = f"brightloop_token={token}"
        raw = json.dumps(body).encode() if body is not None else None
        request = Request(self.base + path, data=raw, headers=headers, method=method)
        try:
            with urlopen(request, timeout=5) as response:
                payload = json.load(response)
                session_cookie = response.headers.get("Set-Cookie")
                if session_cookie:
                    self.assertIn("HttpOnly", session_cookie)
                    payload["_session_cookie"] = session_cookie.split(";", 1)[0].split("=", 1)[1]
                return response.status, payload
        except HTTPError as error:
            return error.code, json.load(error)

    def login(self, email, password):
        status, result = self.request("/api/auth/login", "POST", {"email": email, "password": password})
        self.assertEqual(status, 200, result)
        return result["_session_cookie"]

    def test_renewal_calendar_alerts_and_customer_scope(self):
        admin = self.login("admin@brightloop.test", "Admin@123!")
        staff = self.login("staff@brightloop.test", "Staff@123!")
        customer = self.login("asha@demo.test", "Customer@123!")
        today = app.date.today().isoformat()
        month = today[:7]
        self.assertEqual(self.request("/api/renewals?month=wrong", token=admin)[0], 400)

        with closing(app.connect()) as db:
            discount_uses_before = db.execute("SELECT SUM(usage_count) FROM discounts").fetchone()[0]
        status, initial = self.request(f"/api/renewals?month={month}", token=admin)
        self.assertEqual(status, 200, initial)
        self.assertEqual(initial["summary"]["due_soon"], 1)
        self.assertEqual(initial["summary"]["overdue"], 0)
        scheduled = initial["alerts"]["upcoming"][0]
        self.assertEqual(scheduled["renewal_date"], today)
        self.assertEqual(scheduled["phase"], "due_today")
        self.assertEqual(scheduled["amount_due_cents"], scheduled["subtotal_cents"] - scheduled["discount_cents"] + scheduled["tax_cents"])
        self.assertEqual(len(initial["calendar"]), 1)
        self.assertEqual(self.request(f"/api/renewals?month={month}", token=staff)[1]["summary"], initial["summary"])
        own = self.request(f"/api/renewals?month={month}", token=customer)[1]
        self.assertEqual([event["subscription_id"] for event in own["calendar"]], [scheduled["subscription_id"]])
        with closing(app.connect()) as db:
            self.assertEqual(db.execute("SELECT SUM(usage_count) FROM discounts").fetchone()[0], discount_uses_before)

        status, other = self.request("/api/auth/register", "POST", {
            "name": "Second Customer", "email": "second@demo.test", "password": "Customer@123!"})
        self.assertEqual(status, 201, other)
        other_calendar = self.request(f"/api/renewals?month={month}", token=other["_session_cookie"])[1]
        self.assertEqual(other_calendar["summary"]["due_soon"], 0)
        self.assertEqual(other_calendar["calendar"], [])

        yesterday = (app.date.today() - app.timedelta(days=1)).isoformat()
        with closing(app.connect()) as db:
            db.execute("UPDATE subscriptions SET next_billing_date=? WHERE id=?", (yesterday, scheduled["subscription_id"]))
        overdue = self.request(f"/api/renewals?month={month}", token=admin)[1]
        self.assertEqual(overdue["summary"]["overdue"], 1)
        self.assertEqual(overdue["summary"]["due_soon"], 0)
        self.assertEqual(overdue["alerts"]["overdue"][0]["phase"], "overdue")
        self.assertEqual(overdue["alerts"]["upcoming"], [])

        with closing(app.connect()) as db:
            db.execute("UPDATE subscriptions SET next_billing_date=? WHERE id=?", (today, scheduled["subscription_id"]))
        self.assertEqual(self.request("/api/billing/run", "POST", {"through_date": today}, staff)[1]["created"], 1)
        billed = self.request(f"/api/renewals?month={month}", token=admin)[1]
        self.assertEqual(billed["summary"]["due_soon"], 0)
        self.assertEqual(billed["summary"]["billed_month"], 1)
        self.assertEqual(billed["alerts"]["upcoming"], [])
        invoice = self.request("/api/invoices", token=admin)[1]["items"][0]
        self.assertEqual(billed["alerts"]["billed"][0]["amount_due_cents"], invoice["total_cents"])
        next_date = self.request("/api/subscriptions", token=admin)[1]["items"][0]["next_billing_date"]
        next_month = self.request(f"/api/renewals?month={next_date[:7]}", token=admin)[1]
        self.assertEqual(next_month["summary"]["scheduled_month"], 1)
        self.assertEqual(next_month["calendar"][0]["renewal_date"], next_date)
        self.assertEqual(self.request(f"/api/renewals?month={month}", token=customer)[1]["summary"]["billed_month"], 1)
        self.assertEqual(self.request(f"/api/renewals?month={month}", token=other["_session_cookie"])[1]["summary"]["billed_month"], 0)

    def test_three_role_billing_flow(self):
        admin = self.login("admin@brightloop.test", "Admin@123!")
        staff = self.login("staff@brightloop.test", "Staff@123!")
        customer = self.login("asha@demo.test", "Customer@123!")
        self.assertEqual(self.request("/api/staff", token=staff)[0], 403)
        self.assertEqual(self.request("/api/customers", token=customer)[0], 403)
        self.assertEqual(self.request("/api/products", token=customer)[0], 403)
        self.assertEqual(self.request("/api/discounts", "POST", {"code": "BAD"}, staff)[0], 403)
        staff_products = self.request("/api/products", token=staff)[1]["items"]
        self.assertNotIn("cost_price_cents", staff_products[0])
        admin_products = self.request("/api/products", token=admin)[1]["items"]
        self.assertIn("cost_price_cents", admin_products[0])

        plan = self.request("/api/plans", token=staff)[1]["items"][-1]
        product = next(p for p in admin_products if p["id"] == plan["product_id"])
        variant = product["variants"][0]
        addon = next(p for p in admin_products if p["type"] == "Add-on")
        discount = self.request("/api/discounts", token=staff)[1]["items"][0]
        customer_id = self.request("/api/customers", token=staff)[1]["items"][0]["id"]
        start = app.date.today().isoformat()
        status, quote = self.request("/api/subscriptions", "POST", {
            "customer_id": customer_id, "plan_id": plan["id"], "quantity": 1,
            "variant_id": variant["id"], "addon_product_id": addon["id"], "addon_quantity": 1,
            "discount_id": discount["id"], "start_date": start, "payment_terms_days": 14
        }, staff)
        self.assertEqual(status, 201, quote)
        sub_id = quote["id"]
        self.assertEqual(self.request(f"/api/subscriptions/{sub_id}/status", "PATCH", {"action": "confirm"}, staff)[0], 200)
        self.assertEqual(self.request(f"/api/subscriptions/{sub_id}/status", "PATCH", {"action": "activate"}, staff)[0], 200)
        status, run = self.request("/api/billing/run", "POST", {"through_date": start}, staff)
        self.assertEqual(status, 200, run)
        self.assertEqual(run["created"], 2)  # Seeded subscription and the new one.
        self.assertEqual(self.request("/api/billing/run", "POST", {"through_date": start}, staff)[1]["created"], 0)
        report = self.request(f"/api/reports?from={start}&to={start}", token=staff)[1]
        self.assertEqual(report["status_counts"]["Draft"], 2)
        self.assertEqual(report["invoiced_cents"], 351522)
        invoices = self.request("/api/invoices", token=staff)[1]["items"]
        invoice = next(i for i in invoices if i["subscription_id"] == sub_id)
        self.assertEqual(invoice["subtotal_cents"], 211000)
        self.assertEqual(invoice["discount_cents"], 21100)
        self.assertEqual(invoice["tax_cents"], 34182)
        self.assertEqual(invoice["total_cents"], 224082)
        self.assertEqual(self.request(f"/api/invoices/{invoice['id']}/action", "PATCH", {"action": "confirm"}, staff)[0], 200)
        for amount in (1000, 1240.82):
            status, result = self.request("/api/payments", "POST", {
                "invoice_id": invoice["id"], "amount": amount, "method": "Bank transfer", "paid_on": start
            }, staff)
            self.assertEqual(status, 201, result)
        paid = next(i for i in self.request("/api/invoices", token=customer)[1]["items"] if i["id"] == invoice["id"])
        self.assertEqual(paid["status"], "Paid")
        self.assertEqual(paid["outstanding_cents"], 0)

        status, other = self.request("/api/auth/register", "POST", {
            "name": "Second Customer", "email": "second@demo.test", "password": "Customer@123!"})
        self.assertEqual(status, 201, other)
        self.assertEqual(self.request("/api/invoices", token=other["_session_cookie"])[1]["total"], 0)
        self.assertEqual(self.request(f"/api/subscriptions/{sub_id}/status", "PATCH", {"action": "pause"}, other["_session_cookie"])[0], 403)


if __name__ == "__main__":
    unittest.main()
