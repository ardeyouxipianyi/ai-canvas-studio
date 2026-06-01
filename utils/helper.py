import base64
import binascii
import hashlib
import json
import mimetypes
import re
import time
import uuid
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import unquote, urlparse

from curl_cffi import requests
from fastapi import HTTPException
from utils.log import logger

BASE_IMAGE_MODELS = {"gpt-image-2", "codex-gpt-image-2"}
IMAGE_MODEL_PLAN_TYPES = ("plus", "team", "pro")
CODEX_IMAGE_MODEL = "codex-gpt-image-2"
PREFIXED_CODEX_IMAGE_MODELS = {
    f"{plan_type}-{CODEX_IMAGE_MODEL}"
    for plan_type in IMAGE_MODEL_PLAN_TYPES
}
IMAGE_MODELS = BASE_IMAGE_MODELS | PREFIXED_CODEX_IMAGE_MODELS
PUBLIC_IMAGE_MODELS = IMAGE_MODELS
OUTPUT_DIR = Path(__file__).resolve().parent / "output"
MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024


def new_uuid() -> str:
    return str(uuid.uuid4())


def split_image_model(model: object) -> tuple[str | None, str | None]:
    normalized = str(model or "").strip().lower()
    if not normalized:
        return None, None
    if normalized in BASE_IMAGE_MODELS:
        return None, normalized
    for plan_type in IMAGE_MODEL_PLAN_TYPES:
        prefix = f"{plan_type}-"
        if normalized.startswith(prefix):
            base_model = normalized[len(prefix):]
            if base_model == CODEX_IMAGE_MODEL:
                return plan_type, base_model
    return None, None


def is_supported_image_model(model: object) -> bool:
    _, base_model = split_image_model(model)
    return base_model is not None


def is_codex_image_model(model: object) -> bool:
    _, base_model = split_image_model(model)
    return base_model == CODEX_IMAGE_MODEL


def is_image_chat_request(body: dict[str, object]) -> bool:
    model = str(body.get("model") or "").strip()
    modalities = body.get("modalities")
    if is_supported_image_model(model):
        return True
    return isinstance(modalities, list) and "image" in {str(item or "").strip().lower() for item in modalities}


def ensure_ok(response: requests.Response, context: str) -> None:
    if 200 <= response.status_code < 300:
        return
    body: Any = response.text
    try:
        body = response.json()
    except Exception:
        pass
    raise RuntimeError(f"{context} failed: status={response.status_code}, body={body}")


def sse_json_stream(items) -> Iterator[str]:
    yield ": stream-open\n\n"
    try:
        for item in items:
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
    except Exception as exc:
        logger.warning({
            "event": "sse_stream_error",
            "error_type": exc.__class__.__name__,
            "error": str(exc),
        })
        error = exc.to_openai_error() if hasattr(exc, "to_openai_error") else {
            "error": {"message": str(exc), "type": exc.__class__.__name__}
        }
        yield f"data: {json.dumps(error, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


def anthropic_sse_stream(items) -> Iterator[str]:
    try:
        for item in items:
            event = str(item.get("type") or "message_delta") if isinstance(item, dict) else "message_delta"
            yield f"event: {event}\n"
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
    except Exception as exc:
        logger.warning({
            "event": "anthropic_sse_stream_error",
            "error_type": exc.__class__.__name__,
            "error": str(exc),
        })
        error = {"type": "error", "error": {"type": exc.__class__.__name__, "message": str(exc)}}
        yield "event: error\n"
        yield f"data: {json.dumps(error, ensure_ascii=False)}\n\n"


def iter_sse_payloads(response: requests.Response) -> Iterator[str]:
    for raw_line in response.iter_lines():
        if not raw_line:
            continue
        line = raw_line.decode("utf-8", errors="ignore") if isinstance(raw_line, bytes) else str(raw_line)
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload:
            yield payload


