from typing import Any
from base64 import b64encode
import logging
from urllib.parse import quote
from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import select, desc
from sqlalchemy.exc import IntegrityError
from .config import settings
from .db import Base, engine, get_db
from .models import DicomStudy
from .auth import get_current_user, require_role
from .orthanc_client import orthanc
from . import line_bot

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="DICOM Customer Portal API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin, "http://localhost", "http://localhost:8088"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ohif_url(study_instance_uid: str | None) -> str | None:
    if not study_instance_uid:
        return None
    return f"{settings.ohif_viewer_url.rstrip('/')}/{quote(study_instance_uid, safe='')}"


@app.get("/api/health")
async def health():
    return {"status": "ok"}

@app.get("/api/me")
async def me(user=Depends(get_current_user)):
    return {
        "username": user["username"],
        "email": user["email"],
        "tenant_id": user["tenant_id"],
        "roles": sorted(list(user["roles"])),
    }

@app.get("/api/orthanc/system")
async def orthanc_system(user=Depends(require_role("viewer", "uploader"))):
    return await orthanc.system()


@app.get("/api/auth/viewer")
async def authorize_viewer(user=Depends(require_role("viewer"))):
    return {"ok": True, "username": user["username"], "tenant_id": user["tenant_id"]}


@app.get("/api/auth/orthanc-admin")
async def authorize_orthanc_admin(user=Depends(require_role("admin"))):
    return {"ok": True, "username": user["username"], "tenant_id": user["tenant_id"]}


FHIR_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@app.get("/api/auth/fhir")
async def authorize_fhir(
    x_original_method: str | None = Header(default=None),
    user=Depends(require_role("fhir-user", "fhir-admin")),
):
    """nginx auth_request 閘道：HAPI FHIR 前的 Keycloak 授權檢查。

    讀取需要 fhir-user；寫入需要 fhir-admin（require_role 已讓 admin 通吃）。
    """
    method = (x_original_method or "GET").upper()
    if method in FHIR_WRITE_METHODS and not ({"admin", "fhir-admin"} & user["roles"]):
        raise HTTPException(status_code=403, detail="FHIR write requires the fhir-admin role")
    return {"ok": True, "username": user["username"], "tenant_id": user["tenant_id"]}


@app.get("/api/auth/fhir-ui")
async def authorize_fhir_ui(user=Depends(require_role("fhir-admin"))):
    """HAPI 內建測試頁的授權檢查。

    測試頁是 server-side 呼叫 HAPI 自己的 8080，繞得過 nginx 的讀寫檢查，
    等於在 UI 上可以任意寫入。因此測試頁只開放給本來就有寫入權的 fhir-admin。
    只有 fhir-user 的帳號請直接用 /fhir REST API。
    """
    return {"ok": True, "username": user["username"], "tenant_id": user["tenant_id"]}


@app.get("/api/auth/wazuh")
async def authorize_wazuh(response: Response, user=Depends(require_role("wazuh-admin", "wazuh-readonly"))):
    wazuh_user = "admin" if "admin" in user["roles"] or "wazuh-admin" in user["roles"] else "kibanaro"
    credentials = b64encode(f"{wazuh_user}:SecretPassword".encode()).decode()
    response.headers["X-Wazuh-Authorization"] = f"Basic {credentials}"
    return {"ok": True, "username": user["username"], "tenant_id": user["tenant_id"]}


@app.post("/api/line/webhook")
async def line_webhook(request: Request, x_line_signature: str | None = Header(default=None)):
    body = await request.body()
    if not line_bot.verify_signature(body, x_line_signature):
        raise HTTPException(status_code=401, detail="Invalid LINE signature")

    payload = await request.json()
    for event in payload.get("events", []):
        source = event.get("source", {})
        source_type = source.get("type")
        group_id = source.get("groupId")
        room_id = source.get("roomId")
        user_id = source.get("userId")
        logger.warning(
            "LINE webhook event source: type=%s groupId=%s roomId=%s userId=%s",
            source_type,
            group_id,
            room_id,
            user_id,
        )
    return {"ok": True, "events": len(payload.get("events", []))}


@app.post("/api/line/send-message-format-samples")
async def send_line_message_format_samples(user=Depends(require_role("admin"))):
    try:
        result = await line_bot.notify_message_format_samples(user)
    except Exception as exc:
        logger.exception("LINE message format sample push failed")
        raise HTTPException(status_code=502, detail=f"LINE push failed: {exc}")
    ok = not result.get("skipped") and not result.get("validation_errors")
    return {
        "ok": ok,
        "message": "LINE 訊息格式測試已送出" if ok else "LINE 訊息格式驗證失敗或設定不完整，未送出",
        **result,
    }


