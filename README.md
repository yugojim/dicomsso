# DICOM 客戶網站：帳號、上傳、清單、SSO 權限

這是一個最小可行版本（MVP）專案骨架，用於建立客戶 DICOM 上傳入口。
## 功能

- Keycloak SSO 登入
- 以 Keycloak role 控制權限
  - `viewer`：可看自己的影像清單
  - `uploader`：可上傳 DICOM
  - `admin`：保留管理者角色
  - `wazuh-admin` / `wazuh-readonly`：可進入 Wazuh
  - `fhir-user` / `fhir-admin`：可讀取 / 可讀寫 HAPI FHIR server
- 客戶上傳 DICOM 檔案
- 後端呼叫 Orthanc REST API 寫入 DICOM
- PostgreSQL 記錄租戶 `tenant_id` 與 Orthanc Study / Instance 對應
- 客戶只能看到自己 `tenant_id` 底下的資料
- 清單提供 OHIF URL 欄位，方便後續接 OHIF Viewer
- 內建 HAPI FHIR server，讀寫權限同樣由 Keycloak role 控管

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

另一條路徑：
Browser / FHIR client
  ↓ Bearer token 或 kc_token cookie
Nginx :18090（auth_request → FastAPI /api/auth/fhir 驗 Keycloak role）
  ↓
HAPI FHIR Server（不對外開 port）
  ↓
PostgreSQL 的 hapi 資料庫
```

正式環境建議：不要讓客戶直接存取 Orthanc Explorer 或 Orthanc REST API。

## 啟動

只啟動 DICOM Portal 主系統：

```bash
docker compose up --build
```

第一次啟動如果 `postgres_data` volume 已經存在（不是全新環境），HAPI FHIR 需要的 `hapi` 資料庫
不會被自動建立，請補跑一次：

```bash
docker compose exec postgres psql -U dicom -d dicom_portal -c "CREATE DATABASE hapi OWNER dicom;"
docker compose up -d hapi-fhir
```

啟動 DICOM Portal + Wazuh：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart frontend
```

若需要看即時 log，可改用前景執行：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up --build
```

開啟：

```text
客戶入口：http://localhost:8088
Keycloak：http://localhost:8080
Orthanc 管理入口：http://localhost:18042
OHIF：http://localhost:13000
Wazuh 入口：http://localhost:15601
HAPI FHIR：http://localhost:18090/fhir
Backend API：http://localhost:18000/docs
```

### Port 對照

為了避免和本機常見服務衝突，compose 只保留 Keycloak 的 `8080` 與客戶入口的 `8088`，其他服務改用高位 host port。
Docker 內部服務仍使用原本 container port，不影響容器之間通訊。

| 服務 | Host port | Container port | 說明 |
| --- | ---: | ---: | --- |
| Frontend / 客戶入口 | `8088` | `80` | 客戶登入、上傳、清單 |
| Keycloak | `8080` | `8080` | SSO 與管理後台 |
| Backend API | `18000` | `8000` | FastAPI / Swagger |
| Orthanc 管理代理 | `18042` | `8042` | 經 Nginx 權限保護 |
| OHIF | `13000` | `80` | Viewer |
| Orthanc DICOM | `14242` | `4242` | DICOM C-STORE 等 |
| PostgreSQL | `15432` | `5432` | 本機 debug 用 |
| Wazuh Dashboard 代理 | `15601` | `5601` | 經 Nginx 權限保護 |
| HAPI FHIR 代理 | `18090` | `8090` | 經 Nginx 權限保護，FHIR base 為 `/fhir` |
| Wazuh Indexer | `19200` | `9200` | debug 用 |
| Wazuh Manager API | `55001` | `55000` | debug 用 |
| Wazuh agent | `11514` | `1514` | agent event |
| Wazuh enrollment | `11515` | `1515` | agent enrollment |
| Wazuh syslog | `5514/udp` | `514/udp` | syslog |

### Port 使用方式

一般日常使用只需要開這幾個網址：

```text
客戶使用者入口      http://localhost:8088
Keycloak 管理後台   http://localhost:8080/admin
Orthanc 管理入口    http://localhost:18042
OHIF Viewer         http://localhost:13000
Wazuh Dashboard     http://localhost:15601
HAPI FHIR Server    http://localhost:18090（FHIR base：http://localhost:18090/fhir）
```

開發與除錯時才需要直接使用這些 port：

```text
Backend Swagger     http://localhost:18000/docs
PostgreSQL          localhost:15432
Wazuh Indexer       https://localhost:19200
Wazuh Manager API   https://localhost:55001
Orthanc DICOM       localhost:14242
```

Wazuh agent 連線請使用這些 host port：

```text
Agent event         localhost:11514
Agent enrollment    localhost:11515
Syslog UDP          localhost:5514
```

不要再使用舊的 host port `3000`、`5601`、`8042`、`8000`。這些已改成 `13000`、`15601`、`18042`、`18000`，用來避免和本機其他服務衝突。

若從同一個 LAN 以固定 IP 存取，也可以把 `localhost` 換成伺服器 IP，例如：

```text
客戶入口：http://192.168.1.112:8088
Keycloak：http://192.168.1.112:8080
Orthanc 管理入口：http://192.168.1.112:18042
OHIF：http://192.168.1.112:13000
Wazuh 入口：http://192.168.1.112:15601
HAPI FHIR：http://192.168.1.112:18090/fhir
```

`http://localhost:18042` 不是直接暴露 Orthanc，而是經由 Nginx 保護的 Orthanc 管理入口。
請先到 `http://localhost:8088` 用具備 `admin` role 的 Keycloak 帳號登入，再開啟 Orthanc 管理入口。
未登入或非 admin 使用者會被導回客戶入口。

