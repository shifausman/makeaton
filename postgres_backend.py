"""Small PostgreSQL adapter for Brightloop's existing parameterized SQL."""

import re

try:
    import psycopg
    from psycopg.rows import dict_row
    PostgresIntegrityError = psycopg.IntegrityError
except ImportError:
    psycopg = None
    PostgresIntegrityError = type("PostgresIntegrityError", (Exception,), {})


ID_TABLES = {
    "users", "taxes", "products", "variants", "plans", "discounts", "templates",
    "subscriptions", "subscription_items", "invoices", "invoice_lines", "payments",
}
INSERT_TABLE = re.compile(r"^\s*INSERT\s+INTO\s+([a-z_]+)\b", re.IGNORECASE)


class PostgresResult:
    def __init__(self, cursor, lastrowid=None):
        self.cursor = cursor
        self.lastrowid = lastrowid

    def fetchone(self):
        return self.cursor.fetchone()

    def fetchall(self):
        return self.cursor.fetchall()

    def __iter__(self):
        return iter(self.cursor)


class PostgresConnection:
    def __init__(self, url):
        if psycopg is None:
            raise RuntimeError("PostgreSQL needs psycopg. Install it with: pip install -r requirements.txt")
        self.raw = psycopg.connect(url, autocommit=True, row_factory=dict_row,
                                   connect_timeout=8, sslmode="require", prepare_threshold=None)

    def execute(self, sql, args=()):
        query = sql.replace("?", "%s")
        if query.strip().upper() == "BEGIN IMMEDIATE":
            query = "BEGIN"
        insert = INSERT_TABLE.match(query)
        wants_id = bool(insert and insert.group(1).lower() in ID_TABLES and "RETURNING" not in query.upper())
        if wants_id:
            query += " RETURNING id"
        cursor = self.raw.execute(query, args if args else None)
        return PostgresResult(cursor, cursor.fetchone()["id"] if wants_id else None)

    def executescript(self, script):
        for statement in script.split(";"):
            if statement.strip():
                self.execute(statement)

    def close(self):
        self.raw.close()


def connect(url):
    return PostgresConnection(url)
