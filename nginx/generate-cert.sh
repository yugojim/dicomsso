#!/bin/sh
# 產生自我簽署憑證（預設 10 年）給 nginx 使用。
#
#   sh nginx/generate-cert.sh                      # 用預設的 IP 清單
#   sh nginx/generate-cert.sh 192.168.1.50 my-host # 自行指定要放進 SAN 的 IP / 網域
#
# 憑證是自我簽署的，瀏覽器第一次開會出現警告，選「進階 → 繼續前往」即可。
# 正式環境請改用院內 CA 簽發或 Let's Encrypt。
set -e

DIR="$(dirname "$0")/certs"
DAYS=3650                     # 10 年
CN="${1:-192.168.1.122}"

mkdir -p "$DIR"

# 預設 SAN：本機 + 常用的區網 IP；後面接的參數會一併加入
ALT="DNS:localhost,IP:127.0.0.1,IP:192.168.1.122,IP:192.168.1.112,IP:192.168.1.105"
for host in "$@"; do
  case "$host" in
    *[!0-9.]*) ALT="$ALT,DNS:$host" ;;   # 含非數字與點 → 當網域
    *)         ALT="$ALT,IP:$host" ;;    # 純數字與點 → 當 IP
  esac
done

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$DIR/dicom-portal.key" \
  -out "$DIR/dicom-portal.crt" \
  -days "$DAYS" -sha256 \
  -subj "/C=TW/ST=Taipei/L=Taipei/O=Demo Medical Center/OU=IT/CN=$CN" \
  -addext "subjectAltName=$ALT" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=digitalSignature,keyEncipherment,keyCertSign"

chmod 600 "$DIR/dicom-portal.key"

echo "已產生憑證："
# 用 -text 取代 -ext：macOS 內建的是 LibreSSL，不支援 openssl x509 -ext
openssl x509 -in "$DIR/dicom-portal.crt" -noout -subject -dates
openssl x509 -in "$DIR/dicom-portal.crt" -noout -text | grep -A 1 "Subject Alternative Name"
