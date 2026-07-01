# Troubleshooting

## Keycloak: Invalid Redirect URI

Symptom:

```text
Invalid parameter: redirect_uri
```

Cause:

Keycloak client does not allow the current host/IP redirect URI.

Fix:

Add the active host to Keycloak client redirect URIs and web origins. For LAN testing, include:

```text
http://192.168.1.105:8088/*
```

## Backend: Invalid Token Issuer

Symptom:

```text
/api/me failed: 401 {"detail":"Invalid token issuer: http://192.168.1.105:8080/realms/dicom"}
```

Cause:

Keycloak issued a token with the LAN IP issuer, but backend allowed issuers did not include that issuer.

Fix:

Add the issuer in `docker-compose.yml` and `backend/app/config.py`:

```text
http://192.168.1.105:8080/realms/dicom
```

Rebuild backend:

```bash
docker compose up -d --build backend
```

Verification:

```text
token=200
api-me=200
```

## Wazuh: 429 Rate Limit

Symptom:

```text
POST /api/check-stored-api 429
Error 3002 - Request failed with status code 429
```

Cause:

Wazuh Dashboard generated too many API requests for the default Wazuh Manager API limit.

Fix:

Mount `wazuh/config/wazuh_manager/api.yaml` into:

```text
/var/ossec/api/configuration/api.yaml
```

Set:

```yaml
access:
  max_login_attempts: 1000
  block_time: 60
  max_request_per_minute: 6000
```

Recreate Wazuh manager and dashboard:

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up -d --force-recreate wazuh-manager wazuh-dashboard
```

If dashboard starts before manager is ready, restart dashboard:

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart wazuh-dashboard
```

## Wazuh: localhost Works But IP Fails

Cause:

Browser treats these as different sites:

```text
http://localhost:5601
http://192.168.1.105:5601
```

They have separate cookies, localStorage, Wazuh tokens, and cached session state.

Fix:

- Use one host consistently.
- Clear site data for `192.168.1.105`.
- Start from `http://192.168.1.105:8088`.

Nginx was also adjusted to avoid hardcoded `localhost` redirects for Wazuh and Orthanc.

## Docker Networking Error

Symptom:

```text
failed to set up container networking: network ... not found
```

Cause:

Docker internal network state is stale, often after interrupted compose runs or Docker Desktop state changes.

Fix:

Restart affected services or Docker Desktop. Then re-run compose.

## LINE Bot: Webhook 200 But No groupId

Symptom:

```text
POST /api/line/webhook 200 OK
```

But no visible group ID.

Causes:

- Message was sent in one-to-one chat, not group chat.
- Logger level did not display application log.
- LINE event had no group source.

Fix:

Backend logs now emit webhook source at warning level.

Run:

```bash
docker compose logs -f backend
```

Send a message in the LINE group containing the bot.

Expected:

```text
LINE webhook event source: type=group groupId=Cxxxxxxxx roomId=None userId=Uxxxxxxxx
```

## LINE Bot: Upload Notification Skipped

Symptom:

```text
LINE upload notification skipped because LINE settings are incomplete
```

Cause:

Missing one or more required settings:

```text
LINE_CHANNEL_ACCESS_TOKEN
LINE_GROUP_ID
```

Fix:

Set `.env`, then rebuild backend:

```bash
docker compose up -d --build backend
```

