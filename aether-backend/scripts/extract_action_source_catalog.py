#!/usr/bin/env python3
"""
@.architecture
Incoming: running Aether backend OpenAPI spec --- {HTTP GET, json}
Processing: extract endpoints, group by domain, emit action_source catalog --- {3 jobs: JOB_EXTERNAL_CALL, JOB_TRANSFORM_DATA, JOB_RENDER_MARKDOWN}
Outgoing: CLI stdout --- {str, structured catalog}

Action_Source Catalog Extractor

Purpose:
  - Extract ALL OpenAPI endpoints
  - Group by domain (first path segment after /v1)
  - Emit structured action_source candidates + full param/default listing

This is a READ-ONLY inspection tool. It does NOT modify code.
"""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Optional


def _http_get_json(url: str) -> Dict[str, Any]:
    try:
        import requests  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise SystemExit(f"Missing dependency: requests ({exc}). Install with: pip install requests")

    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.json()


def _schema_summary(schema: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(schema, dict):
        return {}
    if "$ref" in schema:
        return {"$ref": schema["$ref"]}
    out: Dict[str, Any] = {}
    if "type" in schema:
        out["type"] = schema.get("type")
    if "default" in schema:
        out["default"] = schema.get("default")
    if "enum" in schema:
        out["enum"] = schema.get("enum")
    if "items" in schema and isinstance(schema.get("items"), dict):
        out["items"] = _schema_summary(schema["items"])
    return out


def _resolve_schema_fields(spec: Dict[str, Any], schema: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    if not isinstance(schema, dict):
        return None
    ref = schema.get("$ref")
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    parts = ref[2:].split("/")
    if len(parts) < 3 or parts[0] != "components" or parts[1] != "schemas":
        return None
    schema_name = parts[2]
    schema_def = (((spec or {}).get("components") or {}).get("schemas") or {}).get(schema_name) or {}
    if not isinstance(schema_def, dict):
        return None
    required = set(schema_def.get("required") or [])
    props = schema_def.get("properties") or {}
    if not isinstance(props, dict):
        return None
    fields: List[Dict[str, Any]] = []
    for fname, fdef in props.items():
        if not isinstance(fdef, dict):
            continue
        fields.append(
            {
                "name": fname,
                "required": fname in required,
                "description": fdef.get("description") or "",
                "schema": _schema_summary(fdef),
            }
        )
    fields.sort(key=lambda x: (not x["required"], x["name"]))
    return fields


def _derive_action_source(method: str, path: str) -> str:
    """
    Heuristic action_source candidate derived from HTTP endpoint.
    This does NOT change the actual API — used for audit only.
    """
    m = (method or "").upper()
    p = (path or "").strip()
    segs = [s for s in p.split("/") if s]
    if segs and segs[0] == "v1":
        segs = segs[1:]
    clean = [s for s in segs if not s.startswith("{")]
    if not clean:
        return ""

    def _singular(x: str) -> str:
        return x[:-1] if x.endswith("s") and x not in {"status"} else x

    def _source_from(segments: List[str]) -> str:
        return "_".join([_singular(s.replace("-", "_")) for s in segments if s]) or ""

    action_verbs = {
        "search",
        "list",
        "get",
        "create",
        "update",
        "delete",
        "execute",
        "start",
        "stop",
        "status",
        "health",
        "info",
        "models",
        "restart",
        "pause",
        "resume",
        "cancel",
        "retry",
        "connect",
        "disconnect",
        "export",
        "summarize",
        "test",
        "stream",
        "send",
    }

    first = clean[0].replace("-", "_")
    last = clean[-1].replace("-", "_")

    if first in action_verbs and len(clean) > 1:
        return f"{first}_{_source_from(clean[1:])}"
    if last in action_verbs and len(clean) > 1:
        return f"{last}_{_source_from(clean[:-1])}"
    for idx, segment in enumerate(clean):
        if segment.replace("-", "_") in action_verbs:
            source_segments = clean[:idx] + clean[idx + 1 :]
            return f"{segment.replace('-', '_')}_{_source_from(source_segments or ['system'])}"
    if first in action_verbs and len(clean) == 1:
        return f"{first}_system"

    if m == "GET":
        action = "get" if any(s.startswith("{") for s in segs) else "list"
    elif m in {"PUT", "PATCH"}:
        action = "update"
    elif m == "DELETE":
        action = "delete"
    elif m == "POST":
        action = "create"
    else:
        action = "call"

    return f"{action}_{_source_from(clean)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8765")
    args = ap.parse_args()

    base = str(args.base_url).rstrip("/")
    spec = _http_get_json(f"{base}/v1/docs/openapi")

    groups: Dict[str, List[Dict[str, Any]]] = {}
    for path, methods in (spec.get("paths") or {}).items():
        if not isinstance(path, str) or not isinstance(methods, dict):
            continue
        for method, op in methods.items():
            m = str(method).upper()
            if m not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                continue
            if not isinstance(op, dict):
                continue

            segs = [s for s in path.split("/") if s]
            domain = segs[1] if len(segs) > 1 and segs[0] == "v1" else "root"

            params: List[Dict[str, Any]] = []
            for p in op.get("parameters") or []:
                if not isinstance(p, dict):
                    continue
                params.append(
                    {
                        "name": p.get("name"),
                        "in": p.get("in"),
                        "required": bool(p.get("required")),
                        "description": p.get("description") or "",
                        "schema": _schema_summary(p.get("schema") or {}),
                    }
                )

            rb = op.get("requestBody") or {}
            content = rb.get("content") or {}
            app_json = content.get("application/json") or {}
            if isinstance(app_json, dict) and isinstance(app_json.get("schema"), dict):
                schema = app_json["schema"]
                params.append(
                    {
                        "name": "body",
                        "in": "body",
                        "required": bool(rb.get("required")),
                        "description": rb.get("description") or "",
                        "schema": _schema_summary(schema),
                        "fields": _resolve_schema_fields(spec, schema),
                    }
                )

            groups.setdefault(domain, []).append(
                {
                    "method": m,
                    "path": path,
                    "summary": op.get("summary") or "",
                    "description": op.get("description") or "",
                    "action_source_candidate": _derive_action_source(m, path),
                    "params": params,
                }
            )

    for dom in groups:
        groups[dom].sort(key=lambda r: (r["path"], r["method"]))

    out = {
        "base_url": base,
        "counts": {"domains": len(groups), "endpoints": sum(len(v) for v in groups.values())},
        "groups": groups,
    }

    print(json.dumps(out, indent=2, sort_keys=False))


if __name__ == "__main__":
    main()

