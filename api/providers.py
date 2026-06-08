from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict

from api.support import require_admin, require_identity
from services.image_provider_service import image_provider_service


class ProviderRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class ProviderDefaultRequest(BaseModel):
    provider_id: str
    purpose: str = "generate"


class ProviderTestRequest(BaseModel):
    model: str = ""


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-providers")
    async def list_image_providers(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        return await run_in_threadpool(image_provider_service.list_providers)

    @router.post("/api/image-providers")
    async def save_image_provider(body: ProviderRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = await run_in_threadpool(image_provider_service.save_provider, body.model_dump(mode="python"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        providers = await run_in_threadpool(image_provider_service.list_providers)
        return {"item": item, **providers}

    @router.delete("/api/image-providers/{provider_id}")
    async def delete_image_provider(provider_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        deleted = await run_in_threadpool(image_provider_service.delete_provider, provider_id)
        if not deleted:
            raise HTTPException(status_code=404, detail={"error": "provider not found"})
        return await run_in_threadpool(image_provider_service.list_providers)

    @router.post("/api/image-providers/default")
    async def set_default_image_provider(body: ProviderDefaultRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            await run_in_threadpool(lambda: image_provider_service.set_default_provider(body.provider_id, purpose=body.purpose))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return await run_in_threadpool(image_provider_service.list_providers)

    @router.post("/api/image-providers/{provider_id}/test")
    async def test_image_provider(
        provider_id: str,
        body: ProviderTestRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        try:
            model = body.model if body else ""
            return {"result": await run_in_threadpool(lambda: image_provider_service.test_provider(provider_id, model=model))}
        except Exception as exc:
            return {"result": {"ok": False, "status": 0, "latency_ms": 0, "error": str(exc)}}

    @router.get("/api/image-providers/{provider_id}/api-key")
    async def reveal_image_provider_api_key(provider_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"api_key": await run_in_threadpool(image_provider_service.get_provider_api_key, provider_id)}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail={"error": str(exc)}) from exc

    @router.get("/api/image-providers/{provider_id}/models")
    async def list_image_provider_models(provider_id: str, authorization: str | None = Header(default=None)):
        require_identity(authorization)
        try:
            return await run_in_threadpool(image_provider_service.list_models, provider_id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    return router
