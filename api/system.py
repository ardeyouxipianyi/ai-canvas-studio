from __future__ import annotations

from urllib.parse import quote

import json

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict

from api.support import require_admin, require_identity, resolve_image_base_url
from services.auth_service import auth_service
from services.backup_service import BackupError, backup_service
from services.config import config
from services.image_service import (
    delete_images,
    download_images_zip,
    get_image_download_response,
    get_thumbnail_response,
    image_path_is_accessible,
    list_images,
)
from services.image_tags_service import delete_tag, get_all_tags, set_tags
from services.log_service import log_service
from services.proxy_service import test_proxy


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class ProxyTestRequest(BaseModel):
    url: str = ""


class ReversePromptInstructionRequest(BaseModel):
    instruction: str = ""


class AdminPasswordUpdateRequest(BaseModel):
    current_key: str = ""
    new_key: str = ""


class AdminSetupRequest(BaseModel):
    new_key: str = ""


class ImageDeleteRequest(BaseModel):
    paths: list[str] = []
    start_date: str = ""
    end_date: str = ""
    all_matching: bool = False

class ImageDownloadRequest(BaseModel):
    paths: list[str]

class ImageTagsRequest(BaseModel):
    path: str
    tags: list[str]

class LogDeleteRequest(BaseModel):
    ids: list[str] = []
class BackupDeleteRequest(BaseModel):
    key: str = ""


class DataTransferRequest(BaseModel):
    include: dict[str, bool] = {}
    include_sensitive: bool = False


def _accessible_image_paths(identity: dict[str, object]) -> set[str] | None:
    if identity.get("role") == "admin":
        return None
    data = list_images("", identity=identity)
    return {str(item.get("path") or "") for item in data.get("items", []) if item.get("path")}


