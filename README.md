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
- 依衛福部電子病歷交換單張實作指引（EMR IG）建置的 HIS 風格電子病歷交換平台

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

另一條路徑（電子病歷）：
Browser（/his/ 電子病歷交換平台）或外部 FHIR client
  ↓ Bearer token 或 kc_token cookie
Nginx（同源 :8088/fhir 或對外 :18090）
  ↓ auth_request → FastAPI /api/auth/fhir 驗 Keycloak role 與讀寫
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
主入口（https）：https://localhost:8088/  →  自動導向電子病歷交換平台
電子病歷交換平台：https://localhost:8088/his/
DICOM 影像上傳管理入口：https://localhost:8088/upload/
Keycloak：https://localhost:8443
Orthanc 管理入口：https://localhost:18042
OHIF：https://localhost:13000
Wazuh 入口：https://localhost:15601
HAPI FHIR：https://localhost:18090/fhir
```

第一次連會出現自我簽署憑證的警告（見下方「HTTPS 與對外 port」），選「進階 → 繼續前往」。

## HTTPS 與對外 port

所有網頁入口都走 https，由 frontend 的 nginx 統一終結 TLS；後端服務（Keycloak、OHIF、
HAPI FHIR、Orthanc、backend、PostgreSQL）都不再直接對外開 port。

```text
瀏覽器 ──https──> nginx（單一 TLS 終結點）──http──> keycloak / ohif / hapi-fhir / orthanc / backend
```

### 憑證

自我簽署，有效期 10 年，SAN 已含 `localhost`、`127.0.0.1`、`192.168.1.122`、
`192.168.1.112`、`192.168.1.105`：

```bash
sh nginx/generate-cert.sh                  # 用預設 IP 清單重新產生
sh nginx/generate-cert.sh 192.168.1.50     # 追加其他 IP / 網域到 SAN
docker compose restart frontend            # 換憑證後要重載 nginx
```

檔案在 `nginx/certs/`（`dicom-portal.crt` / `dicom-portal.key`），以唯讀掛進容器。
因為是自我簽署，瀏覽器第一次連會顯示「不安全」警告，選「進階 → 繼續前往」即可；
正式環境請改用院內 CA 或 Let's Encrypt 簽發的憑證。

### 對外 port

| 用途 | Port | 協定 | 說明 |
| --- | ---: | --- | --- |
| 主入口（電子病歷平台 + 上傳入口 + /api + /fhir + DICOMweb） | `8088` | HTTPS | 日常只需要這個 |
| HTTP 轉址 | `80` | HTTP | 只做 `301 → https://<host>:8088`，不提供任何內容 |
| Keycloak | `8443` | HTTPS | 經 nginx 反向代理，容器本身不對外 |
| OHIF Viewer | `13000` | HTTPS | 經 nginx 反向代理 |
| Orthanc 管理入口 | `18042` | HTTPS | Keycloak 授權閘道，需 `admin` |
| Wazuh Dashboard | `15601` | HTTPS | Keycloak 授權閘道 |
| HAPI FHIR 對外 API | `18090` | HTTPS | Keycloak 授權閘道 |
| Orthanc DICOM | `14242` | DICOM | C-STORE 等影像設備連線 |
| Wazuh agent | `11514` / `11515` / `5514(udp)` | — | agent 連線與 syslog |

已關閉（改由 `docker compose exec` 維修）：

```text
8080   Keycloak 直連      → 改走 https://<host>:8443
18000  Backend 直連       → 改走 https://<host>:8088/api/
15432  PostgreSQL         → docker compose exec postgres psql -U dicom -d dicom_portal
19200  Wazuh Indexer      → docker compose exec wazuh-indexer curl ...
55001  Wazuh Manager API  → docker compose exec wazuh-manager ...
13000  OHIF 容器直連      → 改由 nginx 代理（對外 port 不變，但已是 https）
```

日常網址：

```text
主入口          https://192.168.1.122:8088/        （導向 /his/）
電子病歷平台    https://192.168.1.122:8088/his/
影像上傳管理    https://192.168.1.122:8088/upload/
Keycloak 管理   https://192.168.1.122:8443/admin
Orthanc 管理    https://192.168.1.122:18042
OHIF Viewer     https://192.168.1.122:13000
FHIR base       https://192.168.1.122:8088/fhir（同源）或 https://192.168.1.122:18090/fhir（對外）
Wazuh           https://192.168.1.122:15601
```