`http://localhost:15601` 是經由 Nginx 保護的 Wazuh Dashboard 入口。使用者必須先在
`http://localhost:8088` 登入，並具備 `admin`、`wazuh-admin` 或 `wazuh-readonly` 其中一種 role。
Wazuh stack 預設不會跟主系統一起啟動，請見「Wazuh 整合」。

如果啟動時看到 `bind: address already in use`，代表本機已有其他程式佔用對應 port。
目前 compose 避開常見 port，主要對外 port 是 `8088`, `8080`, `18042`, `13000`, `15601`, `18000`。
可先查詢並停止佔用者：

```bash
lsof -nP -iTCP:<PORT> -sTCP:LISTEN
kill <PID>
```

或將 `docker-compose.yml` 內對應服務的左側 host port 改成其他值，並同步調整前端連結或
`OHIF_VIEWER_URL`。

如果登入後看到 `/api/me failed: 502 Bad Gateway`，通常是 backend 容器重建後，frontend Nginx
仍連到舊的 backend container IP。先確認 backend 本身正常：

```bash
curl -s -D - http://localhost:18000/docs
```

若 backend 回 `200 OK`，重啟 frontend 讓 Nginx 重新解析 backend：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart frontend
```

再重新整理 `http://localhost:8088`。修正後，未登入狀態下 `/api/me` 應回 `401 Missing token`，而不是
`502 Bad Gateway`。

## VM 建議規格

以下規格以本機開發 / 小型測試環境為主。正式環境請依 DICOM 上傳量、影像保存天數、Wazuh agent
數量、備份策略與法遵需求再放大。

### 只跑 DICOM Portal

適用服務：PostgreSQL、Orthanc、Keycloak、FastAPI backend、frontend Nginx、OHIF、HAPI FHIR。

```text
最低可跑：2 vCPU / 4 GB RAM / 50 GB disk
建議規格：4 vCPU / 8 GB RAM / 100 GB disk
```