def create_router(app_version: str) -> APIRouter:
    router = APIRouter()

    @router.post("/auth/login")
    async def login(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {
            "ok": True,
            "version": app_version,
            "role": identity.get("role"),
            "subject_id": identity.get("id"),
            "name": identity.get("name"),
        }

    @router.get("/auth/setup-status")
    async def get_setup_status():
        return {
            "setup_required": config.setup_required,
            "admin_auth_key_editable": config.admin_auth_key_editable,
            "version": app_version,
        }

    @router.post("/auth/setup")
    async def initialize_admin_password(body: AdminSetupRequest):
        new_key = str(body.new_key or "").strip()
        if auth_service.raw_key_exists(new_key):
            raise HTTPException(status_code=400, detail={"error": "管理员密码不能和已有用户密钥相同"})
        try:
            config.initialize_admin_auth_key(new_key)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {
            "ok": True,
            "version": app_version,
            "role": "admin",
            "subject_id": "admin",
            "name": "管理员",
        }

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/api/settings")
    async def get_settings(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.get()}

    @router.post("/api/settings")
    async def save_settings(body: SettingsUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.update(body.model_dump(mode="python"))}

    @router.post("/api/auth/admin-password")
    async def update_admin_password(body: AdminPasswordUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        new_key = str(body.new_key or "").strip()
        if auth_service.raw_key_exists(new_key):
            raise HTTPException(status_code=400, detail={"error": "新管理员密码不能和已有用户密钥相同"})
        try:
            config.update_admin_auth_key(body.current_key, new_key)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {
            "ok": True,
            "version": app_version,
            "role": "admin",
            "subject_id": "admin",
            "name": "管理员",
        }

    @router.get("/api/reverse-prompt-instruction")
    async def get_reverse_prompt_instruction(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        return {"instruction": config.reverse_prompt_instruction}

    @router.post("/api/reverse-prompt-instruction")
    async def save_reverse_prompt_instruction(body: ReversePromptInstructionRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        updated = config.update({"reverse_prompt_instruction": body.instruction.strip()})
        return {"instruction": updated.get("reverse_prompt_instruction") or config.reverse_prompt_instruction, "config": updated}

    @router.get("/api/images")
    async def get_images(request: Request, start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return list_images(resolve_image_base_url(request), start_date=start_date.strip(), end_date=end_date.strip(), identity=identity)

    @router.get("/image-thumbnails/{image_path:path}", include_in_schema=False)
    async def get_image_thumbnail(image_path: str):
        return get_thumbnail_response(image_path)

    @router.post("/api/images/delete")
    async def delete_images_endpoint(body: ImageDeleteRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return delete_images(
            body.paths,
            start_date=body.start_date.strip(),
            end_date=body.end_date.strip(),
            all_matching=body.all_matching,
            identity=identity,
        )

    @router.post("/api/images/download")
    async def download_images_endpoint(body: ImageDownloadRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        buf = download_images_zip(body.paths, identity)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="images.zip"'},
        )

    @router.get("/api/images/download/{image_path:path}")
    async def download_single_image_endpoint(image_path: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return get_image_download_response(image_path, identity)

    @router.get("/api/logs")
    @router.get("/api/logs/", include_in_schema=False)
    async def get_logs(type: str = "", start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": log_service.list(type=type.strip(), start_date=start_date.strip(), end_date=end_date.strip())}

    @router.post("/api/logs/delete")
    @router.post("/api/logs/delete/", include_in_schema=False)
    async def delete_logs(body: LogDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return log_service.delete(body.ids)

    @router.post("/api/proxy/test")
    async def test_proxy_endpoint(body: ProxyTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        candidate = (body.url or "").strip() or config.get_proxy_settings()
        if not candidate:
            raise HTTPException(status_code=400, detail={"error": "proxy url is required"})
        return {"result": await run_in_threadpool(test_proxy, candidate)}

    @router.get("/api/storage/info")
    async def get_storage_info(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        storage = config.get_storage_backend()
        return {
            "backend": storage.get_backend_info(),
            "health": storage.health_check(),
        }

    @router.post("/api/backup/test")
    async def test_backup_connection(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.test_connection)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups")
    async def get_backups(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {
                "items": await run_in_threadpool(backup_service.list_backups),
                "state": backup_service.get_status(),
                "settings": backup_service.get_settings(),
            }
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/run")
    async def run_backup_endpoint(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.run_backup)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/delete")
    async def delete_backup_endpoint(body: BackupDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            await run_in_threadpool(backup_service.delete_backup, body.key)
            return {"ok": True}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/data/export")
    async def export_data_endpoint(body: DataTransferRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = await run_in_threadpool(backup_service.export_data, body.include, body.include_sensitive)
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        filename = str(item.get("name") or "chatgpt2api-data.tar.gz")
        quoted = quote(filename)
        return Response(
            content=bytes(item.get("payload") or b""),
            media_type=str(item.get("content_type") or "application/gzip"),
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
                "Content-Length": str(int(item.get("size") or 0)),
            },
        )

    @router.post("/api/data/import")
    async def import_data_endpoint(
            include: str = Form(default="{}"),
            file: UploadFile = File(...),
            authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        try:
            parsed_include = json.loads(include or "{}")
        except Exception as exc:
            raise HTTPException(status_code=400, detail={"error": "导入选项格式不正确"}) from exc
        if not isinstance(parsed_include, dict):
            raise HTTPException(status_code=400, detail={"error": "导入选项格式不正确"})
        payload = await file.read()
        try:
            result = await run_in_threadpool(
                backup_service.import_data,
                payload,
                parsed_include,
                filename=str(file.filename or ""),
            )
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"ok": True, "result": result}

    @router.get("/api/backups/detail")
    async def get_backup_detail(key: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"item": await run_in_threadpool(backup_service.get_backup_detail, key)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups/download")
    async def download_backup_endpoint(key: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = await run_in_threadpool(backup_service.download_backup, key)
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        filename = str(item.get("name") or "backup.bin")
        quoted = quote(filename)
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            "Content-Length": str(int(item.get("size") or 0)),
        }
        return Response(
            content=bytes(item.get("payload") or b""),
            media_type=str(item.get("content_type") or "application/octet-stream"),
            headers=headers,
        )


    @router.get("/api/images/tags")
    async def list_image_tags(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"tags": get_all_tags(_accessible_image_paths(identity))}

    @router.post("/api/images/tags")
    async def update_image_tags(body: ImageTagsRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        rel = body.path.strip().lstrip("/")
        if not rel:
            raise HTTPException(status_code=400, detail={"error": "path is required"})
        if not image_path_is_accessible(rel, identity):
            raise HTTPException(status_code=404, detail={"error": "image not found"})
        tags = set_tags(rel, body.tags)
        return {"ok": True, "tags": tags}

    @router.delete("/api/images/tags/{tag}")
    async def delete_image_tag(tag: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        count = delete_tag(tag, _accessible_image_paths(identity))
        return {"ok": True, "removed_from": count}

    return router
