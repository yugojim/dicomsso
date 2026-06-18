from datetime import datetime
from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base

class DicomStudy(Base):
    __tablename__ = "dicom_studies"
    __table_args__ = (
        UniqueConstraint("tenant_id", "orthanc_study_id", name="uq_tenant_study"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    tenant_id: Mapped[str] = mapped_column(String(128), index=True)
    uploaded_by: Mapped[str] = mapped_column(String(256), index=True)

    orthanc_patient_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    orthanc_study_id: Mapped[str] = mapped_column(String(128), index=True)
    orthanc_series_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    orthanc_instance_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    study_instance_uid: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    patient_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    patient_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    study_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    modality: Mapped[str | None] = mapped_column(String(64), nullable=True)
    description: Mapped[str | None] = mapped_column(String(512), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
