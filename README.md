# DICOM 客戶網站：帳號、上傳、清單、SSO 權限

這是一個最小可行版本（MVP）專案骨架，用於建立客戶 DICOM 上傳入口。

## 功能

- Keycloak SSO 登入
- 以 Keycloak role 控制權限
  - `viewer`：可看自己的影像清單
  - `uploader`：可上傳 DICOM
  - `admin`：保留管理者角色
  - `wazuh-admin` / `wazuh-readonly`：可進入 Wazuh
- 客戶上傳 DICOM 檔案
- 後端呼叫 Orthanc REST API 寫入 DICOM
- PostgreSQL 記錄租戶 `tenant_id` 與 Orthanc Study / Instance 對應
- 客戶只能看到自己 `tenant_id` 底下的資料
- 清單提供 OHIF URL 欄位，方便後續接 OHIF Viewer

## 架構

```text
Browser
  ↓
Frontend 靜態網頁
  ↓ Bearer token
FastAPI Backend
  ↓ 驗證 Keycloak JWT
PostgreSQL：記錄 tenant_id 與 Orthanc resource id
  ↓
Orthanc：儲存 DICOM
```

正式環境建議：不要讓客戶直接存取 Orthanc Explorer 或 Orthanc REST API。

## 啟動

```bash
docker compose up --build
```

開啟：

```text
客戶入口：http://localhost:8088
Keycloak：http://localhost:8080
Orthanc 管理入口：http://localhost:8042
OHIF：http://localhost:3000
Wazuh 入口：http://localhost:5601
Backend API：http://localhost:8000/docs
```

若從同一個 LAN 以固定 IP 存取，也可以把 `localhost` 換成伺服器 IP，例如：

```text
客戶入口：http://192.168.1.112:8088
Keycloak：http://192.168.1.112:8080
Orthanc 管理入口：http://192.168.1.112:8042
OHIF：http://192.168.1.112:3000
Wazuh 入口：http://192.168.1.112:5601
```

`http://localhost:8042` 不是直接暴露 Orthanc，而是經由 Nginx 保護的 Orthanc 管理入口。
請先到 `http://localhost:8088` 用具備 `admin` role 的 Keycloak 帳號登入，再開啟 Orthanc 管理入口。
未登入或非 admin 使用者會被導回客戶入口。

`http://localhost:5601` 是經由 Nginx 保護的 Wazuh Dashboard 入口。使用者必須先在
`http://localhost:8088` 登入，並具備 `admin`、`wazuh-admin` 或 `wazuh-readonly` 其中一種 role。
Wazuh stack 預設不會跟主系統一起啟動，請見「Wazuh 整合」。

## VM 建議規格

以下規格以本機開發 / 小型測試環境為主。正式環境請依 DICOM 上傳量、影像保存天數、Wazuh agent
數量、備份策略與法遵需求再放大。

### 只跑 DICOM Portal

適用服務：PostgreSQL、Orthanc、Keycloak、FastAPI backend、frontend Nginx、OHIF。

```text
最低可跑：2 vCPU / 4 GB RAM / 50 GB disk
建議規格：4 vCPU / 8 GB RAM / 100 GB disk
```

磁碟主要會被 Orthanc DICOM 儲存吃掉。若會上傳大量 CT / MRI，建議把 Orthanc storage
改掛獨立資料碟，並預留備份空間。

### DICOM Portal + Wazuh

適用服務：上面全部服務，再加 Wazuh manager、Wazuh indexer、Wazuh dashboard。

```text
最低可跑：4 vCPU / 8 GB RAM / 100 GB disk
建議規格：8 vCPU / 16 GB RAM / 200 GB disk
較多 agent 或保存較久 log：8-16 vCPU / 32 GB RAM / 500 GB+ disk
```

Wazuh 官方 single-node Docker 文件列出的最低需求是 4 CPU、8 GB RAM、50 GB storage，且
Wazuh indexer 需要：

```bash
sudo sysctl -w vm.max_map_count=262144
```

官方文件：

```text
https://documentation.wazuh.com/current/deployment-options/docker/wazuh-container.html
```

## 測試帳號

Keycloak admin：

```text
帳號：admin
密碼：admin
```

客戶 A：

