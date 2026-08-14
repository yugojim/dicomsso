from typing import Any
import httpx
from .config import settings

class OrthancClient:
    def __init__(self):
        self.base_url = settings.orthanc_url.rstrip("/")
        self.auth = (settings.orthanc_username, settings.orthanc_password)

    async def system(self) -> dict[str, Any]:
        async with httpx.AsyncClient(auth=self.auth, timeout=30) as client:
            r = await client.get(f"{self.base_url}/system")
            r.raise_for_status()
            return r.json()

    async def upload_instance(self, content: bytes) -> dict[str, Any] | list[dict[str, Any]]:
        async with httpx.AsyncClient(auth=self.auth, timeout=600) as client:
            r = await client.post(f"{self.base_url}/instances", content=content)
            r.raise_for_status()
            return r.json()

    async def instance(self, instance_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(auth=self.auth, timeout=30) as client:
            r = await client.get(f"{self.base_url}/instances/{instance_id}")
            r.raise_for_status()
            return r.json()

    async def simplified_tags(self, instance_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(auth=self.auth, timeout=30) as client:
            r = await client.get(f"{self.base_url}/instances/{instance_id}/simplified-tags")
            r.raise_for_status()
            return r.json()

    async def study(self, study_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(auth=self.auth, timeout=30) as client:
            r = await client.get(f"{self.base_url}/studies/{study_id}")
            r.raise_for_status()
            return r.json()

    async def study_instances(self, study_id: str) -> list[dict[str, Any]]:
        """整個 study 的 instance 清單（含 DICOM tags），用來組 FHIR ImagingStudy.series。"""
        async with httpx.AsyncClient(auth=self.auth, timeout=60) as client:
            r = await client.get(f"{self.base_url}/studies/{study_id}/instances")
            r.raise_for_status()
            return r.json()

    async def series(self, series_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(auth=self.auth, timeout=30) as client:
            r = await client.get(f"{self.base_url}/series/{series_id}")
            r.raise_for_status()
            return r.json()

orthanc = OrthancClient()
