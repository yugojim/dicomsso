# Install Notes

## Environment

- Project path: `/Users/yugojim/Downloads/dicom-customer-portal`
- Current LAN IP used during acceptance: `192.168.1.105`
- Main portal URL: `http://192.168.1.105:8088`
- Keycloak URL: `http://192.168.1.105:8080`
- Orthanc admin proxy: `http://192.168.1.105:8042`
- OHIF viewer: `http://192.168.1.105:3000`
- Wazuh Dashboard proxy: `http://192.168.1.105:5601`

## Main Services

The base stack is started from `docker-compose.yml`:

- `postgres`
- `orthanc`
- `keycloak`
- `backend`
- `ohif`
- `frontend`

Start the main DICOM Portal stack:

```bash
docker compose up -d
```

Rebuild only the backend after backend code or environment changes:

```bash
docker compose up -d --build backend
```

Check running services:

```bash
docker compose ps
```

Follow backend logs:

```bash
docker compose logs -f backend
```

## Optional Wazuh Services

Wazuh is defined separately in `docker-compose.wazuh.yml` and should be treated as optional monitoring.

Start Wazuh with the base stack network:

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up -d wazuh-indexer wazuh-manager wazuh-dashboard
```

Stop only Wazuh:

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml stop wazuh-dashboard wazuh-manager wazuh-indexer
```

Restart Wazuh Dashboard only:

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart wazuh-dashboard
```

## Login Flow

The browser app redirects to Keycloak using the current host. For LAN testing, use one host consistently:

```text
http://192.168.1.105:8088
```

Avoid mixing these in the same browser session:

```text
http://localhost:8088
http://192.168.1.105:8088
```

Browsers store cookies/localStorage separately for `localhost` and `192.168.1.105`.

## Important Current Configuration

The backend must accept Keycloak token issuers for both localhost and the LAN IP.

Configured in `docker-compose.yml` and `backend/app/config.py`:

```text
http://localhost:8080/realms/dicom
http://192.168.1.112:8080/realms/dicom
http://192.168.1.105:8080/realms/dicom
```

The Wazuh Manager API local rate limit was raised for dashboard health checks:

```yaml
access:
  max_login_attempts: 1000
  block_time: 60
  max_request_per_minute: 6000
```

See `wazuh/config/wazuh_manager/api.yaml`.

