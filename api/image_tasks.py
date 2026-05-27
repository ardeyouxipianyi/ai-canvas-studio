from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.support import require_identity, resolve_image_base_url
from services.content_filter import check_request
from services.image_task_service import image_task_service
from services.log_service import LoggedCall
from utils.helper import decode_image_source


class ImageGenerationTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    size: str | None = None


class ReversePromptTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    image: object | None = None
    images: list[object] | None = None
    model: str = "gpt-image-2"


class ImageTaskCancelRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _image_filename(index: int, mime_type: str, source: object = None) -> str:
    if isinstance(source, dict):
        name = str(source.get("filename") or source.get("name") or "").strip()
        if name:
            return name
    extension = {
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }.get(mime_type, "png")
    return f"image_{index}.{extension}"


def _iter_json_image_sources(body: dict[str, Any]):
    for key in ("image", "images", "image[]", "input_image", "input_images", "inputImages"):
        value = body.get(key)
        if value is None:
            continue
        if isinstance(value, list):
            yield from value
        else:
            yield value


def _images_from_json_body(body: dict[str, Any]) -> list[tuple[bytes, str, str]]:
    images: list[tuple[bytes, str, str]] = []
    for index, source in enumerate(_iter_json_image_sources(body), start=1):
        decoded = decode_image_source(source)
        if not decoded:
            continue
        image_data, mime_type = decoded
        images.append((image_data, _image_filename(index, mime_type, source), mime_type))
    return images


def _images_from_reverse_prompt_body(body: ReversePromptTaskRequest) -> list[tuple[bytes, str, str]]:
    payload = body.model_dump(mode="python")
    return _images_from_json_body(payload)


async def _parse_edit_task_request(request: Request) -> tuple[dict[str, str | None], list[tuple[bytes, str, str]]]:
    content_type = request.headers.get("content-type", "").lower()
    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        payload = {
            "client_task_id": str(form.get("client_task_id") or "").strip(),
            "prompt": str(form.get("prompt") or ""),
            "model": str(form.get("model") or "gpt-image-2"),
            "size": str(form.get("size") or "") or None,
        }
        images: list[tuple[bytes, str, str]] = []
        for key in ("image", "image[]", "images"):
            for upload in form.getlist(key):
                if not hasattr(upload, "read"):
                    continue
                image_data = await upload.read()
                if not image_data:
                    raise HTTPException(status_code=400, detail={"error": "image file is empty"})
                images.append((
                    image_data,
                    str(getattr(upload, "filename", "") or _image_filename(len(images) + 1, "image/png")),
                    str(getattr(upload, "content_type", "") or "image/png"),
                ))
        return payload, images

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid JSON body"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "JSON body must be an object"})
    payload = {
        "client_task_id": str(body.get("client_task_id") or body.get("clientTaskId") or "").strip(),
        "prompt": str(body.get("prompt") or ""),
        "model": str(body.get("model") or "gpt-image-2"),
        "size": str(body.get("size") or "") or None,
    }
    return payload, _images_from_json_body(body)


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-tasks")
    async def list_image_tasks(
        ids: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_task_service.list_tasks, identity, _parse_task_ids(ids))

    @router.post("/api/image-tasks/cancel")
    async def cancel_image_tasks(
        body: ImageTaskCancelRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_task_service.cancel_tasks, identity, body.ids)

    @router.post("/api/image-tasks/generations")
    async def create_generation_task(
        body: ImageGenerationTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/generations", body.model, "文生图任务", request_text=body.prompt), body.prompt)
        try:
            return await run_in_threadpool(
                image_task_service.submit_generation,
                identity,
                client_task_id=body.client_task_id,
                prompt=body.prompt,
                model=body.model,
                size=body.size,
                base_url=resolve_image_base_url(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/edits")
    async def create_edit_task(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        payload, images = await _parse_edit_task_request(request)
        client_task_id = str(payload.get("client_task_id") or "").strip()
        prompt = str(payload.get("prompt") or "")
        model = str(payload.get("model") or "gpt-image-2")
        size = payload.get("size")
        if not client_task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        if not prompt.strip():
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/edits", model, "图生图任务", request_text=prompt), prompt)
        if not images:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        try:
            return await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=client_task_id,
                prompt=prompt,
                model=model,
                size=size,
                base_url=resolve_image_base_url(request),
                images=images,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/reverse-prompts")
    async def create_reverse_prompt_task(
        body: ReversePromptTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        prompt = str(body.prompt or "")
        model = str(body.model or "gpt-image-2")
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/reverse-prompts", model, "反推提示词任务", request_text=prompt), prompt)
        images = _images_from_reverse_prompt_body(body)
        if not images:
            raise HTTPException(
                status_code=400,
                detail={"error": "image file, data URL, base64 image, or http(s) image URL is required"},
            )
        try:
            return await run_in_threadpool(
                image_task_service.submit_reverse_prompt,
                identity,
                client_task_id=body.client_task_id,
                prompt=prompt,
                model=model,
                base_url=resolve_image_base_url(request),
                images=images,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    return router