HAPI FHIR 是 Java 服務，實測常駐約 1 GB RAM。若只有 4 GB RAM，建議 Keycloak 與 HAPI 不要同時
承載大量請求，或直接用 8 GB RAM 規格。

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
roles：viewer, uploader, fhir-user
```

客戶 B：

```text
帳號：customer-b
密碼：customer-b
tenant_id：tenant-b
roles：viewer, uploader, fhir-user
```

管理者：

```text
帳號：portal-admin
密碼：portal-admin
roles：admin, viewer, uploader, wazuh-admin, fhir-user, fhir-admin
```

## Keycloak 新增使用者與賦予權限

本系統使用 `dicom` realm，並用 Keycloak realm role 控制功能：

```text
viewer   可登入入口網站並檢視影像清單
uploader 可上傳 DICOM / ZIP
admin    可看全部租戶影像，並可進入 Orthanc 管理入口
wazuh-admin    可進入 Wazuh，並映射為 Wazuh admin
wazuh-readonly 可進入 Wazuh，並映射為 Wazuh read-only
fhir-user      可讀取 HAPI FHIR server
fhir-admin     可讀寫 HAPI FHIR server
```

每個一般客戶使用者都必須設定 `tenant_id` 屬性。Backend 會從 access token 的 `tenant_id`
claim 判斷資料歸屬；沒有 `admin` role 的使用者只會看到同一個 `tenant_id` 的影像。

### 使用者自行註冊與管理者審核

入口網站提供「註冊帳號」按鈕，會導到 Keycloak `dicom` realm 的註冊畫面。
新使用者可以自己建立帳號，但預設沒有 `viewer`、`uploader`、`admin` 等業務 role。
登入後若尚未核准，入口網站會顯示「帳號待管理者審核，尚未開通影像功能」。

管理者審核流程：

1. 開啟 `http://localhost:8080/admin`。
2. 使用 Keycloak 管理帳號登入，並切換到 `dicom` realm。
3. 到 `Users` 找到新註冊的使用者。
4. 在 `Details` 設定 `tenant_id`，例如 `tenant-a`。
5. 到 `Role mapping` → `Assign role`，指派需要的 realm roles。

常見核准方式：

```text
只看影像：viewer
可上傳影像：viewer, uploader
一般管理者：admin, viewer, uploader
Wazuh 管理者：admin, viewer, uploader, wazuh-admin
Wazuh 唯讀：wazuh-readonly
```

Keycloak realm 匯入檔已設定 `registrationAllowed: true`。如果環境已經跑過，修改
`keycloak/realm-dicom.json` 不會自動覆蓋既有 realm，需要用管理後台開啟，或執行：

```bash
docker exec dicomsso-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user admin \
  --password admin

docker exec dicomsso-keycloak-1 /opt/keycloak/bin/kcadm.sh \
  update realms/dicom \
  -s registrationAllowed=true \
  -s registrationEmailAsUsername=false \
  -s rememberMe=true
```

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
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user admin \
  --password admin

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  create users \
  -r dicom \
  -s username=customer-c \
  -s enabled=true \
  -s emailVerified=true \
  -s firstName=Customer \
  -s lastName=C \
  -s 'attributes.tenant_id=["tenant-c"]'

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  set-password \
  -r dicom \
  --username customer-c \
  --new-password customer-c \
  --temporary=false

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  add-roles \
  -r dicom \
  --uusername customer-c \
  --rolename viewer \
  --rolename uploader
```

建立 Wazuh 使用者時，請依需求指派 `wazuh-admin` 或 `wazuh-readonly`：

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  add-roles \
  -r dicom \
  --uusername security-user \
  --rolename wazuh-readonly
```

若使用者已經存在，只要補上或修改 `tenant_id`，可以先查 user id，再更新 attributes：

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  get users \
  -r dicom \
  -q username=gojim \
  --fields id,username,attributes

docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
  update users/<USER_ID> \
  -r dicom \
  -s 'attributes.tenant_id=["tenant-a"]'