def save_images_from_text(text: str, prefix: str) -> list[Path]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    matches = re.findall(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", text or "")
    saved_paths: list[Path] = []
    timestamp = int(time.time() * 1000)
    for index, data_url in enumerate(matches, start=1):
        header, encoded = data_url.split(",", 1)
        image_type = header.split(";")[0].removeprefix("data:image/").strip() or "png"
        extension = "jpg" if image_type == "jpeg" else image_type
        output_path = OUTPUT_DIR / f"{prefix}_{timestamp}_{index}.{extension}"
        output_path.write_bytes(base64.b64decode(encoded))
        saved_paths.append(output_path)
    return saved_paths


def anonymize_token(token: object) -> str:
    value = str(token or "").strip()
    if not value:
        return "token:empty"
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
    return f"token:{digest}"


def extract_response_prompt(input_value: object) -> str:
    if isinstance(input_value, str):
        return input_value.strip()
    if isinstance(input_value, dict):
        role = str(input_value.get("role") or "").strip().lower()
        if role and role != "user":
            return ""
        return extract_prompt_from_message_content(input_value.get("content"))
    if not isinstance(input_value, list):
        return ""
    prompt_parts: list[str] = []
    for item in input_value:
        if isinstance(item, dict) and str(item.get("type") or "").strip() == "input_text":
            text = str(item.get("text") or "").strip()
            if text:
                prompt_parts.append(text)
            continue
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role and role != "user":
            continue
        prompt = extract_prompt_from_message_content(item.get("content"))
        if prompt:
            prompt_parts.append(prompt)
    return "\n".join(prompt_parts).strip()


def has_response_image_generation_tool(body: dict[str, object]) -> bool:
    tools = body.get("tools")
    if isinstance(tools, list):
        for tool in tools:
            if isinstance(tool, dict) and str(tool.get("type") or "").strip() == "image_generation":
                return True
    tool_choice = body.get("tool_choice")
    return isinstance(tool_choice, dict) and str(tool_choice.get("type") or "").strip() == "image_generation"


def extract_prompt_from_message_content(content: object) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "").strip()
        if item_type == "text":
            text = str(item.get("text") or "").strip()
            if text:
                parts.append(text)
        elif item_type == "input_text":
            text = str(item.get("text") or item.get("input_text") or "").strip()
            if text:
                parts.append(text)
    return "\n".join(parts).strip()


def _clean_mime(value: object, default: str = "image/png") -> str:
    mime = str(value or "").split(";", 1)[0].strip().lower()
    if mime == "image/jpg":
        return "image/jpeg"
    return mime if mime.startswith("image/") else default


def _decode_base64_image(value: str, mime: str = "image/png") -> tuple[bytes, str] | None:
    normalized = "".join(value.strip().split())
    if not normalized:
        return None
    try:
        return base64.b64decode(normalized, validate=True), _clean_mime(mime)
    except (binascii.Error, ValueError):
        return None


def _decode_data_url(value: str, default_mime: str = "image/png") -> tuple[bytes, str] | None:
    if not value.startswith("data:"):
        return None
    header, _, data = value.partition(",")
    if not data or ";base64" not in header.lower():
        return None
    mime = _clean_mime(header.split(";", 1)[0].removeprefix("data:"), default_mime)
    return _decode_base64_image(data, mime)


def _read_local_image_url(value: str, default_mime: str = "image/png") -> tuple[bytes, str] | None:
    parsed = urlparse(value)
    image_prefix = "/images/"
    path = unquote(parsed.path or "")
    if not path.startswith(image_prefix):
        return None

    rel_path = path.removeprefix(image_prefix).lstrip("/")
    if not rel_path:
        return None

    try:
        from services.config import config

        root = config.images_dir.resolve()
        image_path = (root / rel_path).resolve()
        image_path.relative_to(root)
    except Exception:
        return None

    if not image_path.is_file():
        return None
    content = image_path.read_bytes()
    if not content or len(content) > MAX_REMOTE_IMAGE_BYTES:
        return None
    mime_type = mimetypes.guess_type(image_path.name)[0] or default_mime
    return content, _clean_mime(mime_type, default_mime)


