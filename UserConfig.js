const CEC_PERMISSION_CONFIG =
#權限與功能配置檔

[Permissions]
# ---------------------------------------------------------
Admin: ALL

# ---------------------------------------------------------
PCA: ALL

# ---------------------------------------------------------
# CRG: 客服與查詢人員
# 擁有除了 "PCA 與特殊案件邏輯" 以外的所有功能
CRG: feat_iwt_buttons, feat_iwt_auto_execute, feat_quick_action_buttons, autoSaveAfterQuickAction, autoScrollAfterActionButtons, autoAssignUser, feat_template_shortcuts, feat_manual_convert_btns, feat_auto_convert, postInsertionEnhancementsEnabled, autoIVPQueryEnabled, autoWebQueryEnabled, autoSwitchEnabled, feat_datatable_ivp_btns, blockIVPCard, accountHighlightMode, feat_suspended_blocker, feat_contact_copy, feat_modal_table_enhance, autoLinkContactOnCopy, sentinelCloseEnabled, followUpPanelEnabled, feat_followup_set_time, feat_followup_send_intercept, notifyOnRepliedCaseEnabled, highlightExpiringCasesEnabled, feat_change_owner_menu, feat_related_cases_extractor, autoLoadAllUpdates, cleanModeEnabled, feat_header_case_copy, feat_compose_btn_alert, feat_associate_btn_alert, feat_desc_height_adjust, feat_top_control_btns, feat_export_config, feat_export_reports

# ---------------------------------------------------------
# Guest: 預設/新手角色
# 僅保留自動指派、模態框按鈕、彈窗表格增強、以及 IVP/Web 查詢相關功能
Guest: autoAssignUser, feat_quick_action_buttons, feat_modal_table_enhance, autoIVPQueryEnabled, autoWebQueryEnabled, autoSwitchEnabled, feat_datatable_ivp_btns