```

建立管理者時，請指派 `admin`，並建議同時給 `viewer`、`uploader`：

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh \
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

`realmRoles` 可填的值：`viewer`、`uploader`、`admin`、`wazuh-admin`、`wazuh-readonly`、
`fhir-user`、`fhir-admin`。要讓新帳號可以讀 FHIR，就加上 `fhir-user`。
另外建議一併填 `email`，沒有 email 的帳號無法用 password grant 直接換 token。

注意：Keycloak 只會在 realm 初次匯入時套用 `realm-dicom.json`。如果已經啟動過環境，修改匯入檔不會自動覆蓋既有資料；開發環境可用 `docker compose down -v` 清掉 volume 後再重新啟動。

## LINE Bot 上傳通知

後端支援在 `/api/upload` 成功匯入 DICOM 並寫入入口網站資料庫後，用 LINE Messaging API 推播文字訊息到指定群組。未設定 LINE 變數時，通知功能會自動略過，不影響上傳。

管理者登入後可在上傳區按「送出 LINE 格式測試」，呼叫 `/api/line/send-message-format-samples` 將 LINE Messaging API 的訊息範例分批送到 `LINE_GROUP_ID`。範例包含 text、text emoji、textV2、quick reply/actions、sticker、image、video、audio、location、imagemap、template buttons、template confirm、template carousel、template image carousel、flex bubble、flex carousel。LINE push API 一次最多 5 則訊息，後端會自動分批；coupon 訊息需要先在 LINE 建立 coupon 並取得 `couponId`，設定 `LINE_COUPON_ID` 後才會送出 coupon 物件，未設定時會以文字說明略過。

### LINE Developers 設定

1. 到 LINE Developers 建立 Provider 與 Messaging API channel。
2. 在 Messaging API channel 內取得 `Channel access token`，填入 `LINE_CHANNEL_ACCESS_TOKEN`。
3. 在 Basic settings 取得 `Channel secret`，填入 `LINE_CHANNEL_SECRET`。
4. 將 bot 加入要通知的 LINE 群組。
5. 若需要取得群組 ID，先把 webhook URL 設為：

```text
https://<公開網域>/api/line/webhook
```

本機開發時可用 ngrok 或其他 tunnel 將 backend 對外的 `18000` port 暴露出去。群組內傳任一則訊息後，backend log 會印出：

```text
LINE webhook event source: type=group groupId=<LINE_GROUP_ID> ...
```

6. 將取得的 `groupId` 填入 `LINE_GROUP_ID`，重啟 backend。

### 環境變數

```env
LINE_CHANNEL_ACCESS_TOKEN=<Messaging API channel access token>
LINE_CHANNEL_SECRET=<Messaging API channel secret>
LINE_GROUP_ID=<群組 groupId>
LINE_COUPON_ID=<選填：LINE couponId>
```

Docker Compose 已將這些變數傳給 backend，可放在專案根目錄 `.env`：

```bash
docker compose up -d --build backend
```

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

### Nginx 授權閘道用的內部端點

這幾個端點是給 Nginx `auth_request` 呼叫的，不是給前端直接用。回 `200` 代表放行，
回 `401` / `403` 代表擋下：

```http
GET /api/auth/viewer          需要 viewer；保護 /dicom-web/ 與 /wado
GET /api/auth/orthanc-admin   需要 admin；保護 Orthanc 管理入口 :18042
GET /api/auth/wazuh           需要 wazuh-admin / wazuh-readonly；保護 Wazuh :15601
GET /api/auth/fhir            需要 fhir-user（讀）或 fhir-admin（寫）；保護 /fhir REST API
GET /api/auth/fhir-ui         需要 fhir-admin；保護 HAPI 內建測試頁
```

`/api/auth/fhir` 會讀 Nginx 帶進來的 `X-Original-Method` 判斷這次是讀還是寫，
`POST` / `PUT` / `PATCH` / `DELETE` 才要求 `fhir-admin`。
`/api/auth/wazuh` 另外會回 `X-Wazuh-Authorization` header，讓 Nginx 換成 Wazuh 自己的帳密。

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
- HAPI FHIR 目前也是同一個資料池：只做到「有沒有 role」與「能不能寫」，沒有做 `tenant_id` 隔離。
- 正式商用時，OHIF / DICOMweb 也應加上授權層，不能只靠前端隱藏連結。

## HAPI FHIR Server（Keycloak 控管）

系統另外啟動一台 HAPI FHIR JPA Server（`hapiproject/hapi`），資料存在同一台 PostgreSQL 的 `hapi` 資料庫。

```text
FHIR base URL：http://localhost:18090/fhir
測試用網頁 UI：http://localhost:18090/
```

### 授權架構

HAPI FHIR 社群版本身不會驗 Keycloak token，因此 **不對外開 port**，只允許 docker network 內的 Nginx 連線。
所有請求都要先過 Nginx 的 `auth_request` 閘道，跟 Orthanc 管理入口、Wazuh 是同一套做法：

```text
Client（瀏覽器 / FHIR client）
  ↓ Authorization: Bearer <access_token> 或 kc_token cookie
Nginx :18090
  ├─ /fhir/...  --auth_request--> Backend /api/auth/fhir     驗 role + HTTP method
  └─ 其他路徑    --auth_request--> Backend /api/auth/fhir-ui  需要 fhir-admin
  ↓ 通過才轉送
HAPI FHIR :8080（未對外開放）
  ↓
