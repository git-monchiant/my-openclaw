"""Gemini image-generation backend for Hermes.

Generates images via Google AI Studio's ``gemini-2.5-flash-image`` ("nano
banana") using the same ``GOOGLE_API_KEY`` the chat model uses — no extra
provider signup. Registered as an image_gen provider; selected automatically
when no other backend is configured (FAL/OpenAI/xAI need their own keys).
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import requests

from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    resolve_aspect_ratio,
    save_b64_image,
    success_response,
)

logger = logging.getLogger(__name__)

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-3-pro-image-preview"
# Aspect ratios gemini-3 image models accept (others 400).
GEMINI_ASPECTS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
                  "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"}


def _api_key() -> str:
    return (os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or "").strip()


class GeminiImageGenProvider(ImageGenProvider):
    @property
    def name(self) -> str:
        return "gemini"

    @property
    def display_name(self) -> str:
        return "Gemini (Google)"

    def is_available(self) -> bool:
        return bool(_api_key())

    def list_models(self) -> List[Dict[str, Any]]:
        return [
            {"id": "gemini-3-pro-image-preview",
             "tag": "gemini-3-pro-image-preview — high quality (default)"},
            {"id": "gemini-2.5-flash-image",
             "tag": "gemini-2.5-flash-image — faster, lower cost ('nano banana')"},
        ]

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": self.display_name,
            "env_vars": ["GOOGLE_API_KEY"],
        }

    def generate(self, prompt: str, aspect_ratio: str = DEFAULT_ASPECT_RATIO,
                 **kwargs: Any) -> Dict[str, Any]:
        key = _api_key()
        aspect = resolve_aspect_ratio(aspect_ratio)
        if not key:
            return error_response(
                error="No GOOGLE_API_KEY set for Gemini image generation.",
                error_type="missing_api_key", provider="gemini", aspect_ratio=aspect,
            )
        model_id = str(kwargs.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL

        gen_cfg: Dict[str, Any] = {"responseModalities": ["IMAGE"]}
        # gemini-3 image models accept an explicit aspect ratio (must be one of
        # GEMINI_ASPECTS, else the API 400s). Fall back to square.
        if model_id.startswith("gemini-3"):
            gen_cfg["imageConfig"] = {"aspectRatio": aspect if aspect in GEMINI_ASPECTS else "1:1"}

        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": gen_cfg,
        }
        try:
            resp = requests.post(
                f"{GEMINI_BASE}/models/{model_id}:generateContent",
                params={"key": key},
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
        except requests.HTTPError as exc:
            r = exc.response
            status = r.status_code if r is not None else 0
            try:
                msg = r.json().get("error", {}).get("message", r.text[:300])
            except Exception:
                msg = (r.text[:300] if r is not None else str(exc))
            logger.error("Gemini image gen failed (%s): %s", status, msg)
            return error_response(
                error=f"Gemini image generation failed ({status}): {msg}",
                error_type="api_error", provider="gemini", model=model_id,
                prompt=prompt, aspect_ratio=aspect,
            )
        except requests.Timeout:
            return error_response(
                error="Gemini image generation timed out (120s)",
                error_type="timeout", provider="gemini", model=model_id,
                prompt=prompt, aspect_ratio=aspect,
            )
        except requests.RequestException as exc:
            return error_response(
                error=f"Gemini connection error: {exc}",
                error_type="connection_error", provider="gemini", model=model_id,
                prompt=prompt, aspect_ratio=aspect,
            )

        try:
            data = resp.json()
            parts = data["candidates"][0]["content"]["parts"]
        except Exception as exc:
            return error_response(
                error=f"Gemini returned an unexpected response: {exc}",
                error_type="invalid_response", provider="gemini", model=model_id,
                prompt=prompt, aspect_ratio=aspect,
            )

        b64 = None
        mime = "image/png"
        for p in parts:
            inl = p.get("inlineData") or p.get("inline_data")
            if inl and inl.get("data"):
                b64 = inl["data"]
                mime = inl.get("mimeType") or inl.get("mime_type") or "image/png"
                break
        if not b64:
            # Model may have refused and returned text only.
            text = " ".join(p.get("text", "") for p in parts if p.get("text"))[:200]
            return error_response(
                error=f"Gemini returned no image{(' — ' + text) if text else ''}",
                error_type="empty_response", provider="gemini", model=model_id,
                prompt=prompt, aspect_ratio=aspect,
            )

        ext = "jpg" if "jpeg" in mime else "png"
        try:
            saved = save_b64_image(b64, prefix=f"gemini_{model_id}", extension=ext)
        except Exception as exc:
            return error_response(
                error=f"Could not save image to cache: {exc}",
                error_type="io_error", provider="gemini", model=model_id,
                prompt=prompt, aspect_ratio=aspect,
            )

        return success_response(
            image=str(saved), model=model_id, prompt=prompt,
            aspect_ratio=aspect, provider="gemini",
        )


def register(ctx) -> None:
    """Plugin entry point — register the Gemini image-gen backend."""
    ctx.register_image_gen_provider(GeminiImageGenProvider())
