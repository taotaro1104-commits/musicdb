from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sqlite3
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "musicdb.sqlite"
STATIC_FILES = {
    "/": ROOT / "index.html",
    "/index.html": ROOT / "index.html",
    "/styles.css": ROOT / "styles.css",
    "/app.js": ROOT / "app.js",
}

LIST_COLUMNS = (
    "id",
    "title",
    "material_type",
    "official_url",
    "download_url",
    "preview_url",
    "creator_name",
    "site_name",
    "genre",
    "mood",
    "use_case",
    "duration_sec",
    "license_type",
    "commercial_use",
    "youtube_use",
    "credit_required",
    "short_description",
    "tags",
    "last_checked_at",
    "updated_at",
)

SORTS = {
    "title": "c.title COLLATE NOCASE ASC",
    "updated": "COALESCE(c.updated_at, c.created_at, '') DESC, c.title COLLATE NOCASE ASC",
    "duration": "c.duration_sec IS NULL ASC, c.duration_sec ASC, c.title COLLATE NOCASE ASC",
}

FILTERS = {
    "type": ("c.material_type = ?", "material_type"),
    "genre": ("c.genre = ?", "genre"),
    "license": ("c.license_type = ?", "license_type"),
    "site": ("c.site_name = ?", "site_name"),
}


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA query_only = ON")
    return con


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict]:
    return [dict(row) for row in rows]


def bool_param(params: dict[str, list[str]], key: str) -> bool:
    value = params.get(key, [""])[0].lower()
    return value in {"1", "true", "yes", "on"}


def int_param(params: dict[str, list[str]], key: str, default: int, low: int, high: int) -> int:
    try:
        value = int(params.get(key, [str(default)])[0])
    except ValueError:
        value = default
    return max(low, min(high, value))


def make_fts_query(raw: str) -> str:
    cleaned = re.sub(r'["\'^*:(){}[\]<>~+-]+', " ", raw).strip()
    terms = [term for term in re.split(r"\s+", cleaned) if term]
    return " OR ".join(f'"{term}"' for term in terms)


def like_pattern(raw: str) -> str:
    escaped = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def build_material_query(params: dict[str, list[str]], use_fts: bool = True) -> tuple[str, list, str, list]:
    q = params.get("q", [""])[0].strip()
    joins: list[str] = []
    where: list[str] = []
    args: list = []

    if q:
        if use_fts:
            fts = make_fts_query(q)
            if fts:
                joins.append(
                    "JOIN (SELECT material_id FROM material_search WHERE material_search MATCH ?) s "
                    "ON s.material_id = c.id"
                )
                args.append(fts)
        else:
            pattern = like_pattern(q)
            where.append(
                "("
                "c.title LIKE ? ESCAPE '\\' OR "
                "c.short_description LIKE ? ESCAPE '\\' OR "
                "c.description LIKE ? ESCAPE '\\' OR "
                "c.genre LIKE ? ESCAPE '\\' OR "
                "c.tags LIKE ? ESCAPE '\\'"
                ")"
            )
            args.extend([pattern] * 5)

    for request_key, (sql, _column) in FILTERS.items():
        value = params.get(request_key, [""])[0].strip()
        if value:
            where.append(sql)
            args.append(value)

    if bool_param(params, "commercial"):
        where.append("c.commercial_use = 1")
    if bool_param(params, "youtube"):
        where.append("c.youtube_use = 1")
    if bool_param(params, "credit_free"):
        where.append("COALESCE(c.credit_required, 0) = 0")

    base = "FROM material_catalog c " + " ".join(joins)
    where_sql = f" WHERE {' AND '.join(where)}" if where else ""
    return base, args, where_sql, args.copy()


def get_materials(params: dict[str, list[str]]) -> dict:
    page = int_param(params, "page", 1, 1, 100000)
    page_size = int_param(params, "page_size", 24, 12, 100)
    sort = SORTS.get(params.get("sort", ["title"])[0], SORTS["title"])
    offset = (page - 1) * page_size
    columns = ", ".join(f"c.{column}" for column in LIST_COLUMNS)

    with connect() as con:
        try:
            base, args, where_sql, count_args = build_material_query(params, use_fts=True)
            total = con.execute(f"SELECT COUNT(*) {base}{where_sql}", count_args).fetchone()[0]
            rows = con.execute(
                f"SELECT {columns} {base}{where_sql} ORDER BY {sort} LIMIT ? OFFSET ?",
                args + [page_size, offset],
            ).fetchall()
        except sqlite3.OperationalError:
            base, args, where_sql, count_args = build_material_query(params, use_fts=False)
            total = con.execute(f"SELECT COUNT(*) {base}{where_sql}", count_args).fetchone()[0]
            rows = con.execute(
                f"SELECT {columns} {base}{where_sql} ORDER BY {sort} LIMIT ? OFFSET ?",
                args + [page_size, offset],
            ).fetchall()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": rows_to_dicts(rows),
    }


def facet_rows(con: sqlite3.Connection, column: str) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT {column} AS value, COUNT(*) AS count
        FROM material_catalog
        WHERE {column} IS NOT NULL AND TRIM({column}) != ''
        GROUP BY {column}
        ORDER BY count DESC, value COLLATE NOCASE ASC
        """
    ).fetchall()
    return rows_to_dicts(rows)


def get_facets() -> dict:
    with connect() as con:
        total = con.execute("SELECT COUNT(*) FROM material_catalog").fetchone()[0]
        return {
            "total": total,
            "types": facet_rows(con, "material_type"),
            "genres": facet_rows(con, "genre"),
            "licenses": facet_rows(con, "license_type"),
            "sites": facet_rows(con, "site_name"),
        }


def get_material(material_id: str) -> dict | None:
    with connect() as con:
        row = con.execute("SELECT * FROM material_catalog WHERE id = ?", (material_id,)).fetchone()
    return dict(row) if row else None


class Handler(BaseHTTPRequestHandler):
    server_version = "MusicDB/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/materials":
                self.send_json(get_materials(parse_qs(parsed.query)))
                return
            if parsed.path == "/api/facets":
                self.send_json(get_facets())
                return
            if parsed.path.startswith("/api/materials/"):
                material_id = unquote(parsed.path.rsplit("/", 1)[-1])
                material = get_material(material_id)
                if material is None:
                    self.send_json({"error": "not found"}, status=404)
                else:
                    self.send_json(material)
                return
            if parsed.path in STATIC_FILES:
                self.send_static(STATIC_FILES[parsed.path])
                return
            self.send_json({"error": "not found"}, status=404)
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, path: Path) -> None:
        if not path.exists():
            self.send_json({"error": "not found"}, status=404)
            return
        body = path.read_bytes()
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime_type}; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the free BGM and sound effect database site.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if not DB_PATH.exists():
        raise SystemExit(f"Database not found: {DB_PATH}")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving on http://{args.host}:{args.port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