PostgreSQL 的 hapi 資料庫
```

Nginx 不會把使用者的 token 往 HAPI 送，避免 token 落在 HAPI 的 log。

### 角色與權限

| Realm role | `/fhir` REST API | HAPI 內建測試頁（`http://localhost:18090/`） |
| --- | --- | --- |
| `fhir-user` | 讀取：`GET`、`HEAD`、`_search` 等 | ✗ 導回入口網站 |
| `fhir-admin` | 讀取 + 寫入：`POST`、`PUT`、`PATCH`、`DELETE` | ✓ |
| `admin` | 全部（`require_role` 讓 `admin` 通吃） | ✓ |

測試頁為什麼只給 `fhir-admin`：那個頁面是 HAPI 在**容器內用 server-side 呼叫自己的 8080**，
不會再經過 Nginx，所以頁面上的 create / update / delete 按鈕繞得過上面的讀寫檢查。
只開放給本來就有寫入權的 `fhir-admin`，才不會變成 `fhir-user` 的提權管道。
只有 `fhir-user` 的帳號請直接用 `/fhir` REST API。

被擋下時的回應：`/fhir` REST API 回 FHIR 標準的 `OperationOutcome`，測試頁則導回入口網站登入。

```text
/fhir  未登入 / token 無效       401 OperationOutcome（附 WWW-Authenticate: Bearer）
/fhir  只有 fhir-user 卻要寫入   403 OperationOutcome
測試頁 沒有 fhir-admin           302 導回 http://<host>:8088
```

匯入檔 `keycloak/realm-dicom.json` 已預設：

```text
customer-a / customer-b   fhir-user
portal-admin              fhir-user + fhir-admin
```

要幫既有帳號加權限，用 Keycloak 管理後台 Users → Role mapping 指派 `fhir-user` 或 `fhir-admin`，
或用 CLI：

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master --user admin --password admin
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh add-roles \
  -r dicom --uusername <帳號> --rolename fhir-user
```

realm 匯入檔改過之後，要讓新 role 生效需要重建 Keycloak 容器（`start-dev` 沒有掛 volume，重建就會重新匯入）：

```bash
docker compose up -d --force-recreate keycloak
```

### 第一次啟動

`hapi` 資料庫由 `postgres/init/01-create-hapi-db.sql` 建立，但這個 script 只有在 `postgres_data`
volume **第一次建立** 時才會執行。既有環境請手動建一次：

```bash
docker compose exec postgres psql -U dicom -d dicom_portal -c "CREATE DATABASE hapi OWNER dicom;"
docker compose up -d hapi-fhir
```

HAPI 第一次啟動要跑資料表 migration，約需 30 秒到 1 分鐘。確認啟動完成：

```bash
docker compose logs -f hapi-fhir | grep "Started Application"
```

### 驗收指令

```bash
# 1. 未帶 token → 401
curl -i http://localhost:18090/fhir/metadata