### 換 IP 時要一起改的地方

TLS 之後 Keycloak 的 issuer 會變成 `https://<host>:8443/realms/dicom`，
backend 驗證 token 時會比對 issuer，所以換 IP 時要同步：

```text
nginx/generate-cert.sh          把新 IP 加進憑證 SAN
docker-compose.yml              KEYCLOAK_ISSUER / KEYCLOAK_ALLOWED_ISSUERS / CORS_ORIGIN
                                OHIF_VIEWER_URL / DICOMWEB_PUBLIC_URL
keycloak/realm-dicom.json       client 的 redirectUris / webOrigins（或用 kcadm 直接改）
```

前端不用改：`app.js`、`keycloak-auth.js`、OHIF 的 `app-config.js` 都是依當前網址的
protocol 與 hostname 自動組出 Keycloak（https → 8443）與各服務位址。


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
email：customer-a@example.local
tenant_id：tenant-a
roles：viewer, uploader, fhir-user
```

客戶 B：

```text
帳號：customer-b
密碼：customer-b
email：customer-b@example.local
tenant_id：tenant-b
roles：viewer, uploader, fhir-user
```

管理者：

```text
帳號：portal-admin
密碼：portal-admin
roles：admin, viewer, uploader, wazuh-admin, fhir-user, fhir-admin
```

## 登入逾時與閒置登出

登入後不是固定 20 分鐘就踢人，而是以**閒置時間**計算：

```text
有操作（點擊、鍵盤、捲動、觸控）  → 重新計時 20 分鐘
閒置滿 18 分鐘                    → 跳出「是否要延長登入時間？」並倒數 120 秒
按「延長登入時間」                → 換發新 token，重新計時 20 分鐘
倒數歸零或按「立即登出」          → 自動登出，回到登入畫面
```

影像上傳入口與電子病歷交換平台共用同一份登入狀態（`localStorage.tokenSet`），
所以在任一個分頁操作都會一起延長，任一個分頁逾時也會一起登出。

警示跳出後，**滑鼠移動或按鍵不會自動延長**，一定要按按鈕。
這是刻意的：避免無人看顧的診間電腦被碰到就一直維持登入。

實作位置：

```text
frontend/session-timeout.js   閒置計時、警示視窗、自動登出（兩個前端共用）
frontend/app.js               影像入口的接線（onExtend 走 ensureToken(true)）
frontend/his/his.js           電子病歷平台的接線（onExtend 走 KcAuth.refresh()）
```

Keycloak realm 對應設定：

```text
ssoSessionIdleTimeout   1200    伺服器端同樣是閒置 20 分鐘失效
ssoSessionMaxLifespan   36000   單次登入最長 10 小時（只要持續操作就能一直延長）
accessTokenLifespan     1200    access token 20 分鐘，前端會在到期前自動換新
```

`ssoSessionMaxLifespan` 一定要大於 20 分鐘，否則使用者按了「延長」也會因為
Keycloak 端 session 已達上限而換不到新 token。修改匯入檔後要套用到執行中的環境：

```bash
# --server 是容器「內部」的位址，維持 http://localhost:8080 即可（TLS 在 nginx 終結）
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master --user admin --password admin
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/dicom \
  -s ssoSessionIdleTimeout=1200 -s ssoSessionMaxLifespan=36000
```

要改成別的秒數，前端改 `frontend/app.js` 與 `frontend/his/his.js` 的
`idleMs` / `warnMs`，後端改上面兩個 realm 參數，兩邊要一致。

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

1. 開啟 `https://localhost:8443/admin`。
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

1. 開啟 `https://localhost:8443/admin`。
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

9. 從 `https://localhost:8088` 按「SSO 登入」，使用新帳號登入測試。

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

### 上傳後影像清單沒有變動？

`/api/upload` 的回應會說明原因。系統對「同一個 Study」只會在清單保留一列：

```text
record = new       這次真的新增了一筆，影像清單會多一列
record = existing  這個 Study 在你的租戶底下已經有紀錄，沿用舊資料，清單不會變
```

判斷依據是資料庫的唯一鍵 `(tenant_id, orthanc_study_id)`。所以：

