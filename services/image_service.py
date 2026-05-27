from __future__ import annotations

import io
import hashlib
import re
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from services.config import config
from services.image_tags_service import load_tags, remove_tags

THUMBNAIL_SIZE = (320, 320)


def _cleanup_empty_dirs(root: Path) -> None:
    for path in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def _safe_relative_path(path: str) -> str:
    value = str(path or "").strip().replace("\\", "/").lstrip("/")
    if not value:
        raise HTTPException(status_code=404, detail="image not found")
    parts = Path(value).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=404, detail="image not found")
    return Path(*parts).as_posix()


def _identity_owner_id(identity: dict[str, object] | None) -> str:
    if not isinstance(identity, dict):
        return ""
    return str(identity.get("id") or "").strip()


def _identity_is_admin(identity: dict[str, object] | None) -> bool:
    return isinstance(identity, dict) and str(identity.get("role") or "").strip().lower() == "admin"


def _safe_owner_segment(owner_id: str | None) -> str:
    value = str(owner_id or "").strip()
    if not value:
        return ""
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")
    if cleaned:
        return cleaned[:80]
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def _owner_prefix(identity: dict[str, object] | None) -> str:
    owner = _safe_owner_segment(_identity_owner_id(identity))
    return f"users/{owner}/" if owner else ""


def _can_access_image(relative_path: str, identity: dict[str, object] | None = None) -> bool:
    if identity is None or _identity_is_admin(identity):
        return True
    prefix = _owner_prefix(identity)
    return bool(prefix and _safe_relative_path(relative_path).startswith(prefix))


def image_path_is_accessible(relative_path: str, identity: dict[str, object] | None = None) -> bool:
    try:
        rel = _safe_relative_path(relative_path)
    except HTTPException:
        return False
    if not _can_access_image(rel, identity):
        return False
    try:
        _safe_image_path(rel)
    except HTTPException:
        return False
    return True


def _safe_image_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    root = config.images_dir.resolve()
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="image not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="image not found")
    return path


def _thumbnail_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    return config.image_thumbnails_dir / f"{rel}.png"


def thumbnail_url(base_url: str, relative_path: str) -> str:
    return f"{base_url.rstrip('/')}/image-thumbnails/{_safe_relative_path(relative_path)}"


def _image_dimensions(path: Path) -> tuple[int, int] | None:
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return None


def ensure_thumbnail(relative_path: str) -> Path:
    source = _safe_image_path(relative_path)
    target = _thumbnail_path(relative_path)
    source_mtime = source.stat().st_mtime
    if target.exists() and target.stat().st_mtime >= source_mtime:
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            image.save(target, format="PNG", optimize=True)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail="failed to create thumbnail") from exc
    return target


def get_thumbnail_response(relative_path: str) -> FileResponse:
    return FileResponse(ensure_thumbnail(relative_path))


def get_image_download_response(relative_path: str, identity: dict[str, object] | None = None) -> FileResponse:
    if not _can_access_image(relative_path, identity):
        raise HTTPException(status_code=404, detail="image not found")
    path = _safe_image_path(relative_path)
    return FileResponse(path, filename=path.name)


def cleanup_image_thumbnails() -> int:
    thumbnails_root = config.image_thumbnails_dir
    images_root = config.images_dir
    removed = 0
    for path in thumbnails_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(thumbnails_root).as_posix()
        if not rel.endswith(".png") or not (images_root / rel[:-4]).exists():
            path.unlink()
            removed += 1
    _cleanup_empty_dirs(thumbnails_root)
    return removed


def _image_day_from_rel(rel: str, path: Path) -> str:
    parts = rel.split("/")
    if len(parts) >= 5 and parts[0] == "users":
        return "-".join(parts[2:5])
    return "-".join(parts[:3]) if len(parts) >= 4 else datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")


def _image_items(start_date: str = "", end_date: str = "", identity: dict[str, object] | None = None) -> list[dict[str, object]]:
    items = []
    root = config.images_dir
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if not _can_access_image(rel, identity):
            continue
        day = _image_day_from_rel(rel, path)
        if start_date and day < start_date:
            continue
        if end_date and day > end_date:
            continue
        dimensions = _image_dimensions(path)
        items.append({
            "rel": rel,
            "path": rel,
            "name": path.name,
            "date": day,
            "size": path.stat().st_size,
            "created_at": datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
        })
    items.sort(key=lambda item: str(item["created_at"]), reverse=True)
    return items


def list_images(
    base_url: str,
    start_date: str = "",
    end_date: str = "",
    identity: dict[str, object] | None = None,
) -> dict[str, object]:
    config.cleanup_old_images()
    cleanup_image_thumbnails()
    all_tags = load_tags()
    items = [
        {
            **item,
            "url": f"{base_url.rstrip('/')}/images/{item['path']}",
            "thumbnail_url": thumbnail_url(base_url, str(item["path"])),
            "tags": all_tags.get(str(item["path"]), []),
        }
        for item in _image_items(start_date, end_date, identity)
    ]
    groups: dict[str, list[dict[str, object]]] = {}
    for item in items:
        groups.setdefault(str(item["date"]), []).append(item)
    return {"items": items, "groups": [{"date": key, "items": value} for key, value in groups.items()]}


def delete_images(
    paths: list[str] | None = None,
    start_date: str = "",
    end_date: str = "",
    all_matching: bool = False,
    identity: dict[str, object] | None = None,
) -> dict[str, int]:
    root = config.images_dir.resolve()
    targets = [str(item["path"]) for item in _image_items(start_date, end_date, identity)] if all_matching else (paths or [])
    removed = 0
    for item in targets:
        if not _can_access_image(item, identity):
            continue
        path = (root / item).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        if path.is_file():
            path.unlink()
            for thumbnail in (_thumbnail_path(item), config.image_thumbnails_dir / _safe_relative_path(item)):
                if thumbnail.is_file():
                    thumbnail.unlink()
            remove_tags(item)
            removed += 1
    _cleanup_empty_dirs(root)
    _cleanup_empty_dirs(config.image_thumbnails_dir)
    return {"removed": removed}


def download_images_zip(paths: list[str], identity: dict[str, object] | None = None) -> io.BytesIO:
    root = config.images_dir.resolve()
    buf = io.BytesIO()
    added = 0
    used_names: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in paths:
            rel = _safe_relative_path(item)
            if not _can_access_image(rel, identity):
                continue
            path = (root / rel).resolve()
            try:
                path.relative_to(root)
            except ValueError:
                continue
            if not path.is_file():
                continue
            name = path.name
            if name in used_names:
                stem = path.stem
                suffix = path.suffix
                counter = 2
                while f"{stem}_{counter}{suffix}" in used_names:
                    counter += 1
                name = f"{stem}_{counter}{suffix}"
            used_names.add(name)
            zf.write(path, name)
            added += 1
    if added == 0:
        raise HTTPException(status_code=404, detail="no images found")
    buf.seek(0)
    return buf
