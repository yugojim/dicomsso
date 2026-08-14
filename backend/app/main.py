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
    skipped_notifications = 0
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

            is_new_study = True
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
                is_new_study = False

            results.append({
                "filename": f.filename,
                "status": uploaded.get("Status"),
                # 影像清單只有在這裡是 "new" 時才會多一列；重複上傳同一個 study 會是 "existing"。
                "record": "new" if is_new_study else "existing",
                "orthanc_instance_id": uploaded.get("ID"),
                "orthanc_study_id": row.orthanc_study_id if row else None,
                "study_instance_uid": tags.get("StudyInstanceUID"),
            })
            # 只有真正新增的檢查才通知 LINE。
            # 重複上傳同一個 Study（或同一個檢查的其他 instance）不再重複推播。
            if is_new_study:
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
            else:
                skipped_notifications += 1

    if notification_studies:
        logger.info("LINE notification queued for %d new study(ies)", len(notification_studies))
        background_tasks.add_task(line_bot.notify_upload, notification_studies, user)
    elif skipped_notifications:
        logger.info("LINE notification skipped: %d duplicate study upload(s)", skipped_notifications)

    new_studies = {r["orthanc_study_id"] for r in results if r["record"] == "new" and r["orthanc_study_id"]}
    existing_studies = {
        r["orthanc_study_id"] for r in results
        if r["record"] == "existing" and r["orthanc_study_id"] and r["orthanc_study_id"] not in new_studies
    }
    return {
        "uploaded": results,
        "summary": {
            "files": len(results),
            "new_studies": len(new_studies),
            "existing_studies": len(existing_studies),
            "message": (
                f"新增 {len(new_studies)} 筆影像"
                + (f"；另有 {len(existing_studies)} 筆為系統中已存在的檢查，影像清單不會重複列出"
                   if existing_studies else "")
            ) if new_studies else (
                "這些影像在系統中都已存在（同一個 Study 只會列出一次），因此影像清單沒有變動"
                if existing_studies else "沒有匯入任何 DICOM 影像"
            ),
        },
    }

def _dicom_date_time(date: str | None, time: str | None) -> str | None:
    """DICOM 的 YYYYMMDD / HHMMSS 轉成 FHIR dateTime。"""
    if not date or len(date) < 8:
        return None
    stamp = f"{date[0:4]}-{date[4:6]}-{date[6:8]}"
    if time and len(time) >= 6:
        stamp += f"T{time[0:2]}:{time[2:4]}:{time[4:6]}+08:00"
    return stamp


def _visible_studies(db: Session, user: dict[str, Any]) -> list[DicomStudy]:
    query = select(DicomStudy).order_by(desc(DicomStudy.created_at))
    # 影像歸戶是跨租戶的作業（放射科要幫全院影像建 FHIR 紀錄），
    # 所以 admin 與 fhir-admin 看得到全部，其他人只看自己的租戶。
    if not ({"admin", "fhir-admin"} & user["roles"]):
        query = query.where(DicomStudy.tenant_id == user["tenant_id"])
    return list(db.scalars(query).all())


@app.get("/api/imaging/dicom-studies")
async def list_dicom_studies_for_fhir(
    db: Session = Depends(get_db),
    user=Depends(require_role("fhir-user", "fhir-admin")),
):
    """給電子病歷交換平台用的 DICOM 檢查清單（Orthanc + 入口資料庫）。

    只回組 FHIR ImagingStudy 需要的欄位；series / instance 明細另外用單筆 API 取。
    """
    rows = _visible_studies(db, user)
    studies = []
    for row in rows:
        detail: dict[str, Any] = {}
        try:
            detail = await orthanc.study(row.orthanc_study_id)
        except Exception as exc:  # Orthanc 內已被刪掉的檢查不要讓整張清單掛掉
            logger.warning("Orthanc study %s lookup failed: %s", row.orthanc_study_id, exc)

        tags = detail.get("MainDicomTags", {})
        patient_tags = detail.get("PatientMainDicomTags", {})
        studies.append({
            "orthanc_study_id": row.orthanc_study_id,
            "study_instance_uid": row.study_instance_uid or tags.get("StudyInstanceUID"),
            "accession_number": tags.get("AccessionNumber") or None,
            "study_description": tags.get("StudyDescription") or row.description,
            "study_date": tags.get("StudyDate") or row.study_date,
            "study_time": tags.get("StudyTime"),
            "started": _dicom_date_time(tags.get("StudyDate") or row.study_date, tags.get("StudyTime")),
            "institution_name": (tags.get("InstitutionName") or "").strip(" .") or None,
            "referring_physician": tags.get("ReferringPhysicianName") or None,
            "dicom_patient": {
                "id": patient_tags.get("PatientID") or row.patient_id,
                "name": patient_tags.get("PatientName") or row.patient_name,
                "birth_date": patient_tags.get("PatientBirthDate"),
                "sex": patient_tags.get("PatientSex"),
            },
            "modality": row.modality,
            "number_of_series": len(detail.get("Series", [])) or None,
            "uploaded_by": row.uploaded_by,
            "tenant_id": row.tenant_id,
            "uploaded_at": row.created_at.isoformat(),
            "in_orthanc": bool(detail),
            "ohif_url": ohif_url(row.study_instance_uid),
        })
    return {"studies": studies}


