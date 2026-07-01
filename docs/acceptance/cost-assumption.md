# Cost Assumptions

## Local Demo / Acceptance

The current environment is a local Docker Compose deployment on a Mac Studio.

Expected direct infrastructure cost:

```text
0 cloud compute cost
0 managed database cost
0 managed identity provider cost
```

Local costs are limited to workstation resources:

- CPU usage
- Memory usage
- Disk storage for Docker volumes
- Network usage

## Optional External Services

LINE Bot requires a LINE Messaging API channel. Cost depends on the LINE plan and message volume.

Public webhook testing may require one of:

- ngrok
- Cloudflare Tunnel
- Public domain and reverse proxy
- Public cloud VM

Any paid plan, DNS, certificate, or cloud hosting cost is outside the current local Docker scope.

## Wazuh Cost Assumption

Wazuh runs locally through Docker Compose. No hosted Wazuh or cloud OpenSearch service is currently assumed.

Operational cost is local resource consumption:

- Wazuh Indexer disk usage
- Dashboard memory usage
- Manager scanning/indexing load

For production, Wazuh may require separate sizing and may be better deployed independently from the DICOM Portal.

## Production Cost Items To Estimate Later

- Public domain
- TLS certificate management
- Reverse proxy or load balancer
- Persistent database hosting
- Object/file storage for DICOM data
- Backup storage
- Monitoring and alerting
- Wazuh host sizing or managed SIEM alternative
- LINE Messaging API message quota