```text
帳號：customer-a
密碼：customer-a
tenant_id：tenant-a
roles：viewer, uploader
```

客戶 B：

```text
帳號：customer-b
密碼：customer-b
tenant_id：tenant-b
roles：viewer, uploader
```

管理者：

```text
帳號：portal-admin
密碼：portal-admin
roles：admin, viewer, uploader
```

## Keycloak 新增使用者與賦予權限

本系統使用 `dicom` realm，並用 Keycloak realm role 控制功能：

```text
viewer   可登入入口網站並檢視影像清單
uploader 可上傳 DICOM / ZIP
admin    可看全部租戶影像，並可進入 Orthanc 管理入口
wazuh-admin    可進入 Wazuh，並映射為 Wazuh admin
wazuh-readonly 可進入 Wazuh，並映射為 Wazuh read-only
```

每個一般客戶使用者都必須設定 `tenant_id` 屬性。Backend 會從 access token 的 `tenant_id`
claim 判斷資料歸屬；沒有 `admin` role 的使用者只會看到同一個 `tenant_id` 的影像。

### 使用 Keycloak 管理後台

1. 開啟 `http://localhost:8080/admin`。
2. 使用 Keycloak 管理帳號登入：

```text
帳號：admin
密碼：admin
```

3. 左上角 realm 切換到 `dicom`，不要留在 `master`。
4. 到 `Users` → `Add user`。
5. 填入 `Username`，例如 `customer-c`，並確認 `Enabled` 為 `On`。
6. 設定使用者的 `tenant_id`。

Keycloak 26 的新版畫面有時不會直接顯示舊版的 `Attributes` 區塊。若在使用者 Details 頁看不到
`Attributes`，請先到左側 `Realm settings` → `User profile`，新增一個 attribute：

```text
Attribute name：tenant_id
Display name：tenant_id
```

儲存後回到 `Users` → 選擇使用者 → `Details`，頁面下方會出現可填寫的 `tenant_id` 欄位。
請填入：

```text
Value：tenant-c
```

7. 到 `Credentials` 設定密碼，例如 `customer-c`，並將 `Temporary` 關閉，避免第一次登入被要求改密碼。
8. 到 `Role mapping` → `Assign role`，指派需要的 realm roles。

Keycloak 26 的 `Assign role` 視窗可能預設顯示 client roles，所以一開始看不到 `admin`、`viewer`、
`uploader`。請在彈出視窗上方的篩選器改成：

```text
Filter by realm roles
```

再搜尋或勾選：

```text
一般只看影像：viewer
一般可上傳：viewer, uploader
管理者：admin, viewer, uploader
資安管理者：admin, viewer, uploader, wazuh-admin
Wazuh 唯讀：wazuh-readonly
```

如果仍然找不到，請確認左上角目前 realm 是 `dicom`，不是 `master`。

9. 從 `http://localhost:8088` 按「SSO 登入」，使用新帳號登入測試。

如果不想調整 User profile，也可以直接用下面 CLI 寫入 `tenant_id`，效果相同。

### 使用 Keycloak CLI

也可以用容器內的 `kcadm.sh` 建立使用者。以下範例建立一個 `tenant-c` 的上傳者：

```bash
docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user admin \
  --password admin

docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  create users \
  -r dicom \
  -s username=customer-c \
  -s enabled=true \
  -s emailVerified=true \
  -s firstName=Customer \
  -s lastName=C \
  -s 'attributes.tenant_id=["tenant-c"]'

docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  set-password \
  -r dicom \
  --username customer-c \
  --new-password customer-c \
  --temporary=false

docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  add-roles \
  -r dicom \
  --uusername customer-c \
  --rolename viewer \
  --rolename uploader
```

建立 Wazuh 使用者時，請依需求指派 `wazuh-admin` 或 `wazuh-readonly`：

```bash
docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  add-roles \
  -r dicom \
  --uusername security-user \
  --rolename wazuh-readonly
```

若使用者已經存在，只要補上或修改 `tenant_id`，可以先查 user id，再更新 attributes：

```bash
docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  get users \
  -r dicom \
  -q username=gojim \
  --fields id,username,attributes

docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  update users/<USER_ID> \
  -r dicom \
  -s 'attributes.tenant_id=["tenant-a"]'
```

