# 地端 Gmail 寄信修復

適用主機：192.168.50.192。此程序會變更正式 SMTP 設定，與只讀驗收不同。

1. 登入準備作為寄件者的 Gmail 帳戶，開啟兩步驟驗證。
2. 開啟 https://myaccount.google.com/apppasswords ，建立名稱「巡檢系統」的應用程式密碼。
3. 在正式主機桌面雙擊「巡檢 Gmail 寄信修復」。
4. `Sender Gmail address` 輸入完整的 Gmail 信箱；`Google app password (hidden)` 輸入剛產生的 16 碼應用程式密碼，按 Enter。不要輸入一般 Google 密碼，也不要把應用程式密碼貼入對話。
5. 程序完成後會同時產生 `Inspection-maintenance/gmail-repair-latest.json` 及更新 `local-cutover-latest.json`，供維護人員讀回。

程序使用 smtp.gmail.com:587、驗證憑證的 STARTTLS。Gmail 認證通過後，備份既有 `.env`，只修改 SMTP 六個欄位；Compose 解析結果如有非 SMTP 變更即還原並拒絕重啟。只重建 auth 服務、不拉取映像、不重啟資料庫。套用後核對 Auth 健康、SMTP 值及容器 DNS；失敗時還原原設定與 Auth，若偵測到外部同時變更則保留現況並報告。

帳號／密碼由主機輸入；新憑證只保存於 WSL 正式 `.env`，權限 0600。原設定備份目錄權限 0700、檔案 0600；報告不含帳號、密碼、原始錯誤或設定內容。

`configured` 僅代表設定、TLS 認證及 Auth 檢查通過。此工具不寄送郵件；仍需在正式站使用「忘記密碼」確認收信、連結與更新後登入，才能完成寄信功能驗收。

如 Google 帳戶未提供應用程式密碼，先確認兩步驟驗證及帳戶政策；不要改用一般密碼或關閉 TLS。官方說明：https://support.google.com/mail/answer/185833?hl=zh-Hant
