# Test Data

## Accounts

The following account was used during acceptance checks:

```text
username: portal-admin
password: portal-admin
roles: admin, uploader, viewer, wazuh-admin
```

Expected `/api/me` response:

```json
{
  "username": "portal-admin",
  "email": "portal-admin@example.local",
  "tenant_id": "admin",
  "roles": ["admin", "uploader", "viewer", "wazuh-admin"]
}
```

## DICOM Files

Use small de-identified DICOM files for upload tests.

Accepted extensions:

```text
.dcm
.dicom
.zip
```

Expected upload behavior:

- File is uploaded through the portal.
- Backend imports the object into Orthanc.
- Backend records tenant ownership in PostgreSQL.
- Study appears in the portal study list.
- OHIF opens the study from the study list.

## LINE Bot Test Events

To obtain a LINE group ID:

1. Add the bot to a LINE group.
2. Send a message in the group.
3. Watch backend logs:

```bash
docker compose logs -f backend
```

Expected log:

```text
LINE webhook event source: type=group groupId=Cxxxxxxxx roomId=None userId=Uxxxxxxxx
```

If testing with a one-to-one chat, expected source type is:

```text
type=user groupId=None
```

That cannot be used as `LINE_GROUP_ID`.

## Wazuh Agent State

During acceptance, Wazuh showed only local/expected agent state unless a host agent was manually installed.

Command:

```bash
docker exec dicom-customer-portal-wazuh-manager-1 /var/ossec/bin/agent_control -l
```

Expected local manager-only result:

```text
ID: 000, Name: wazuh.manager (server), IP: 127.0.0.1, Active/Local
```

