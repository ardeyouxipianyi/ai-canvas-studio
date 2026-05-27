from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.config import DATA_DIR


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _number(value: object, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if number == number and number not in {float("inf"), float("-inf")} else fallback


def _progress(value: object, fallback: int = 0) -> int:
    return max(0, min(100, int(_number(value, fallback))))


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _new_id() -> str:
    return uuid.uuid4().hex


def _normalize_node(raw: object) -> dict[str, object] | None:
    if not isinstance(raw, dict):
        return None
    now = _now_iso()
    node_type = _clean(raw.get("type"))
    if node_type not in {"prompt", "edit", "image"}:
        node_type = "prompt"
    status = _clean(raw.get("status"))
    if status not in {"idle", "queued", "generating", "success", "error", "cancelled"}:
        status = "success" if raw.get("b64_json") or raw.get("url") else ("queued" if node_type == "image" else "idle")

    node: dict[str, object] = {
        "id": _clean(raw.get("id")) or _new_id(),
        "type": node_type,
        "x": _number(raw.get("x"), 0),
        "y": _number(raw.get("y"), 0),
        "width": _number(raw.get("width"), 300 if node_type == "image" else 320),
        "height": _number(raw.get("height"), 286 if node_type == "image" else 220),
        "title": _clean(raw.get("title")) or ("图片结果" if node_type == "image" else "编辑节点" if node_type == "edit" else "提示词节点"),
        "model": _clean(raw.get("model"), "gpt-image-2"),
        "size": _clean(raw.get("size")),
        "count": max(1, int(_number(raw.get("count"), 1))),
        "status": status,
        "progress": _progress(raw.get("progress"), 100 if status in {"success", "error", "cancelled"} else 0),
        "favorite": bool(raw.get("favorite")),
        "createdAt": _clean(raw.get("createdAt"), now),
        "updatedAt": _clean(raw.get("updatedAt"), _clean(raw.get("createdAt"), now)),
    }
    for key in ("prompt", "sourceNodeId", "taskId", "b64_json", "url", "revised_prompt", "error", "progressMessage"):
        value = raw.get(key)
        if isinstance(value, str):
            node[key] = value
    return node


def _normalize_project(raw: object, owner_id: str) -> dict[str, object]:
    project = raw if isinstance(raw, dict) else {}
    now = _now_iso()
    nodes = [node for item in project.get("nodes", []) if (node := _normalize_node(item)) is not None] if isinstance(project.get("nodes"), list) else []
    node_ids = {str(node.get("id")) for node in nodes}
    edges: list[dict[str, object]] = []
    if isinstance(project.get("edges"), list):
        for item in project.get("edges") or []:
            if not isinstance(item, dict):
                continue
            source = _clean(item.get("from"))
            target = _clean(item.get("to"))
            if not source or not target or source not in node_ids or target not in node_ids:
                continue
            edges.append({"id": _clean(item.get("id")) or _new_id(), "from": source, "to": target})

    viewport = project.get("viewport") if isinstance(project.get("viewport"), dict) else {}
    return {
        "owner_id": owner_id,
        "id": _clean(project.get("id")) or _new_id(),
        "title": _clean(project.get("title")) or "未命名画布",
        "createdAt": _clean(project.get("createdAt"), now),
        "updatedAt": _clean(project.get("updatedAt"), _clean(project.get("createdAt"), now)),
        "viewport": {
            "x": _number(viewport.get("x"), 80) if isinstance(viewport, dict) else 80,
            "y": _number(viewport.get("y"), 64) if isinstance(viewport, dict) else 64,
            "zoom": min(1.8, max(0.35, _number(viewport.get("zoom"), 1) if isinstance(viewport, dict) else 1)),
        },
        "nodes": nodes,
        "edges": edges,
    }


def _public_project(project: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in project.items() if key != "owner_id"}


class ImageCanvasService:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._projects = self._load()

    def _load(self) -> dict[str, dict[str, object]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        raw_items = raw.get("projects") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        projects: dict[str, dict[str, object]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            owner = _clean(item.get("owner_id"))
            if not owner:
                continue
            project = _normalize_project(item, owner)
            projects[f"{owner}:{project['id']}"] = project
        return projects

    def _save_locked(self) -> None:
        items = sorted(self._projects.values(), key=lambda item: str(item.get("updatedAt") or ""), reverse=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"projects": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.path)

    def list_projects(self, identity: dict[str, object]) -> list[dict[str, object]]:
        owner = _owner_id(identity)
        with self._lock:
            items = [_public_project(project) for project in self._projects.values() if project.get("owner_id") == owner]
        return sorted(items, key=lambda item: str(item.get("updatedAt") or ""), reverse=True)

    def save_project(self, identity: dict[str, object], project: dict[str, object]) -> dict[str, object]:
        owner = _owner_id(identity)
        normalized = _normalize_project(project, owner)
        normalized["updatedAt"] = _now_iso()
        with self._lock:
            self._projects[f"{owner}:{normalized['id']}"] = normalized
            self._save_locked()
        return _public_project(normalized)

    def delete_project(self, identity: dict[str, object], project_id: str) -> bool:
        owner = _owner_id(identity)
        key = f"{owner}:{_clean(project_id)}"
        with self._lock:
            if key not in self._projects:
                return False
            self._projects.pop(key, None)
            self._save_locked()
            return True


image_canvas_service = ImageCanvasService(DATA_DIR / "image_canvas_projects.json")
