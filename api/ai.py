from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from api.support import require_identity, resolve_image_base_url
from services.content_filter import check_request, request_text
from services.log_service import LoggedCall
from services.protocol import (
    anthropic_v1_messages,
    openai_v1_chat_complete,
    openai_v1_image_edit,
    openai_v1_image_generations,
    openai_v1_models,
    openai_v1_response,
)
from utils.helper import decode_image_source


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    n: int = Field(default=1, ge=1, le=4)
    size: str | None = None
    response_format: str = "b64_json"
    history_disabled: bool = True
    stream: bool | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


class AnthropicMessageRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[dict[str, object]] | None = None
    system: object | None = None
    stream: bool | None = None


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


def _parse_image_count(value: object) -> int:
    try:
        n = int(value or 1)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail={"error": "n must be an integer"}) from exc
    if n < 1 or n > 4:
        raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
    return n


def _parse_optional_bool(value: object) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


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


async def _images_from_form(request: Request) -> tuple[dict[str, Any], list[tuple[bytes, str, str]]]:
    form = await request.form()
    payload = {
        "prompt": str(form.get("prompt") or ""),
        "model": str(form.get("model") or "gpt-image-2"),
        "n": _parse_image_count(form.get("n")),
        "size": str(form.get("size") or "") or None,
        "response_format": str(form.get("response_format") or "b64_json"),
        "stream": _parse_optional_bool(form.get("stream")),
        "message_as_error": _parse_optional_bool(form.get("message_as_error")),
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


async def _images_from_json(request: Request) -> tuple[dict[str, Any], list[tuple[bytes, str, str]]]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid JSON body"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "JSON body must be an object"})
    message_as_error = body.get("message_as_error") if "message_as_error" in body else body.get("messageAsError")
    payload = {
        "prompt": str(body.get("prompt") or ""),
        "model": str(body.get("model") or "gpt-image-2"),
        "n": _parse_image_count(body.get("n")),
        "size": str(body.get("size") or "") or None,
        "response_format": str(body.get("response_format") or body.get("responseFormat") or "b64_json"),
        "stream": _parse_optional_bool(body.get("stream")),
        "message_as_error": _parse_optional_bool(message_as_error),
    }
    return payload, _images_from_json_body(body)


async def _parse_image_edit_request(request: Request) -> tuple[dict[str, Any], list[tuple[bytes, str, str]]]:
    content_type = request.headers.get("content-type", "").lower()
    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        return await _images_from_form(request)
    return await _images_from_json(request)


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/v1/models")
    async def list_models(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        try:
            return await run_in_threadpool(openai_v1_models.list_models)
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/images/generations")
    async def generate_images(
            body: ImageGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        payload = body.model_dump(mode="python")
        payload["base_url"] = resolve_image_base_url(request)
        payload["owner_id"] = identity.get("id")
        call = LoggedCall(identity, "/v1/images/generations", body.model, "文生图", request_text=body.prompt)
        await filter_or_log(call, body.prompt)
        return await call.run(openai_v1_image_generations.handle, payload)

    @router.post("/v1/images/edits")
    async def edit_images(
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        parsed, images = await _parse_image_edit_request(request)
        prompt = parsed["prompt"]
        model = parsed["model"]
        call = LoggedCall(identity, "/v1/images/edits", model, "图生图", request_text=prompt)
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})
        await filter_or_log(call, prompt)
        if not images:
            raise HTTPException(
                status_code=400,
                detail={"error": "image file, data URL, base64 image, or http(s) image URL is required"},
            )
        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": parsed["n"],
            "size": parsed["size"],
            "response_format": parsed["response_format"],
            "stream": parsed["stream"],
            "message_as_error": parsed["message_as_error"],
            "base_url": resolve_image_base_url(request),
            "owner_id": identity.get("id"),
        }
        return await call.run(openai_v1_image_edit.handle, payload)

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("prompt"), payload.get("messages"))
        call = LoggedCall(identity, "/v1/chat/completions", model, "文本生成", request_text=request_preview)
        await filter_or_log(call, request_preview)
        return await call.run(openai_v1_chat_complete.handle, payload)

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("input"), payload.get("instructions"))
        call = LoggedCall(identity, "/v1/responses", model, "Responses", request_text=request_preview)
        await filter_or_log(call, request_preview)
        return await call.run(openai_v1_response.handle, payload)

    @router.post("/v1/messages")
    async def create_message(
            body: AnthropicMessageRequest,
            authorization: str | None = Header(default=None),
            x_api_key: str | None = Header(default=None, alias="x-api-key"),
            anthropic_version: str | None = Header(default=None, alias="anthropic-version"),
    ):
        identity = require_identity(authorization or (f"Bearer {x_api_key}" if x_api_key else None))
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("system"), payload.get("messages"), payload.get("tools"))
        call = LoggedCall(identity, "/v1/messages", model, "Messages", request_text=request_preview)
        await filter_or_log(call, request_preview)
        return await call.run(anthropic_v1_messages.handle, payload, sse="anthropic")

    return router