建立管理者時，請指派 `admin`，並建議同時給 `viewer`、`uploader`：

```bash
docker exec dicom-customer-portal-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  add-roles \
  -r dicom \
  --uusername portal-admin \
  --rolename admin \
  --rolename viewer \
  --rolename uploader
```

### 修改匯入檔

如果希望新帳號在重新建立環境時自動存在，可以把使用者加入
`keycloak/realm-dicom.json` 的 `users` 陣列。格式範例：

```json
{
  "username": "customer-c",
  "enabled": true,
  "emailVerified": true,
  "firstName": "Customer",
  "lastName": "C",
  "attributes": {
    "tenant_id": ["tenant-c"]
  },
  "credentials": [
    { "type": "password", "value": "customer-c", "temporary": false }
  ],
  "realmRoles": ["viewer", "uploader"]
}
```

注意：Keycloak 只會在 realm 初次匯入時套用 `realm-dicom.json`。如果已經啟動過環境，修改匯入檔不會自動覆蓋既有資料；開發環境可用 `docker compose down -v` 清掉 volume 後再重新啟動。

## API 摘要

### 取得登入者資訊

```http
GET /api/me
Authorization: Bearer <Keycloak access token>
```

### 上傳 DICOM 或 ZIP

```http
POST /api/upload
Authorization: Bearer <Keycloak access token>
Content-Type: multipart/form-data
files=<DICOM files or ZIP archives>
```

後端會：

1. 檢查使用者是否有 `uploader` role。
2. 將 DICOM 或包含 DICOM 的 ZIP 送到 Orthanc `POST /instances`。
3. 讀取 Orthanc 匯入的每個 instance simplified-tags。
4. 將 Orthanc Study ID、Instance ID、PatientID、StudyInstanceUID 與 `tenant_id` 寫入 PostgreSQL。

### 查詢自己的影像清單

```http
GET /api/studies
Authorization: Bearer <Keycloak access token>
```

只會回傳同一個 `tenant_id` 的資料。

## 權限模型

目前 MVP 的隔離點在「入口網站資料庫」：

```text
Keycloak access token
  ↓
tenant_id claim
  ↓
FastAPI 查詢時加上 WHERE tenant_id = 使用者 tenant_id
```

這代表：

- 客戶 A 在入口網站看不到客戶 B 的清單。
- Orthanc 本身仍是同一個資料池。
- 正式商用時，OHIF / DICOMweb 也應加上授權層，不能只靠前端隱藏連結。

## Wazuh 整合

本專案已加入 Wazuh 的可選 Docker Compose 設定：

```text
docker-compose.wazuh.yml
wazuh/config/
```

Wazuh 官方 single-node Docker 部署包含 Wazuh manager、Wazuh indexer、Wazuh dashboard 三個主要元件。
官方文件也提醒 single-node 至少需要約 4 CPU、8 GB RAM、50 GB 儲存空間，並且 Wazuh indexer
需要主機設定 `vm.max_map_count=262144`。

官方文件：

```text
https://documentation.wazuh.com/current/deployment-options/docker/wazuh-container.html
https://documentation.wazuh.com/current/user-manual/user-administration/single-sign-on/keycloak.html
```

### 啟動 Wazuh

第一次啟動前，Linux 主機需要先調整：

```bash
sudo sysctl -w vm.max_map_count=262144
```

macOS Docker Desktop 請確認 Docker Desktop 分配的 CPU / Memory 足夠。啟動主系統加 Wazuh：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up --build
```

開啟：

```text
http://localhost:5601
```

此入口由本專案 Nginx 先呼叫 backend 驗證 Keycloak cookie，通過後由 backend 回傳對應的
Wazuh 身分，Nginx 再注入到 Wazuh Dashboard：

```text
admin / wazuh-admin -> Wazuh admin
wazuh-readonly      -> Wazuh kibanaro/readall
其他使用者          -> 導回 http://localhost:8088
```

因此日常使用時請從 `http://localhost:8088` 先用 Keycloak SSO 登入；有 Wazuh 權限的使用者會看到
`Wazuh` 連結，點進去會直接進入 Wazuh Dashboard，不需要另外輸入 Wazuh 密碼。

### Wazuh 本身的 Keycloak 權限