def normalize_upload_results(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        results = []
        for item in payload:
            if isinstance(item, str):
                results.append({"ID": item})
            else:
                results.extend(normalize_upload_results(item))
        return results

    if not isinstance(payload, dict):
        return []

    if payload.get("ID"):
        return [payload]

    results = []
    for value in payload.values():
        if isinstance(value, (dict, list)):
            results.extend(normalize_upload_results(value))
    return results


async def build_study_row(uploaded: dict[str, Any], user: dict[str, Any]) -> tuple[DicomStudy, dict[str, Any]]:
    instance_id = uploaded.get("ID")
    if not instance_id:
        raise ValueError("Orthanc response did not include an instance ID")

    instance = await orthanc.instance(instance_id)
    tags = await orthanc.simplified_tags(instance_id)
    study_id = uploaded.get("ParentStudy") or instance.get("ParentStudy")

    if not study_id:
        raise ValueError(f"Orthanc instance {instance_id} did not include a parent study")

    return DicomStudy(
        tenant_id=user["tenant_id"],
        uploaded_by=user["username"],
        orthanc_patient_id=uploaded.get("ParentPatient") or instance.get("ParentPatient"),
        orthanc_study_id=study_id,
        orthanc_series_id=uploaded.get("ParentSeries") or instance.get("ParentSeries"),
        orthanc_instance_id=instance_id,
        study_instance_uid=tags.get("StudyInstanceUID"),
        patient_id=tags.get("PatientID"),
        patient_name=str(tags.get("PatientName", "")),
        study_date=tags.get("StudyDate"),
        modality=tags.get("Modality"),
        description=tags.get("StudyDescription") or tags.get("SeriesDescription"),
    ), tags


@app.post("/api/upload")
async def upload_dicom(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user=Depends(require_role("uploader")),
):
    results = []
    notification_studies = []
    for f in files:
        content = await f.read()
        if not content:
            continue

        try:
            orthanc_response = await orthanc.upload_instance(content)
            uploaded_instances = normalize_upload_results(orthanc_response)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Orthanc upload failed for {f.filename}: {exc}")

        if not uploaded_instances:
            raise HTTPException(status_code=502, detail=f"Orthanc did not report imported DICOM instances for {f.filename}")

        for uploaded in uploaded_instances:
            try:
                row, tags = await build_study_row(uploaded, user)
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"Orthanc metadata lookup failed for {f.filename}: {exc}")

            try:
                db.add(row)
                db.commit()
                db.refresh(row)
            except IntegrityError:
                db.rollback()
                # Same study may contain many instances. Keep upload successful, but avoid duplicate study rows.
                existing = db.scalar(
                    select(DicomStudy).where(
                        DicomStudy.tenant_id == user["tenant_id"],
                        DicomStudy.orthanc_study_id == row.orthanc_study_id,
                    )
                )
                row = existing

            results.append({
                "filename": f.filename,
                "status": uploaded.get("Status"),
                "orthanc_instance_id": uploaded.get("ID"),
                "orthanc_study_id": row.orthanc_study_id if row else None,
                "study_instance_uid": tags.get("StudyInstanceUID"),
            })
            notification_studies.append({
                "filename": f.filename,
                "orthanc_study_id": row.orthanc_study_id if row else None,
                "study_instance_uid": tags.get("StudyInstanceUID"),
                "patient_id": row.patient_id if row else tags.get("PatientID"),
                "patient_name": row.patient_name if row else str(tags.get("PatientName", "")),
                "study_date": row.study_date if row else tags.get("StudyDate"),
                "modality": row.modality if row else tags.get("Modality"),
                "description": row.description if row else tags.get("StudyDescription") or tags.get("SeriesDescription"),
            })
    if notification_studies:
        background_tasks.add_task(line_bot.notify_upload, notification_studies, user)
    return {"uploaded": results}

@app.get("/api/studies")
async def list_studies(db: Session = Depends(get_db), user=Depends(require_role("viewer", "uploader"))):
    query = select(DicomStudy).order_by(desc(DicomStudy.created_at))
    if "admin" not in user["roles"]:
        query = query.where(DicomStudy.tenant_id == user["tenant_id"])

    rows = db.scalars(query).all()
    return [
        {
            "id": r.id,
            "patient_id": r.patient_id,
            "patient_name": r.patient_name,
            "study_date": r.study_date,
            "modality": r.modality,
            "description": r.description,
            "orthanc_study_id": r.orthanc_study_id,
            "study_instance_uid": r.study_instance_uid,
            "uploaded_by": r.uploaded_by,
            "created_at": r.created_at.isoformat(),
            "ohif_url": ohif_url(r.study_instance_uid),
        }
        for r in rows
    ]

@app.get("/api/studies/{study_id}")
async def get_study(study_id: int, db: Session = Depends(get_db), user=Depends(require_role("viewer", "uploader"))):
    row = db.get(DicomStudy, study_id)
    if not row or row.tenant_id != user["tenant_id"]:
        raise HTTPException(status_code=404, detail="Study not found")
    orthanc_study = await orthanc.study(row.orthanc_study_id)
    return {"portal_record": {
        "id": row.id,
        "study_instance_uid": row.study_instance_uid,
        "patient_id": row.patient_id,
        "patient_name": row.patient_name,
        "tenant_id": row.tenant_id,
    }, "orthanc_study": orthanc_study}
