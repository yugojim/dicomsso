# Acceptance Checklist

## Base Portal

- [ ] `docker compose ps` shows `postgres`, `orthanc`, `keycloak`, `backend`, `ohif`, and `frontend` as running.
- [ ] Open `http://192.168.1.105:8088`.
- [ ] SSO login opens Keycloak.
- [ ] User can log in with the test account.
- [ ] Account panel loads `/api/me` without `401`.
- [ ] Logout works.
- [ ] Re-login works after logout.

## DICOM Upload

- [ ] Select one `.dcm` file.
- [ ] Upload completes successfully.
- [ ] Upload result shows Orthanc instance/study information.
- [ ] Uploaded study appears in the study list.
- [ ] Study can be opened in OHIF.
- [ ] Non-admin user only sees allowed tenant data.

## Orthanc

- [ ] `http://192.168.1.105:8042` redirects unauthenticated users back to the portal.
- [ ] Admin user can access Orthanc admin view.
- [ ] Viewer/uploader without admin role cannot access Orthanc admin view.

## Keycloak

- [ ] `dicom-portal` client allows redirect URI for `192.168.1.105:8088`.
- [ ] Token issuer from LAN login is accepted by backend.
- [ ] `/api/me` returns user roles and tenant ID.

## Wazuh Optional Monitoring

- [ ] Wazuh can remain stopped without affecting portal upload/login.
- [ ] When Wazuh is started, `wazuh-indexer`, `wazuh-manager`, and `wazuh-dashboard` are running.
- [ ] `http://192.168.1.105:5601` redirects unauthenticated users to `http://192.168.1.105:8088`.
- [ ] Wazuh Dashboard loads Overview without `429`.
- [ ] Wazuh API direct authentication returns `200 OK`.
- [ ] Only expected agents are registered.

## LINE Bot

- [ ] `LINE_CHANNEL_ACCESS_TOKEN` is configured.
- [ ] `LINE_CHANNEL_SECRET` is configured.
- [ ] Webhook URL is publicly reachable through ngrok, Cloudflare Tunnel, or a public domain.
- [ ] `POST /api/line/webhook` returns `200 OK`.
- [ ] Backend log shows `LINE webhook event source`.
- [ ] Group event shows `type=group` and a non-empty `groupId`.
- [ ] `LINE_GROUP_ID` is configured.
- [ ] Successful DICOM upload sends a LINE message.

## Regression Checks

- [ ] Main portal still works when Wazuh is stopped.
- [ ] Main portal still works after backend rebuild.
- [ ] Browser test uses one host consistently: either `localhost` or `192.168.1.105`.
- [ ] Clearing site data fixes stale session issues.

