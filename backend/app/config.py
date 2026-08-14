from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://dicom:dicom@postgres:5432/dicom_portal"

    orthanc_url: str = "http://orthanc:8042"
    orthanc_username: str = "orthanc"
    orthanc_password: str = "orthanc"

    keycloak_issuer: str = "http://localhost:8080/realms/dicom"
    keycloak_allowed_issuers: str = "http://localhost:8080/realms/dicom,http://192.168.1.112:8080/realms/dicom,http://192.168.1.105:8080/realms/dicom"
    keycloak_jwks_url: str = "http://keycloak:8080/realms/dicom/protocol/openid-connect/certs"
    keycloak_audience: str = "dicom-portal-api"
    keycloak_client_id: str = "dicom-portal"

    tenant_claim: str = "tenant_id"
    cors_origin: str = "http://localhost:8088"
    ohif_viewer_url: str = "http://localhost:3000/viewer"
    # 寫進 FHIR Endpoint.address 的 DICOMweb 位址（影像歸戶時用）
    dicomweb_public_url: str = "http://localhost:8088/dicom-web"

    line_channel_access_token: str = ""
    line_channel_secret: str = ""
    line_group_id: str = ""
    line_coupon_id: str = ""

settings = Settings()