def _download_image_url(value: str, default_mime: str = "image/png") -> tuple[bytes, str] | None:
    if not value.startswith(("http://", "https://")):
        return None
    local_image = _read_local_image_url(value, default_mime)
    if local_image:
        return local_image
    from services.proxy_service import proxy_settings

    response = requests.get(
        value,
        headers={"Accept": "image/*,*/*;q=0.8", "User-Agent": "chatgpt2api image fetcher"},
        timeout=60,
        allow_redirects=True,
        **proxy_settings.build_session_kwargs(),
    )
    ensure_ok(response, "download image")
    content = bytes(response.content or b"")
    if not content or len(content) > MAX_REMOTE_IMAGE_BYTES:
        return None
    content_type = str(response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    guessed_type = mimetypes.guess_type(urlparse(value).path)[0] or ""
    if content_type and not content_type.startswith("image/") and content_type not in {"application/octet-stream", "binary/octet-stream"}:
        raise HTTPException(status_code=400, detail={"error": "image_url must point to an image"})
    if not content_type.startswith("image/") and guessed_type.startswith("image/"):
        content_type = guessed_type
    return content, _clean_mime(content_type, default_mime)


def decode_image_source(source: object, default_mime: str = "image/png") -> tuple[bytes, str] | None:
    if isinstance(source, (bytes, bytearray)):
        return bytes(source), _clean_mime(default_mime)

    mime = default_mime
    if isinstance(source, dict):
        mime = _clean_mime(
            source.get("media_type") or source.get("mediaType") or source.get("mime") or source.get("content_type"),
            default_mime,
        )
        image_url = source.get("image_url")
        if isinstance(image_url, dict):
            decoded = decode_image_source(image_url.get("url"), mime)
            if decoded:
                return decoded
        elif image_url is not None:
            decoded = decode_image_source(image_url, mime)
            if decoded:
                return decoded
        for key in ("url", "data", "base64", "image", "file_data"):
            if key in source:
                decoded = decode_image_source(source.get(key), mime)
                if decoded:
                    return decoded
        return None

    if not isinstance(source, str):
        return None
    value = source.strip()
    if not value:
        return None
    if value.startswith("data:"):
        return _decode_data_url(value, mime)
    if value.startswith(("http://", "https://")):
        return _download_image_url(value, mime)
    if value.startswith("file:"):
        return None
    return _decode_base64_image(value, mime)


def extract_image_from_message_content(content: object) -> list[tuple[bytes, str]]:
    if not isinstance(content, list):
        return []
    images = []
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "").strip()
        if item_type in {"image_url", "input_image", "image", "file"}:
            decoded = decode_image_source(item)
            if decoded:
                images.append(decoded)
    return images


def extract_chat_image(body: dict[str, object]) -> list[tuple[bytes, str]]:
    messages = body.get("messages")
    if not isinstance(messages, list):
        return []
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").strip().lower() != "user":
            continue
        images = extract_image_from_message_content(message.get("content"))
        if images:
            return images
    return []


def extract_chat_prompt(body: dict[str, object]) -> str:
    direct_prompt = str(body.get("prompt") or "").strip()
    if direct_prompt:
        return direct_prompt
    messages = body.get("messages")
    if not isinstance(messages, list):
        return ""
    prompt_parts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").strip().lower() != "user":
            continue
        prompt = extract_prompt_from_message_content(message.get("content"))
        if prompt:
            prompt_parts.append(prompt)
    return "\n".join(prompt_parts).strip()


def parse_image_count(raw_value: object) -> int:
    try:
        value = int(raw_value or 1)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail={"error": "n must be an integer"}) from exc
    if value < 1 or value > 4:
        raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
    return value


def build_chat_image_markdown_content(image_result: dict[str, object]) -> str:
    image_items = image_result.get("data") if isinstance(image_result.get("data"), list) else []
    markdown_images: list[str] = []
    for index, item in enumerate(image_items, start=1):
        if not isinstance(item, dict):
            continue
        b64_json = str(item.get("b64_json") or "").strip()
        if b64_json:
            markdown_images.append(f"![image_{index}](data:image/png;base64,{b64_json})")
    return "\n\n".join(markdown_images) if markdown_images else "Image generation completed."
