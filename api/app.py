from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import auth_users, image_canvas, image_conversations, image_tasks, providers, system
from api.errors import install_exception_handlers
from api.support import resolve_web_asset
from services.backup_service import backup_service
from services.config import config


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        backup_service.start()
        config.cleanup_old_images()
        try:
            yield
        finally:
            backup_service.stop()

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    install_exception_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(auth_users.create_router())
    app.include_router(image_canvas.create_router())
    app.include_router(image_conversations.create_router())
    app.include_router(image_tasks.create_router())
    app.include_router(providers.create_router())
    app.include_router(system.create_router(app_version))
    if config.images_dir.exists():
        app.mount("/images", StaticFiles(directory=str(config.images_dir)), name="images")

    @app.api_route("/v1", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
    @app.api_route("/v1/{_:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
    async def disabled_v1_compatibility(_: str = ""):
        raise HTTPException(status_code=404, detail="Not Found")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str, request: Request):
        prefer_rsc = request.headers.get("rsc") == "1" or "_rsc" in request.query_params
        asset = resolve_web_asset(full_path, prefer_rsc=prefer_rsc)
        if asset is not None:
            return FileResponse(asset)
        clean_path = full_path.strip("/")
        if clean_path == "v1" or clean_path.startswith(("_next/", "api/", "v1/", "auth/")):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
