# Performance Record

## Observed Startup Behavior

The base DICOM Portal stack starts faster and is suitable for normal testing:

```bash
docker compose up -d
```

Wazuh is heavier and should be started only when monitoring is needed:

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up -d wazuh-indexer wazuh-manager wazuh-dashboard
```

## Observed Wazuh Behavior

Wazuh Manager starts internal modules automatically:

- File integrity monitoring
- Rootcheck
- Security Configuration Assessment
- Syscollector
- Vulnerability scanner

These checks may appear as scanning activity, but they are Wazuh's default local manager behavior. They do not mean DICOM files are being scanned.

## Wazuh Rate Limit Issue

Observed error:

```text
Error 3002 - Request failed with status code 429
POST /api/check-stored-api 429
```

Cause:

Wazuh Dashboard health checks can issue many API requests in a short time. The default Wazuh Manager API limit is low for this local demo workflow.

Mitigation:

`wazuh/config/wazuh_manager/api.yaml` raises:

```yaml
max_request_per_minute: 6000
```

Verification command:

```bash
docker exec dicom-customer-portal-wazuh-manager-1 cat /var/ossec/api/configuration/api.yaml
```

Direct API test:

```bash
docker exec dicom-customer-portal-wazuh-dashboard-1 curl -k -s -D - -u 'wazuh-wui:MyS3cr37P450r.*-' 'https://wazuh.manager:55000/security/user/authenticate?raw=true'
```

Expected:

```text
HTTP/1.1 200 OK
```

## Resource Notes

Wazuh Indexer uses Java heap settings:

```yaml
OPENSEARCH_JAVA_OPTS: "-Xms1g -Xmx1g"
```

Wazuh may consume significant CPU, memory, and disk I/O during startup, indexing, and dashboard health checks. It should not be required for DICOM upload acceptance unless monitoring is part of the test scope.

