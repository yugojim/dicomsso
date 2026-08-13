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
LINE_VALIDATE_PUSH_URL = "https://api.line.me/v2/bot/message/validate/push"
LINE_SAMPLE_IMAGE_URL = "https://developers.line.biz/media/messaging-api/messages/image-full.png"
LINE_SAMPLE_PREVIEW_URL = "https://developers.line.biz/media/messaging-api/messages/image.png"
LINE_SAMPLE_VIDEO_URL = "https://samplelib.com/preview/mp4/sample-5s.mp4"
LINE_SAMPLE_AUDIO_URL = "https://samplelib.com/mp3/sample-3s.mp3"
LINE_SAMPLE_IMAGEMAP_URL = "https://example.com/bot/images/rm001"
LINE_EMOJI_PRODUCT_ID = "5ac1bfd5040ab15980c9b435"
LINE_TEXT_V2_EMOJI_PRODUCT_ID = LINE_EMOJI_PRODUCT_ID


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


def _chunk_messages(messages: list[dict[str, Any]], size: int = 5) -> list[list[dict[str, Any]]]:
    return [messages[index:index + size] for index in range(0, len(messages), size)]


async def push_messages(messages: list[dict[str, Any]]) -> dict[str, Any]:
    if not is_configured():
        logger.info("LINE upload notification skipped because LINE settings are incomplete")
        return {"sent": 0, "batches": 0, "skipped": True}

    headers = {
        "Authorization": f"Bearer {settings.line_channel_access_token}",
        "Content-Type": "application/json",
    }
    batches = _chunk_messages(messages)

    async with httpx.AsyncClient(timeout=15) as client:
        request_ids = []
        for batch in batches:
            payload = {
                "to": settings.line_group_id,
                "messages": batch,
            }
            response = await client.post(LINE_PUSH_URL, headers=headers, json=payload)
            if response.is_error:
                raise RuntimeError(f"LINE push failed: {response.status_code} {response.text}")
            request_ids.append(response.headers.get("x-line-request-id"))

    return {
        "sent": len(messages),
        "batches": len(batches),
        "request_ids": request_ids,
        "skipped": False,
    }


async def push_text(message: str) -> None:
    await push_messages([{"type": "text", "text": message[:5000]}])


async def validate_push_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not is_configured():
        return []

    headers = {
        "Authorization": f"Bearer {settings.line_channel_access_token}",
        "Content-Type": "application/json",
    }
    errors = []

    async with httpx.AsyncClient(timeout=15) as client:
        for batch_number, batch in enumerate(_chunk_messages(messages), start=1):
            response = await client.post(
                LINE_VALIDATE_PUSH_URL,
                headers=headers,
                json={"messages": batch},
            )
            if response.is_error:
                try:
                    line_error = response.json()
                except ValueError:
                    line_error = {"message": response.text}
                errors.append({
                    "batch": batch_number,
                    "types": [message.get("type") for message in batch],
                    "line_error": line_error,
                })

    return errors


def _sample_action_messages() -> dict[str, Any]:
    return {
        "type": "text",
        "text": "LINE quick reply / action objects 測試",
        "quickReply": {
            "items": [
                {"type": "action", "action": {"type": "postback", "label": "Postback", "data": "action=postback-demo"}},
                {"type": "action", "action": {"type": "message", "label": "Message", "text": "Message action demo"}},
                {"type": "action", "action": {"type": "uri", "label": "URI", "uri": "https://developers.line.biz/"}},
                {"type": "action", "action": {"type": "datetimepicker", "label": "Date", "data": "action=date-demo", "mode": "date"}},
                {"type": "action", "action": {"type": "camera", "label": "Camera"}},
                {"type": "action", "action": {"type": "cameraRoll", "label": "Album"}},
                {"type": "action", "action": {"type": "location", "label": "Location"}},
                {"type": "action", "action": {"type": "clipboard", "label": "Clipboard", "clipboardText": "DICOM-PORTAL"}},
            ],
        },
    }


def _sample_template_messages() -> list[dict[str, Any]]:
    return [
        {
            "type": "template",
            "altText": "LINE buttons template 測試",
            "template": {
                "type": "buttons",
                "thumbnailImageUrl": LINE_SAMPLE_IMAGE_URL,
                "imageAspectRatio": "rectangle",
                "imageSize": "cover",
                "title": "Buttons",
                "text": "Buttons template 測試",
                "actions": [
                    {"type": "postback", "label": "Postback", "data": "template=buttons&action=postback"},
                    {"type": "message", "label": "Message", "text": "Buttons template message"},
                    {"type": "uri", "label": "Open Docs", "uri": "https://developers.line.biz/"},
                ],
            },
        },
        {
            "type": "template",
            "altText": "LINE confirm template 測試",
            "template": {
                "type": "confirm",
                "text": "Confirm template 測試",
                "actions": [
                    {"type": "message", "label": "Yes", "text": "Confirm yes"},
                    {"type": "message", "label": "No", "text": "Confirm no"},
                ],
            },
        },
        {
            "type": "template",
            "altText": "LINE carousel template 測試",
            "template": {
                "type": "carousel",
                "columns": [
                    {
                        "thumbnailImageUrl": LINE_SAMPLE_IMAGE_URL,
                        "title": "Carousel A",
                        "text": "第一張 carousel",
                        "actions": [
                            {"type": "message", "label": "選 A", "text": "Carousel A"},
                            {"type": "uri", "label": "Docs", "uri": "https://developers.line.biz/"},
                        ],
                    },
                    {
                        "thumbnailImageUrl": LINE_SAMPLE_IMAGE_URL,
                        "title": "Carousel B",
                        "text": "第二張 carousel",
                        "actions": [
                            {"type": "message", "label": "選 B", "text": "Carousel B"},
                            {"type": "uri", "label": "Portal", "uri": "https://example.com/"},
                        ],
                    },
                ],
            },
        },
        {
            "type": "template",
            "altText": "LINE image carousel template 測試",
            "template": {
                "type": "image_carousel",
                "columns": [
                    {
                        "imageUrl": LINE_SAMPLE_IMAGE_URL,
                        "action": {"type": "message", "label": "Image A", "text": "Image carousel A"},
                    },
                    {
                        "imageUrl": LINE_SAMPLE_IMAGE_URL,
                        "action": {"type": "uri", "label": "Image B", "uri": "https://developers.line.biz/"},
                    },
                ],
            },
        },
    ]


