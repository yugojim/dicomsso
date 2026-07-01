# Referenced Files

## Compose Files

- `docker-compose.yml`
  - Base DICOM Portal services
  - Backend environment variables
  - LINE Bot environment variables
  - Frontend port mappings

- `docker-compose.wazuh.yml`
  - Optional Wazuh services
  - Wazuh Manager API configuration mount
  - Wazuh Dashboard configuration mount

## Backend

- `backend/app/main.py`
  - `/api/me`
  - `/api/upload`
  - `/api/auth/wazuh`
  - `/api/line/webhook`

- `backend/app/auth.py`
  - JWT validation
  - Keycloak issuer allowlist
  - Role extraction and authorization helpers

- `backend/app/config.py`
  - Runtime settings
  - Keycloak issuer settings
  - LINE Bot settings

- `backend/app/line_bot.py`
  - LINE signature verification
  - LINE push message generation
  - Upload notification sender

## Frontend And Proxy

- `frontend/index.html`
  - Main portal layout
  - Admin links

- `frontend/app.js`
  - Keycloak login flow
  - Token storage
  - API calls
  - Dynamic URLs based on current host

- `nginx/default.conf`
  - Portal static hosting
  - API reverse proxy
  - Wazuh proxy and authorization
  - Orthanc admin proxy
  - DICOMweb proxy

## Keycloak

- `keycloak/realm-dicom.json`
  - Realm import
  - Client settings
  - Roles/users used for local testing

## Wazuh

- `wazuh/config/wazuh_dashboard/wazuh.yml`
  - Wazuh Dashboard API host configuration

- `wazuh/config/wazuh_dashboard/opensearch_dashboards.yml`
  - Wazuh Dashboard/OpenSearch Dashboard configuration

- `wazuh/config/wazuh_manager/api.yaml`
  - Local Wazuh Manager API rate limit override

- `wazuh/config/certs.yml`
  - Certificate generation input for Wazuh services

## Orthanc And OHIF

- `orthanc/orthanc.json`
  - Orthanc configuration

- `ohif/app-config.js`
  - OHIF viewer configuration

- `ohif/index.html`
  - OHIF static entry point override

## Documentation

- `README.md`
  - Existing project setup notes
  - LINE Bot setup notes

