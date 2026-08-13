-- 只有在 postgres_data volume 第一次建立時才會執行。
-- 既有環境請手動執行：
--   docker compose exec postgres psql -U dicom -d dicom_portal -c "CREATE DATABASE hapi OWNER dicom;"
CREATE DATABASE hapi OWNER dicom;