[Users]
# 定義各角色包含的人員 (請填寫與 Case Owner 完全一致的名稱)
Admin: Jerry Law
PCA: Alice Wong, Bob Chen
CRG: David Lee, Eva Green
`;


/*
腳本全功能原子化清單 (共 8 大模組，40 項獨立功能)
🤖 自動化與快捷操作 (Automation & Quick Actions)
feat_iwt_buttons: I Want To 快捷按鈕顯示 (決定是否在頁面注入 Re-open, Close, Doc Contact 按鈕)。
feat_iwt_auto_execute: I Want To 自動執行邏輯 (若關閉，點擊按鈕可能只會幫忙選單，不會自動點擊 Submit)。
feat_quick_action_buttons: 模態框快捷按鈕顯示 (運輸、清關、派送等按鈕的注入)。
autoSaveAfterQuickAction: 快捷按鈕自動保存 (點擊快捷按鈕後是否允許自動觸發 Save)。
autoScrollAfterActionButtons: 快捷按鈕注入後自動下移網頁 (點擊後自動將畫面下捲 111px)。
autoAssignUser: 自動指派 (Auto Assign) (進入 Case 時，若 Owner 不是自己，是否自動點擊 Assign to me)。

📝 富文本編輯器與模版 (Editor & Templates)
feat_template_shortcuts: 模版快捷按鈕顯示 (編輯器下方的前 5 個常用模版按鈕)。
feat_manual_convert_btns: 手動繁簡轉換按鈕 (顯示 [轉繁] / [轉簡] 按鈕)。
feat_auto_convert: 自動繁簡轉換引擎 (包含貼上攔截、打字實時轉換。若關閉，即使點了模版也不會啟動底層轉換監聽)。
postInsertionEnhancementsEnabled: 模版插入後增強處理 (包含光標精準定位與智能粘貼)。

🔍 外部查詢與 IVP (External Queries)
autoIVPQueryEnabled: 自動查詢 IVP (檢測到 1Z 追蹤號時，是否自動發送 postMessage 給 IVP 視窗)。
autoWebQueryEnabled: 自動查詢官網 (是否自動發送 postMessage 給 UPS 官網視窗)。
autoSwitchEnabled: 自動切換至 IVP 視窗 (檢測到追蹤號後，是否自動將焦點切換至 IVP 視窗)。
feat_datatable_ivp_btns: 列表 IVP/Web 按鈕注入 (在 Related Cases 或其他表格中注入單行的 IVP/Web 查詢按鈕)。
blockIVPCard: 屏蔽原生 IVP 卡片 (是否允許腳本移除 Salesforce 原生的 IVP iframe)。

🚨 PCA 與特殊案件邏輯 (PCA & Special Cases)
pcaDoNotClosePromptEnabled: 預付/開查 Do Not Close 彈窗提示 (點擊 Send 時的攔截警告)。
pcaCaseListHintEnabled: 列表頁開查/預付時間標籤 (在 My Open Cases 列表中顯示「預付 - 3天2時」等標籤)。
pcaQueueHighlightEnabled: 非 Chinese Queue 高亮與一鍵轉派 (進入 Case 時檢查 Most Recent Queue 並標紅)。
feat_pca_list_sort: PCA 列表排序按鈕 (列表頁的「PCA提示排序」按鈕)。

👥 聯繫人與帳戶處理 (Contact & Account)
accountHighlightMode: 帳戶背景高亮 (根據 Preferred 狀態標示 Moccasin 顏色，支援 PCA/Dispatch 模式)。
feat_suspended_blocker: Suspended 帳戶攔截 (檢測到 Suspended 時，自動將 Schedule a Pickup 按鈕標紅並禁用)。
feat_contact_copy: 聯繫人卡片點擊複製 (點擊姓名、電話、郵箱自動複製)。
feat_modal_table_enhance: Associate Contact 彈窗表格增強 (重排表格欄位順序，並將匹配 1Z 追蹤號的行標示黃底)。
autoLinkContactOnCopy: Associate Contact 自動關聯 (在彈窗中點擊姓名複製後，是否自動點擊 Link Contact)。
sentinelCloseEnabled: Link Contact 快速關閉 (點擊 Link 後是否使用 CSS 強制隱藏彈窗)。

📅 跟進與提醒系統 (Follow-up & Notifications)

followUpPanelEnabled: 跟進面板顯示 (右下角懸浮面板與 Case 內的嵌入面板)。
feat_followup_set_time: 設定跟進時間按鈕 (在 Case 標題旁的 📅 按鈕)。
feat_followup_send_intercept: 發送時跟進記錄刪除提示 (點擊 Send 時，若 Case 在面板中，提示是否刪除)。
notifyOnRepliedCaseEnabled: 近期已回覆提示 (發送後 10 小時內再次進入 Case 時的巨大中央提示)。
highlightExpiringCasesEnabled: 快過期 Case 標紅 (列表頁 Importance 欄位非 Priority 時標紅)。

🔄 介面增強與轉派 (UI Enhancements & Routing)

feat_change_owner_menu: Change Owner 懸浮菜單 (包含 MRU、右鍵貼上等進階轉派功能)。
feat_related_cases_extractor: Related Cases 數據提取與排序 (自動展開行並提取 Owner/Queue)。
autoLoadAllUpdates: 自動加載 Updates (背景無感加載 5 頁 Feed)。
cleanModeEnabled: 組件屏蔽 (Clean Mode) (隱藏頂部面板、側邊欄等)。
feat_header_case_copy: 頂部 Case 號碼精準複製 (滑鼠懸停標題時變半透明，點擊精準複製 C-xxxxxxxxxx)。
feat_compose_btn_alert: Compose 按鈕超期標紅 (檢測到 Milestone 超時，自動將回覆按鈕標紅)。
feat_associate_btn_alert: Associate 按鈕關聯案件標紅 (當 Related Cases 數量大於 0 時，將按鈕與標籤標紅提示)。
feat_desc_height_adjust: Case 描述框高度調整 (強制撐開 Description 欄位的高度)。
feat_top_control_btns: 頂部控制按鈕 (在 Salesforce 頂部 Logo 旁注入設置與暫停按鈕)。

💾 數據管理 (Data Management)
feat_export_config: 導出配置/匯入配置 (JSON 格式的設定檔備份與還原)。
feat_export_reports: 導出報表 (導出跟進名單與活動紀錄的 CSV 檔案)。
*/