目前本專案用 Nginx `auth_request` 將 Keycloak role 映射到 Wazuh 內建帳號，適合本機開發與簡化部署。
若正式環境需要 Wazuh Dashboard 原生顯示 Keycloak SSO 流程，或要做更細緻的 Wazuh role mapping，
請再依 Wazuh 官方 Keycloak SSO 文件設定 SAML。

重點設定如下：

1. 在 Keycloak 建立 Wazuh 的 SAML client。
2. 在 Wazuh Dashboard 啟用 SAML auth，保留 basicauth 作為 break-glass 管理登入。
3. 在 `/usr/share/wazuh-dashboard/data/wazuh/config/wazuh.yml` 保持：

```yaml
run_as: true
```

4. 在 Wazuh Security roles mapping 將 Keycloak 傳入的 backend role 對應到 Wazuh 角色：

```text
wazuh-admin    -> administrator
wazuh-readonly -> readonly
```

官方 SSO 文件說明 Wazuh Dashboard 以 SAML 與 Keycloak 串接，並透過 `backend_roles`
做 role mapping；`run_as: true` 則讓 Wazuh API 使用登入者權限執行。

## 正式商用前需要補強

1. **Orthanc REST API 不對外開放**
   - 僅允許 backend / trusted network 存取。

2. **OHIF / DICOMweb 權限控管**
   - 建議使用 Orthanc Authorization Plugin、auth-service、Nginx auth_request，或由後端簽發短效 study token。

3. **DICOM PHI 管控**
   - 上傳前檢查 DICOM tags。
   - 視需求做去識別化。
   - 記錄誰在何時上傳、檢視、下載。

4. **檔案大小與副檔名不足以驗證 DICOM**
   - 目前 MVP 直接送 Orthanc。
   - 正式版應加入格式驗證、病毒掃描、上傳大小限制。

5. **帳密與秘密值**
   - 不要使用 `orthanc/orthanc`、`admin/admin`。
   - 改用 secret manager 或 Docker secrets。

6. **多租戶更強隔離**
   - 高風險客戶建議每個租戶一台 Orthanc 或獨立資料庫 / 儲存區。

## 目錄說明

```text
backend/
  FastAPI 後端
frontend/
  靜態前端，上傳與清單頁
keycloak/
  realm 匯入檔，含測試帳號與 roles
orthanc/
  Orthanc 設定檔
nginx/
  前端 Nginx 設定
docker-compose.yml
```

## 與 OHIF 整合

清單 API 會產生：

```text
http://localhost:3000/viewer/<StudyInstanceUID>
```

本機開發環境會啟動 OHIF viewer，並透過 frontend Nginx 將 `http://localhost:8088/dicom-web/`
代理到 Orthanc DICOMweb。DICOMweb / WADO 入口會先呼叫 backend 驗證 Keycloak Bearer token，
使用者必須具備 `viewer` role 才能讀取影像；Nginx 只會在通過驗證後，於內部補 Orthanc basic auth。

Orthanc 管理 UI 也透過 frontend Nginx 暴露在 `http://localhost:8042`，每個請求都會先呼叫
backend 驗證 Keycloak token，且使用者必須具備 `admin` role。真正的 Orthanc HTTP port 不直接暴露到 host。

OHIF viewer 本機開發網址：

```text
http://localhost:3000
```

正式環境建議改成：

```text
入口網站產生短效 token
  ↓
OHIF 開圖時帶 token
  ↓
Nginx / auth-service 驗證 token
  ↓
只允許讀取該 tenant 被授權的 StudyInstanceUID
```

## 注意

此專案是可運作骨架，不是醫療正式產品。正式上線前需要資安、隱私、稽核、備份、災難復原與法遵設計。

## 登入注意事項

- `admin / admin` 是 Keycloak 管理後台帳號，只能用在 `http://localhost:8080/admin`。
- `customer-a / customer-a`、`customer-b / customer-b`、`portal-admin / portal-admin` 是 `dicom` realm 的測試客戶帳號，請從 `http://localhost:8088` 按「SSO 登入」進入，不要在 Keycloak 管理後台登入。
- 若之前啟動過舊版容器，請用 `docker compose down -v` 清掉舊資料後再 `docker compose up --build`，避免 realm 沒有重新匯入。