# 2. 取得 token
TOKEN=$(curl -s -X POST http://localhost:8080/realms/dicom/protocol/openid-connect/token \
  -d grant_type=password -d client_id=dicom-portal \
  -d username=portal-admin -d password=portal-admin | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# 3. 讀 CapabilityStatement → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  http://localhost:18090/fhir/metadata

# 4. 建立 Patient（需要 fhir-admin）→ 201
curl -i -X POST http://localhost:18090/fhir/Patient \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/fhir+json" \
  -d '{"resourceType":"Patient","name":[{"family":"Wang","given":["Test"]}]}'

# 5. 查詢
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:18090/fhir/Patient?family=Wang"
```

只有 `fhir-user` 的帳號執行第 4 步會拿到 `403`，這就是讀寫分權的驗收點。

### 瀏覽器操作

在客戶入口 `http://localhost:8088` 用有 FHIR role 的帳號登入後，右上角會出現 **FHIR Server** 連結。
登入時寫入的 `kc_token` cookie 是以主機名為範圍（不分 port），所以點進 `http://localhost:18090/`
的 HAPI 測試頁時會自動帶上，不需要再登入一次。沒有 `fhir-admin` 的帳號會被導回 `http://localhost:8088`。

測試頁上顯示的 **FHIR Base** 會是 `http://localhost:8080/fhir`，這是正常的：那是測試頁的 Java 程式
在容器內部自己要連的位址（設定在 `fhir/application.yaml` 的 `tester.home.server_address`），
不能填對外網址，否則容器內連不到會出現 `Failed to load conformance statement ... Connection refused`。

**外部程式要用的 FHIR base 一律是 `http://<host>:18090/fhir`**，例如：

```text
http://localhost:18090/fhir
http://192.168.1.112:18090/fhir
```

走 `:18090` 的請求，HAPI 會依 Nginx 帶進來的 `X-Forwarded-Host` 產生正確的 `fullUrl` 與
`Location` header，所以 localhost 與區網 IP 兩種進入點都不需要另外設定。

### 尚未做的事

- HAPI 端沒有做 tenant 隔離：有 `fhir-user` 就看得到全部 FHIR 資源。若要做到跟 DICOM 清單一樣的
  租戶隔離，需要另外用 partitioning 或在閘道加上 `tenant_id` 對應規則。
- DICOM study 尚未自動轉成 FHIR `ImagingStudy`。目前兩邊是各自獨立的資料。
- HAPI 內建測試頁沒有經過 Nginx 的讀寫檢查，目前是用「只給 fhir-admin」規避。若之後要讓 `fhir-user`
  也能用圖形介面查資料，應改成關掉內建測試頁，另外做一個走 `/fhir` REST API 的前端頁面。

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
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart frontend
```

若要看即時 log，可使用前景模式：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up --build
```

只停掉 Wazuh、保留 DICOM Portal 繼續跑（Wazuh 很吃資源，平常不驗收時可以先停）：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml stop wazuh-dashboard wazuh-manager wazuh-indexer
```

查看狀態：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml ps
```

查看 Wazuh 安裝 / 啟動進度：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml logs -f wazuh-certs-generator wazuh-indexer wazuh-manager wazuh-dashboard
```

各階段大致會看到：

```text
wazuh-certs-generator  產生憑證後 Exited，這是正常狀態
wazuh-indexer          OpenSearch / indexer 啟動
wazuh-manager          出現 Completed.、Started wazuh-apid、Connection to backoff(...) established
wazuh-dashboard        出現 Server running at https://0.0.0.0:5601（容器內部 port；對外入口是 15601）
```

停止主系統加 Wazuh：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml stop
```

若曾經只用 `docker compose up` 啟動主系統，之後再切換到 Wazuh compose，Docker 可能會提示 orphan
containers。要一併清理不再屬於目前 compose 組合的舊容器，可以使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml up --build --remove-orphans
```

如果服務啟動失敗並出現 `bind: address already in use`，表示本機已有其他程式佔用對應 host port。
目前 OHIF 對外使用 `13000`。可先查詢：

```bash
lsof -nP -iTCP:<PORT> -sTCP:LISTEN
```

再停止該行程：

```bash
kill <PID>
```

若該行程不能停止，請改用其他 host port，例如在 `docker-compose.yml` 將 `ohif` 的 `13000:80`
改為 `13002:80`，並把 backend 的 `OHIF_VIEWER_URL` 改為 `http://localhost:13002/viewer`。

如果入口網站顯示 `/api/me failed: 502 Bad Gateway`，而 backend API 本身可開啟：

```bash
curl -s -D - http://localhost:18000/docs
```

表示 frontend Nginx 可能仍快取舊的 backend container IP。重啟 frontend 即可重新解析：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart frontend
```

重啟後可用以下指令確認狀態。未登入時回 `401 Missing token` 是正常的；若仍回 `502` 才代表 upstream
仍有問題：

```bash
curl -s -D - http://localhost:8088/api/me
```

若 Wazuh 畫面顯示 `Error: 3002 - Request failed with status code 429`，代表 Wazuh Dashboard 在短時間內
對 Wazuh Manager API 發出太多 health check / login 請求，被 Manager API 限流。先確認
`wazuh/config/wazuh_dashboard/wazuh.yml` 使用本機驗收建議設定：

```yaml
run_as: false
```

然後重啟 Wazuh manager、dashboard 與 frontend：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml restart wazuh-manager wazuh-dashboard frontend
```

可用以下指令確認 Wazuh Manager API 已可正常取得版本資訊：

```bash
docker compose -f docker-compose.yml -f docker-compose.wazuh.yml exec wazuh-dashboard sh -c 'TOKEN=$(curl -sk -u wazuh-wui:"MyS3cr37P450r.*-" -X POST "https://wazuh.manager:55000/security/user/authenticate?raw=true"); curl -sk -H "Authorization: Bearer $TOKEN" https://wazuh.manager:55000/manager/info'
```

開啟：

```text
http://localhost:15601
```

此入口由本專案 Nginx 先呼叫 backend 驗證 Keycloak cookie，通過後由 backend 回傳對應的
Wazuh 身分，Nginx 再放行至 Wazuh Dashboard：

```text
admin / wazuh-admin / wazuh-readonly -> 可進入 Wazuh
其他使用者                         -> 導回 http://localhost:8088
```

因此日常使用時請從 `http://localhost:8088` 先用 Keycloak SSO 登入；有 Wazuh 權限的使用者會看到
`Wazuh` 連結，點進去會直接進入 Wazuh Dashboard，不需要另外輸入 Wazuh 密碼。

### Wazuh 本身的 Keycloak 權限

目前本專案用 Nginx `auth_request` 將 Keycloak role 映射到 Wazuh 內建帳號，適合本機開發與簡化部署。
若正式環境需要 Wazuh Dashboard 原生顯示 Keycloak SSO 流程，或要做更細緻的 Wazuh role mapping，
請再依 Wazuh 官方 Keycloak SSO 文件設定 SAML。

本機驗收環境建議先保持：

```yaml
run_as: false
```

這樣可避免 Wazuh Dashboard 在 health check 階段因 `run_as` 重試過密而觸發 Manager API `429` 限流。

若正式環境要改成 Wazuh 原生 SSO，重點設定如下：

1. 在 Keycloak 建立 Wazuh 的 SAML client。
2. 在 Wazuh Dashboard 啟用 SAML auth，保留 basicauth 作為 break-glass 管理登入。
3. 在 `/usr/share/wazuh-dashboard/data/wazuh/config/wazuh.yml` 改為：

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

7. **FHIR 資料的租戶隔離**
   - 目前只要有 `fhir-user` 就看得到全部 FHIR 資源。
   - 正式版建議用 HAPI 的 partitioning（一個租戶一個 partition），或在授權閘道依 `tenant_id` 限制可存取的 compartment。
   - 也要記錄誰在何時讀寫了哪些 FHIR 資源。

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
fhir/
  HAPI FHIR server 的 Spring 設定（application.yaml）
postgres/
  PostgreSQL 初始化 SQL（建立 hapi 資料庫）
docker-compose.yml
```

## 與 OHIF 整合

清單 API 會產生：

```text
http://localhost:13000/viewer/<StudyInstanceUID>
```

本機開發環境會啟動 OHIF viewer，並透過 frontend Nginx 將 `http://localhost:8088/dicom-web/`
代理到 Orthanc DICOMweb。DICOMweb / WADO 入口會先呼叫 backend 驗證 Keycloak Bearer token，
使用者必須具備 `viewer` role 才能讀取影像；Nginx 只會在通過驗證後，於內部補 Orthanc basic auth。

Orthanc 管理 UI 也透過 frontend Nginx 暴露在 `http://localhost:18042`，每個請求都會先呼叫
backend 驗證 Keycloak token，且使用者必須具備 `admin` role。真正的 Orthanc HTTP port 不直接暴露到 host。

OHIF viewer 本機開發網址：

```text
http://localhost:13000
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
- 新增的 `fhir-user` / `fhir-admin` role 需要 Keycloak 重新匯入 realm 才會出現。因為 `keycloak` 服務沒有掛 volume，重建容器就會重新匯入：`docker compose up -d --force-recreate keycloak`。
- 登入後右上角會依 role 顯示管理連結：`admin` 看得到 Keycloak / Orthanc 管理，`wazuh-*` 看得到 Wazuh，`fhir-*` 看得到 FHIR Server。沒有對應 role 的人看不到，也打不進去（後端與 Nginx 會擋）。
- `customer-a` / `customer-b` 沒有設定 email，無法用 password grant（`curl` 直接換 token）取得 access token，會回 `Account is not fully set up`。要用指令列測 API 請改用 `portal-admin`，或先在 Keycloak 幫這兩個帳號補 email。