- 重複上傳同一份 DICOM（或同一個檢查的其他影像）→ 清單不變，這是正常行為。
- Orthanc 回的 `AlreadyStored` 是「Orthanc 裡已經有這個 instance」，
  和「清單會不會變」不是同一件事：別的租戶上傳過的檢查，你上傳時 Orthanc 會說 `AlreadyStored`，
  但你的租戶還沒有紀錄，清單仍然會多一列。
- 要驗收「新增」流程，請用不同 StudyInstanceUID 的檢查，或先在 Orthanc 管理入口刪掉該 Study 再重傳。

前端上傳結果會直接顯示這段說明，不需要自己讀 JSON。

LINE 通知也跟著這個判斷走：**只有 `record = new` 的檢查會推播**。
重複上傳同一個 Study 不會再發通知，backend log 會記一行
`LINE notification skipped: N duplicate study upload(s)`。
一次上傳整包 ZIP（同一個檢查很多張影像）也只會發一則，不會每張影像各發一次。

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

### 影像歸戶用的 DICOM 查詢

```http
GET /api/imaging/dicom-studies              需要 fhir-user；Orthanc 檢查清單
GET /api/imaging/dicom-studies/{orthanc_id} 需要 fhir-user；單筆的 series / instance 明細
```

回傳的是組 FHIR `ImagingStudy` 需要的 DICOM metadata（Study/Series/SOP Instance UID、
Modality、檢查時間、DICOM 病人資料、影像張數）。`admin` 與 `fhir-admin` 看得到全院檢查，
其他角色只看得到自己租戶的。

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
FHIR base URL：https://localhost:18090/fhir
測試用網頁 UI：https://localhost:18090/
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

| Realm role | `/fhir` REST API | HAPI 內建測試頁（`https://localhost:18090/`） |
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
# --server 是容器「內部」的位址，維持 http://localhost:8080 即可（TLS 在 nginx 終結）
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
curl -i https://localhost:18090/fhir/metadata

