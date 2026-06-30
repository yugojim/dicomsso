from __future__ import annotations

from base64 import b64encode
import hashlib
import hmac
import logging
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger(__name__)

LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"


def is_configured() -> bool:
    return bool(settings.line_channel_access_token and settings.line_group_id)


def verify_signature(body: bytes, signature: str | None) -> bool:
    if not settings.line_channel_secret or not signature:
        return False

    digest = hmac.new(
        settings.line_channel_secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).digest()
    expected = b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected, signature)


def _format_dicom_date(value: str | None) -> str:
    if not value or len(value) != 8:
        return value or "-"
    return f"{value[0:4]}-{value[4:6]}-{value[6:8]}"


def build_upload_message(studies: list[dict[str, Any]], user: dict[str, Any]) -> str:
    unique_studies = []
    seen = set()
    for study in studies:
        study_key = study.get("orthanc_study_id") or study.get("study_instance_uid")
        if study_key in seen:
            continue
        seen.add(study_key)
        unique_studies.append(study)

    lines = [
        "DICOM 檔案上傳通知",
        f"上傳者：{user.get('username', '-')}",
        f"租戶：{user.get('tenant_id', '-')}",
        f"檢查數：{len(unique_studies)}",
    ]

    for index, study in enumerate(unique_studies[:5], start=1):
        lines.extend(
            [
                "",
                f"{index}. {study.get('filename') or '-'}",
                f"病歷號：{study.get('patient_id') or '-'}",
                f"病患：{study.get('patient_name') or '-'}",
                f"日期：{_format_dicom_date(study.get('study_date'))}",
                f"Modality：{study.get('modality') or '-'}",
                f"描述：{study.get('description') or '-'}",
            ]
        )

    if len(unique_studies) > 5:
        lines.append(f"\n另有 {len(unique_studies) - 5} 筆檢查未列出。")

    return "\n".join(lines)


async def push_text(message: str) -> None:
    if not is_configured():
        logger.info("LINE upload notification skipped because LINE settings are incomplete")
        return

    headers = {
        "Authorization": f"Bearer {settings.line_channel_access_token}",
        "Content-Type": "application/json",
    }
    payload = {
        "to": settings.line_group_id,
        "messages": [{"type": "text", "text": message[:5000]}],
    }

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(LINE_PUSH_URL, headers=headers, json=payload)
        response.raise_for_status()


async def notify_upload(studies: list[dict[str, Any]], user: dict[str, Any]) -> None:
    try:
        await push_text(build_upload_message(studies, user))
    except Exception:
        logger.exception("LINE upload notification failed")