def _sample_flex_messages() -> list[dict[str, Any]]:
    bubble = {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": "DICOM Portal",
                    "weight": "bold",
                    "size": "lg",
                    "color": "#115E59",
                },
                {
                    "type": "text",
                    "text": "Flex bubble 測試",
                    "margin": "md",
                    "wrap": True,
                },
            ],
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "action": {"type": "uri", "label": "LINE Docs", "uri": "https://developers.line.biz/"},
                },
            ],
        },
    }
    return [
        {
            "type": "flex",
            "altText": "LINE flex bubble 測試",
            "contents": bubble,
        },
        {
            "type": "flex",
            "altText": "LINE flex carousel 測試",
            "contents": {
                "type": "carousel",
                "contents": [
                    bubble,
                    {
                        "type": "bubble",
                        "body": {
                            "type": "box",
                            "layout": "vertical",
                            "contents": [
                                {"type": "text", "text": "Carousel Flex", "weight": "bold", "size": "lg"},
                                {"type": "text", "text": "第二張 Flex bubble", "margin": "md", "wrap": True},
                            ],
                        },
                    },
                ],
            },
        },
    ]


def build_message_format_samples(user: dict[str, Any]) -> list[dict[str, Any]]:
    username = user.get("username", "-")
    messages = [
        {
            "type": "text",
            "text": f"LINE text 測試\n送出者：{username}",
        },
        {
            "type": "text",
            "text": "$ LINE $",
            "emojis": [
                {"index": 0, "productId": LINE_EMOJI_PRODUCT_ID, "emojiId": "001"},
                {"index": 7, "productId": LINE_EMOJI_PRODUCT_ID, "emojiId": "002"},
            ],
        },
        {
            "type": "textV2",
            "text": "{everyone} LINE textV2 測試 {sparkles}",
            "substitution": {
                "everyone": {"type": "mention", "mentionee": {"type": "all"}},
                "sparkles": {
                    "type": "emoji",
                    "productId": LINE_TEXT_V2_EMOJI_PRODUCT_ID,
                    "emojiId": "002",
                },
            },
        },
        _sample_action_messages(),
        {
            "type": "sticker",
            "packageId": "446",
            "stickerId": "1988",
        },
        {
            "type": "image",
            "originalContentUrl": LINE_SAMPLE_IMAGE_URL,
            "previewImageUrl": LINE_SAMPLE_PREVIEW_URL,
        },
        {
            "type": "video",
            "originalContentUrl": LINE_SAMPLE_VIDEO_URL,
            "previewImageUrl": LINE_SAMPLE_PREVIEW_URL,
        },
        {
            "type": "audio",
            "originalContentUrl": LINE_SAMPLE_AUDIO_URL,
            "duration": 60000,
        },
        {
            "type": "location",
            "title": "DICOM Portal",
            "address": "Taipei, Taiwan",
            "latitude": 25.0330,
            "longitude": 121.5654,
        },
        {
            "type": "imagemap",
            "baseUrl": LINE_SAMPLE_IMAGEMAP_URL,
            "altText": "LINE imagemap 測試",
            "baseSize": {"width": 1040, "height": 1040},
            "actions": [
                {
                    "type": "uri",
                    "label": "Open portal",
                    "linkUri": "https://example.com/",
                    "area": {"x": 0, "y": 0, "width": 520, "height": 1040},
                },
                {
                    "type": "message",
                    "label": "Reply test",
                    "text": "Imagemap test",
                    "area": {"x": 520, "y": 0, "width": 520, "height": 1040},
                },
            ],
        },
    ]

    if settings.line_coupon_id:
        messages.append({
            "type": "coupon",
            "couponId": settings.line_coupon_id,
            "deliveryTag": "dicom_portal",
        })
    else:
        messages.append({
            "type": "text",
            "text": "Coupon message 需要先建立 LINE couponId。若要送 coupon 物件，請設定 LINE_COUPON_ID。",
        })

    messages.extend(_sample_template_messages())
    messages.extend(_sample_flex_messages())
    return messages


async def notify_message_format_samples(user: dict[str, Any]) -> dict[str, Any]:
    messages = build_message_format_samples(user)
    validation_errors = await validate_push_messages(messages)
    if validation_errors:
        return {
            "sent": 0,
            "batches": len(_chunk_messages(messages)),
            "skipped": False,
            "validation_errors": validation_errors,
        }
    return await push_messages(messages)


async def notify_upload(studies: list[dict[str, Any]], user: dict[str, Any]) -> None:
    try:
        await push_text(build_upload_message(studies, user))
    except Exception:
        logger.exception("LINE upload notification failed")