# 2. 取得 token
TOKEN=$(curl -sk -X POST https://localhost:8443/realms/dicom/protocol/openid-connect/token \
  -d grant_type=password -d client_id=dicom-portal \
  -d username=portal-admin -d password=portal-admin | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# 3. 讀 CapabilityStatement → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  https://localhost:18090/fhir/metadata

# 4. 建立 Patient（需要 fhir-admin）→ 201
curl -i -X POST https://localhost:18090/fhir/Patient \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/fhir+json" \
  -d '{"resourceType":"Patient","name":[{"family":"Wang","given":["Test"]}]}'

# 5. 查詢
curl -s -H "Authorization: Bearer $TOKEN" "https://localhost:18090/fhir/Patient?family=Wang"
```

只有 `fhir-user` 的帳號執行第 4 步會拿到 `403`，這就是讀寫分權的驗收點。

### 瀏覽器操作

在電子病歷交換平台（`https://localhost:8088/his/`）的上方工具列，有 `admin` / `fhir-admin` 的帳號
會看到 **FHIR Server** 連結。登入時寫入的 `kc_token` cookie 是以主機名為範圍（不分 port），
所以點進 `https://localhost:18090/` 的 HAPI 測試頁時會自動帶上，不需要再登入一次。
沒有 `fhir-admin` 的帳號會被導回 `https://localhost:8088`。

測試頁上顯示的 **FHIR Base** 會是 `http://localhost:8080/fhir`，這是正常的：那是測試頁的 Java 程式
在容器內部自己要連的位址（設定在 `fhir/application.yaml` 的 `tester.home.server_address`），
不能填對外網址，否則容器內連不到會出現 `Failed to load conformance statement ... Connection refused`。

**外部程式要用的 FHIR base 一律是 `http://<host>:18090/fhir`**，例如：

```text
https://localhost:18090/fhir
https://192.168.1.112:18090/fhir
```

走 `:18090` 的請求，HAPI 會依 Nginx 帶進來的 `X-Forwarded-Host` 產生正確的 `fullUrl` 與
`Location` header，所以 localhost 與區網 IP 兩種進入點都不需要另外設定。

### 尚未做的事

- HAPI 端沒有做 tenant 隔離：有 `fhir-user` 就看得到全部 FHIR 資源。若要做到跟 DICOM 清單一樣的
  租戶隔離，需要另外用 partitioning 或在閘道加上 `tenant_id` 對應規則。
- DICOM study 尚未自動轉成 FHIR `ImagingStudy`。目前兩邊是各自獨立的資料。
- HAPI 內建測試頁沒有經過 Nginx 的讀寫檢查，目前是用「只給 fhir-admin」規避。若之後要讓 `fhir-user`
  也能用圖形介面查資料，應改成關掉內建測試頁，另外做一個走 `/fhir` REST API 的前端頁面。

## 電子病歷交換平台（FHIR Portal）

依衛生福利部「電子病歷交換單張實作指引（EMR IG）」與 TW Core 建置的 HIS 風格前端，
帳號與讀寫權限一樣由 Keycloak 控管。

```text
入口：https://localhost:8088/his/
規格：https://twcore.mohw.gov.tw/ig/emr/
```

主入口就是這個平台；DICOM 影像上傳管理入口在 `/upload/`，兩邊的上方工具列可以互相切換，登入狀態共用。

### 畫面與功能

```text
病人主檔    姓名 / 病歷號 / 身分證字號查詢，病人清單
病歷檢視    病人資訊帶 + 過敏警示 +（臨床總覽／就診紀錄／檢驗檢查／用藥處方／醫療影像／交換單張）
交換單張    全院 Composition 清單，點入即以 $document 組成 EMR IG 交換 Bundle，可列印、可下載 JSON
醫療影像    ImagingStudy 清單，可直接跳 OHIF 開圖
檢驗檢查    全院 Observation(laboratory) 清單，自動標示超出參考值的項目
伺服器資訊  CapabilityStatement、各資源筆數、目前使用者的 Keycloak role 與 FHIR 權限
```

每一張卡片、每一列資料都有「FHIR」按鈕，可直接看該筆資源的原始 JSON，方便驗收時對照規格。

### 六種交換單張與 FHIR 資源對照

| EMR IG 單張 | LOINC | 主要 FHIR 資源 | 本系統 |
| --- | --- | --- | --- |
| 門診病歷 PMR | 34117-2 | Composition, Encounter, Condition, ClinicalImpression(S/O/A), Procedure, MedicationRequest, Observation, AllergyIntolerance, Coverage | ✅ 可檢視 / 可產生 |
| 檢驗檢查 IC | 11502-2 | Composition, Observation, Specimen, Encounter, Practitioner | ✅ 可檢視 / 可產生 |
| 電子處方箋 EP | 57833-6 | Composition, MedicationRequest, Medication, Condition, Coverage | ✅ 可檢視 / 可產生 |
| 出院病摘 DMS | 18842-5 | Composition, Encounter, Condition, Procedure, CarePlan, Observation | ✅ 可檢視 / 可產生 |
| 醫療影像及報告 Image | 18748-4 | Composition, ImagingStudy, DiagnosticReport, Observation, Endpoint | ✅ 可檢視（影像接 Orthanc / OHIF） |
| 調劑單張 DS | — | MedicationDispense 等 | ⬜ 尚未實作 |

所有寫入的資源都會帶 `meta.profile` 指向 EMR IG 的 StructureDefinition，例如
`https://twcore.mohw.gov.tw/ig/emr/StructureDefinition/PMRComposition`。

### 權限

沿用 HAPI FHIR 的兩個 role，前端與後端各擋一層：

| Role | 平台行為 |
| --- | --- |
| 無 FHIR role | 登入後停在閘門畫面，提示請管理者指派角色 |
| `fhir-user` | 可查詢全部畫面；建檔按鈕不顯示，直接呼叫寫入 API 也會被 Nginx 擋成 403 |
| `fhir-admin` / `admin` | 可新增病人、開立就診／處方／檢驗、產生交換單張 |

前端隱藏按鈕只是介面行為，真正的權限在 `backend /api/auth/fhir`：
`GET` 只要 `fhir-user`，`POST/PUT/PATCH/DELETE` 一定要 `fhir-admin`。

### 灌入示範資料

```bash
python3 fhir/seed/seed_emr.py
```

會寫入 53 筆符合 EMR IG 的資源（4 位病人、6 張交換單張），用固定 id 以 PUT 寫入，重複執行不會產生重複資料。
只用 Python 標準函式庫，不需要額外安裝套件。

```text
王大明  高血壓 + 糖尿病門診：門診病歷、檢驗檢查、電子處方箋三張單張
李淑芬  胸部 X 光：ImagingStudy + DiagnosticReport + Endpoint（醫療影像及報告單張）
張家豪  急性闌尾炎住院手術：出院病摘單張
陳美玲  心臟衰竭慢性病追蹤：門診病歷單張
```

要換伺服器或改用區網 IP：

```bash
python3 fhir/seed/seed_emr.py --base https://192.168.1.112:18090/fhir --keycloak http://192.168.1.112:8080
python3 fhir/seed/seed_emr.py --dry-run     # 只印 JSON 不寫入，可用來對照規格
```

### 建檔流程

以 `fhir-admin` 登入後：

```text
新增病人      建立 Patient（身分證 identifier 用 http://www.moi.gov.tw，病歷號用 type=MR）
新增門診就診  一次 FHIR transaction 建立 Encounter + Condition + ClinicalImpression(S/O/A)
開立處方      一次 transaction 建立 Medication + MedicationRequest
新增檢驗報告  Specimen + Observation（含多個 component），可一併產生檢驗檢查單張
影像歸戶      Orthanc 檢查 → ImagingStudy + DiagnosticReport + Observation + Endpoint
新增交換單張  逐筆勾選要納入的資料組成 Composition，再用 $document 匯出交換 Bundle
```

### 同源 FHIR 入口

Portal 走 `https://localhost:8088/fhir`（與網頁同源，避免瀏覽器 CORS），
外部系統走 `https://localhost:18090/fhir`。兩條路徑的授權檢查完全相同，
都是 Nginx `auth_request` → `backend /api/auth/fhir`。

```text
瀏覽器 /his/  →  同源 /fhir   →  auth_request  →  HAPI FHIR
外部程式      →  :18090/fhir  →  auth_request  →  HAPI FHIR
```

### 檢驗檢查輸入頁

入口：左側「檢驗檢查」→「＋ 新增檢驗報告」（需 `fhir-admin`）。
病歷內的檢驗分頁按「＋ 登錄檢驗結果」開的是同一張表單，只是會自動帶入該病人。

```text
一、病人與開單   搜尋病人（姓名/病歷號/身分證）、關聯就診、檢驗時間、檢驗人員
二、檢體         檢體種類（靜脈全血/血清/血漿/尿液/痰液/組織）、採檢時間、採檢部位 → Specimen
三、檢驗項目     常用套組一鍵帶入（CBC／生化／肝功能／尿液常規），
                 明細以表格逐列輸入 LOINC、項目名稱、結果、單位、參考值，可自由增刪列
四、判讀與單張   整體判讀（正常/偏高/偏低/異常）、備註、是否同時產生檢驗檢查交換單張
```

結果欄留白的列不會寫入，方便先把套組帶出來再填有做的項目。
送出後以一個 transaction 寫入 `Specimen` + `Observation`（+ `Composition`），
超出參考值的項目在病歷與單張上會自動標紅並標示 H / L。

### 電子病歷交換單張輸入頁

入口：左側「交換單張」→「＋ 新增交換單張」（需 `fhir-admin`）。

```text
一、病人與就診   搜尋病人；選了就診就只列出該次就診的資料，不選則列出病人全部資料
二、單張類型     門診病歷 PMR／檢驗檢查 IC／電子處方箋 EP／出院病摘 DMS／醫療影像及報告 IMG
                 撰寫醫師
三、納入內容     依單張類型自動列出各章節可納入的資源，逐筆勾選（預設全選）
```

第三段是這頁的重點：它會依 EMR IG 各單張的章節定義，把病人已有的診斷、SOAP、處方、
檢驗、處置、過敏、就醫身分別、影像、出院指示分別放進對應章節，每一筆都有勾選框，
只有勾選的會寫進 `Composition.section.entry`。切換單張類型時清單會即時重算。

過敏史、就醫身分別、檢體屬於病人層級的資料，選了就診也不會被過濾掉。

產生後直接跳到單張檢視頁，可列印或用 `$document` 下載交換 Bundle。

原本在病歷「就診紀錄」列上的「產生單張」仍然保留，那是快捷版：
直接把該次就診的資料全部納入，不用逐筆勾選。

### Orthanc 影像如何連動到 FHIR

上傳到 Orthanc 的 DICOM 不會自動變成 FHIR 資源——DICOM 沒有院內病歷號與 FHIR Patient 的對應關係，
也沒有影像報告，這兩件事一定要有人決定。平台提供「影像歸戶」介面來完成這件事：

```text
DICOM 上傳 → Orthanc（影像本體）
                ↓  backend /api/imaging/dicom-studies 讀出 DICOM metadata
        電子病歷交換平台「影像歸戶」介面
                ↓  選擇對應病人、填寫檢查與報告
        FHIR transaction 一次寫入
                ↓
   ImagingStudy + DiagnosticReport + Observation + Endpoint（+ Composition 交換單張）
                ↓
   病歷「醫療影像」分頁可看報告，並用 Study Instance UID 直接開 OHIF 看片
```

影像本體仍然只存在 Orthanc，FHIR 只存「索引與報告」，靠 `ImagingStudy.identifier`
（`urn:dicom:uid` = Study Instance UID）與 `Endpoint.address`（DICOMweb 位址）指回 PACS，
這是 EMR IG 醫療影像及報告單張的作法。

### 影像歸戶操作

入口：左側「影像歸戶」，或「醫療影像」頁右上角的按鈕。

清單會列出 Orthanc 內所有 DICOM 檢查（`admin` / `fhir-admin` 看全院，其他人只看自己租戶），
並標示每筆是「已建立」或「未歸戶」。點「建立 FHIR 影像紀錄」後的輸入介面分四段：

```text
一、對應病人   搜尋既有病人（姓名/病歷號/身分證），或依 DICOM 資料建立新病人；
               可選擇要掛在哪一次就診（Encounter）
二、檢查資訊   檢查項目名稱、ICD-10-PCS 代碼、檢查部位、Modality、Accession No.、檢查時間
               （Modality、時間、系列與影像數都由 DICOM 自動帶入）
三、影像報告   報告醫師、報告狀態（final / preliminary / registered）、影像所見、結論
四、交換單張   勾選後同時產生「醫療影像及報告」交換單張（Composition）
```

DICOM 上的病人姓名常常和院內病歷姓名不同（例如英文名或代號），
所以搜尋若查無結果會自動改列出最近建檔的病人讓你挑，不會卡住。

送出後會以一個 FHIR transaction 一次寫入，全部成功或全部不寫入。
寫入的資源與 EMR IG profile 對應：

| 資源 | Profile | 內容 |
| --- | --- | --- |
| ImagingStudy | `ImagingStudyBase` | Study/Series/Instance UID、Modality、系列與影像數、Endpoint |
| DiagnosticReport | `DiagnosticReport-Image` | 報告狀態、判讀醫師、結論，連到 ImagingStudy 與 Observation |
| Observation | `Observation-Imaging-Result` | 影像所見（valueString） |
| Endpoint | `MitwEndpoint` | DICOMweb 位址，預設 `https://<host>:8088/dicom-web` |
| Composition | `ImageComposition` | 醫療影像及報告交換單張（選填） |

歸戶後在病人的「醫療影像」分頁就會看到報告，並可按「在 OHIF 開啟」直接看片——
因為 UID 是真的 Orthanc 檢查，OHIF 會透過同一套 Keycloak 授權的 DICOMweb 取得影像。

重複歸戶保護：清單會先查 `ImagingStudy?identifier=urn:dicom:uid|...`，
已經建立過的檢查會標示「已建立」而不再出現建立按鈕。

DICOMweb 對外位址若不是預設值（例如改用區網 IP），在 `.env` 設定：

```bash
DICOMWEB_PUBLIC_URL=https://192.168.1.112:8088/dicom-web
```

### 與 DICOM / 影像系統的關係

真實影像請用上面的「影像歸戶」建立 FHIR 紀錄，UID 會直接取自 Orthanc，OHIF 就能開圖。
seed 出來的示範影像（李淑芬那筆）用的是規格範例 UID，Orthanc 內沒有對應影像，
點 OHIF 會顯示查無資料，這是預期的。

### 已知限制

- 沒有做租戶隔離：有 `fhir-user` 就看得到全部病人（與 HAPI FHIR 章節的限制相同）。
- 產生單張時只納入「該次就診」關聯到的資源；沒有指定 Encounter 的處方或檢驗不會被收進去。
- 尚未實作調劑單張（DS）與 IG 的 FHIR Validator 驗證，`meta.profile` 只是標註，沒有做結構驗證。
- 示範資料的醫事機構代碼、醫師證號、藥品許可證字號皆為虛構，僅供介面與流程驗收使用。

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

因此日常使用時請從 `https://localhost:8088` 先用 Keycloak SSO 登入；有 Wazuh 權限的使用者會看到
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

7. **電子病歷交換平台的資料驗證**
   - 目前 `meta.profile` 只是標註，沒有跑 IG 的 FHIR Validator。
   - 正式交換前應以官方 Validator 或 HAPI Validation 驗證單張結構與必填欄位。

8. **FHIR 資料的租戶隔離**
   - 目前只要有 `fhir-user` 就看得到全部 FHIR 資源。
   - 正式版建議用 HAPI 的 partitioning（一個租戶一個 partition），或在授權閘道依 `tenant_id` 限制可存取的 compartment。
   - 也要記錄誰在何時讀寫了哪些 FHIR 資源。

## 目錄說明

```text
backend/
  FastAPI 後端
frontend/
  靜態前端（主入口 / 會導向 his）
frontend/his/
  電子病歷交換平台（FHIR Portal）前端，也是主入口
frontend/upload/
  DICOM 影像上傳管理入口
frontend/keycloak-auth.js
  兩個前端共用的 Keycloak PKCE 登入模組
frontend/session-timeout.js
  兩個前端共用的閒置逾時警示與自動登出
keycloak/
  realm 匯入檔，含測試帳號與 roles
orthanc/
  Orthanc 設定檔
nginx/
  前端 Nginx 設定
fhir/
  HAPI FHIR server 的 Spring 設定（application.yaml）
fhir/seed/
  EMR IG 示範資料 seed 腳本
postgres/
  PostgreSQL 初始化 SQL（建立 hapi 資料庫）
docker-compose.yml
```

## 與 OHIF 整合

清單 API 會產生：

```text
https://localhost:13000/viewer/<StudyInstanceUID>
```

本機開發環境會啟動 OHIF viewer，並透過 frontend Nginx 將 `https://<host>:8088/dicom-web/`
代理到 Orthanc DICOMweb。DICOMweb / WADO 入口會先呼叫 backend 驗證 Keycloak Bearer token，
使用者必須具備 `viewer` role 才能讀取影像；Nginx 只會在通過驗證後，於內部補 Orthanc basic auth。

Orthanc 管理 UI 也透過 frontend Nginx 暴露在 `https://localhost:18042`，每個請求都會先呼叫
backend 驗證 Keycloak token，且使用者必須具備 `admin` role。真正的 Orthanc HTTP port 不直接暴露到 host。

OHIF viewer 本機開發網址：

```text
https://localhost:13000
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

- `admin / admin` 是 Keycloak 管理後台帳號，只能用在 `https://localhost:8443/admin`。
- `customer-a / customer-a`、`customer-b / customer-b`、`portal-admin / portal-admin` 是 `dicom` realm 的測試客戶帳號，請從 `https://localhost:8088/`（電子病歷交換平台）或 `https://localhost:8088/upload/`（影像上傳）按「SSO 登入」進入，不要在 Keycloak 管理後台登入。
- 若之前啟動過舊版容器，請用 `docker compose down -v` 清掉舊資料後再 `docker compose up --build`，避免 realm 沒有重新匯入。
- 新增的 `fhir-user` / `fhir-admin` role 需要 Keycloak 重新匯入 realm 才會出現。因為 `keycloak` 服務沒有掛 volume，重建容器就會重新匯入：`docker compose up -d --force-recreate keycloak`。
- 主入口 `https://<host>:8088/` 會導向電子病歷交換平台 `/his/`；DICOM 影像上傳管理入口在 `/upload/`。
- 上傳入口右上角只留「Orthanc 管理」（需 `admin`）與「電子病歷交換平台」（需 `fhir-*`）。
- 「Keycloak 管理」與「FHIR Server」移到電子病歷交換平台的上方工具列，同樣依 role 顯示：
  Keycloak 管理需 `admin`，FHIR Server 需 `admin` / `fhir-admin`。沒有 role 的人看不到，也打不進去（後端與 Nginx 會擋）。
- `customer-a` / `customer-b` 已補上 email，可以用 password grant 直接換 token 測 API。若你的環境是舊的 realm 匯入檔，這兩個帳號會因為沒有 email 而回 `Account is not fully set up`，重建 Keycloak 容器或在管理後台補上 email 即可。
- 登入後閒置 18 分鐘會跳出「是否要延長登入時間？」，20 分鐘沒有動作才自動登出；有在操作就會一直延長。
- 驗收權限差異最快的方式：`portal-admin` 有 `fhir-admin` 可以建檔，`customer-a` 只有 `fhir-user`，登入 `https://localhost:8088/his/` 後看不到任何建檔按鈕。