@app.get("/api/imaging/dicom-studies/{orthanc_study_id}")
async def dicom_study_detail_for_fhir(
    orthanc_study_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_role("fhir-user", "fhir-admin")),
):
    """單一檢查的完整 series / instance 明細，直接對應 FHIR ImagingStudy.series。"""
    row = next((r for r in _visible_studies(db, user) if r.orthanc_study_id == orthanc_study_id), None)
    if not row:
        raise HTTPException(status_code=404, detail="Study not found")

    try:
        detail = await orthanc.study(orthanc_study_id)
        instances = await orthanc.study_instances(orthanc_study_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Orthanc lookup failed: {exc}")

    # instance 的 MainDicomTags 沒有 SeriesInstanceUID，只有 ParentSeries（Orthanc 內部 id），
    # 所以用 ParentSeries 當 key，下面走訪 detail["Series"] 時剛好也是同一組 id。
    series_map: dict[str, list[dict[str, Any]]] = {}
    for inst in instances:
        tags = inst.get("MainDicomTags", {})
        number = tags.get("InstanceNumber")
        series_map.setdefault(inst.get("ParentSeries", ""), []).append({
            "uid": tags.get("SOPInstanceUID"),
            "number": int(number) if str(number).isdigit() else None,
            "frames": tags.get("NumberOfFrames"),
            "orthanc_id": inst.get("ID"),
        })

    series = []
    for series_id in detail.get("Series", []):
        try:
            info = await orthanc.series(series_id)
        except Exception as exc:
            logger.warning("Orthanc series %s lookup failed: %s", series_id, exc)
            continue
        tags = info.get("MainDicomTags", {})
        series_instances = sorted(series_map.get(series_id, []), key=lambda i: (i["number"] is None, i["number"] or 0))
        series.append({
            "uid": tags.get("SeriesInstanceUID", ""),
            "number": int(tags["SeriesNumber"]) if str(tags.get("SeriesNumber", "")).isdigit() else None,
            "modality": tags.get("Modality"),
            "description": tags.get("SeriesDescription") or None,
            "body_part": tags.get("BodyPartExamined") or None,
            "manufacturer": tags.get("Manufacturer") or None,
            "instances": series_instances,
            "number_of_instances": len(series_instances),
        })

    study_tags = detail.get("MainDicomTags", {})
    patient_tags = detail.get("PatientMainDicomTags", {})
    return {
        "orthanc_study_id": orthanc_study_id,
        "study_instance_uid": study_tags.get("StudyInstanceUID") or row.study_instance_uid,
        "accession_number": study_tags.get("AccessionNumber") or None,
        "study_description": study_tags.get("StudyDescription") or row.description,
        "started": _dicom_date_time(study_tags.get("StudyDate"), study_tags.get("StudyTime")),
        "institution_name": (study_tags.get("InstitutionName") or "").strip(" .") or None,
        "dicom_patient": {
            "id": patient_tags.get("PatientID"),
            "name": patient_tags.get("PatientName"),
            "birth_date": patient_tags.get("PatientBirthDate"),
            "sex": patient_tags.get("PatientSex"),
        },
        "modalities": sorted({s["modality"] for s in series if s.get("modality")}),
        "number_of_series": len(series),
        "number_of_instances": sum(s["number_of_instances"] for s in series),
        "series": series,
        "dicomweb_endpoint": settings.dicomweb_public_url,
        "uploaded_by": row.uploaded_by,
        "tenant_id": row.tenant_id,
    }


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
