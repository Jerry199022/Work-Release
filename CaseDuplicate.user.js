// ==UserScript==
// @name         Case查重與指派分析
// @namespace    Case duplicate and find A/C
// @version      V56
// @description  集成Case查重、指派分析、自動標示與緩存功能。新增全自動分派購物車(跨框架、自動分包)與今日記錄模組。
// @author       Jerry Law
// @match        https://*.force.com/*
// @match        https://*.salesforce.com/*
// @match        https://*.vf.force.com/*
// @match        https://*.lightning.force.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @license      Proprietary; authorized for internal company business processes only; modification or redistribution is strictly prohibited.
// @updateURL    https://github.com/Jerry199022/Work-Release/raw/refs/heads/main/CaseDuplicate.user.js
// @downloadURL  https://github.com/Jerry199022/Work-Release/raw/refs/heads/main/CaseDuplicate.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ✨ 核心優化：輕量級反休眠引擎 (Lightweight Keep-Alive)
    // 解決：避免強改渲染引擎導致 Salesforce 灰屏崩潰，同時保持網路連線活躍
    function injectBackgroundKeepAlive() {
        const code = `
            try {
                // 僅攔截 visibilitychange，防止 Salesforce 偵測到背景而中斷網路 GraphQL 請求
                Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
                Object.defineProperty(document, 'hidden', { get: () => false });

                window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
                document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

                console.log("[反休眠引擎] 輕量級掛載成功！(已移除危險的 rAF 攔截，徹底解決灰屏問題)");
            } catch(e) {}
        `;
        const script = document.createElement('script');
        script.textContent = code;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    }
    injectBackgroundKeepAlive();

    /**
     * Visualforce 框架自動化處理器 (Change Owner 頁面專用)
     * 負責在進入 VF 頁面後，自動尋找節點、填入名稱、校驗並提交
     */
    class VFChangeOwnerOptimizer {
        constructor() {
            this.autorun = GM_getValue('salesforce_assign_autorun', { active: false });
            if (this.autorun.active && this.autorun.assignee) {
                this.initiateHandshakeAndRun();
            }
        }

        // ✨ 新增：跨域頁籤握手驗證機制
        async initiateHandshakeAndRun() {
            console.log(`[自動分派引擎] VF環境已啟動，正在進行分頁安全指紋驗證...`);
            const isTabMatched = await this.verifyTabIdentity();

            if (!isTabMatched) {
                console.log(`[自動分派引擎] 🔒 指紋驗證失敗！判定此為手動開啟的 VF 頁面，自動填寫已靜默退出。`);
                return;
            }

            console.log(`[自動分派引擎] ✅ 驗證通過，準備分派給：${this.autorun.assignee}`);
            this.executeAutoFill();
        }

        verifyTabIdentity(timeout = 1500) {
            return new Promise((resolve) => {
                if (!this.autorun.tabLock) return resolve(true); // 相容無 tabLock 的狀況

                if (window === window.top) {
                    console.warn("[自動分派引擎] 當前 VF 不在 iframe 內，為了防竄車安全，拒絕自動分派。");
                    return resolve(false);
                }

                let isResolved = false;
                const timer = setTimeout(() => {
                    if (!isResolved) {
                        isResolved = true;
                        window.removeEventListener('message', messageHandler);
                        console.warn("[自動分派引擎] 請求分頁指紋超時，判定為非授權頁籤。");
                        resolve(false);
                    }
                }, timeout);

                const messageHandler = (event) => {
                    if (event.data && event.data.action === 'RESPONSE_SF_TAB_ID') {
                        isResolved = true;
                        clearTimeout(timer);
                        window.removeEventListener('message', messageHandler);

                        if (event.data.tabId === this.autorun.tabLock) {
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    }
                };

                window.addEventListener('message', messageHandler);
                window.top.postMessage({ action: 'REQUEST_SF_TAB_ID' }, '*');
            });
        }

        async waitForElement(selector, timeout = 10000) {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                const el = document.querySelector(selector);
                if (el) return el;
                await new Promise(res => setTimeout(res, 200));
            }
            return null;
        }

        createStatusPanel(targetName) {
            const panel = document.createElement('div');
            panel.id = 'vf-auto-status-panel';
            panel.style.cssText = `
                position: fixed; top: 60px; left: 50%; transform: translateX(-50%);
                background-color: #0070d2; color: #ffffff; padding: 10px 20px;
                border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 10px;
                pointer-events: none; transition: background-color 0.3s;
            `;

            const remainingCount = this.autorun.remaining !== undefined ? this.autorun.remaining : 0;
            const remainingText = remainingCount > 0 ? `，剩餘 ${remainingCount} 筆` : '';

            panel.innerHTML = `
                <div class="sf-spinner" style="width:14px; height:14px; border:2px solid #fff; border-top:2px solid transparent; border-radius:50%; animation: sf-spin 1s linear infinite;"></div>
                <div id="vf-status-text">自動分派中 (目標: ${targetName}${remainingText})</div>
                <style>@keyframes sf-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
            `;
            document.body.appendChild(panel);

            const stopBtn = document.getElementById('vf-instant-stop');
            if (stopBtn) {
                stopBtn.onclick = () => {
                    console.log("[自動分派引擎] 使用者點擊懸浮終止，正在執行硬煞車並返回...");
                    GM_setValue('salesforce_assign_autorun', { active: false });
                    this.updateStatus('分派已終止，正在退回...', 'error');

                    const cancelBtn = document.getElementById('j_id0:form:j_id3:j_id100:cancelButton');
                    if (cancelBtn) {
                        cancelBtn.click();
                    } else {
                        window.location.reload();
                    }
                };
            }
            return panel;
        }

        updateStatus(text, type = 'info') {
            const textEl = document.getElementById('vf-status-text');
            const panel = document.getElementById('vf-auto-status-panel');
            if (textEl) textEl.textContent = text;
            if (panel && type === 'error') {
                panel.style.backgroundColor = '#c23934';
                const spinner = panel.querySelector('.sf-spinner');
                if (spinner) spinner.style.display = 'none';
            }
        }

        checkActive() {
            const current = GM_getValue('salesforce_assign_autorun', { active: false });
            if (!current.active) {
                console.log("[自動分派引擎] 偵測到中斷訊號，拒絕後續操作。");
                const cancelBtn = document.getElementById('j_id0:form:j_id3:j_id100:cancelButton');
                if (cancelBtn) cancelBtn.click();
                return false;
            }
            return true;
        }

        async executeAutoFill() {
            const rawAssignee = this.autorun.assignee;
            let targetType = 'User';
            let targetName = rawAssignee;

            if (rawAssignee.startsWith('Q:')) {
                targetType = 'Queue';
                targetName = rawAssignee.substring(2);
            } else if (rawAssignee.startsWith('U:')) {
                targetType = 'User';
                targetName = rawAssignee.substring(2);
            }

            this.createStatusPanel(targetName);
            if (!this.checkActive()) return;

            // ✨ 修復 1：智能下拉選單匹配 (防止變空白)
            const typeSelect = await this.waitForElement('select[id$=":ownerfield_mlktp"], select[name*="ownerfield_mlktp"]', 2000);
            if (typeSelect) {
                let targetOptionValue = null;
                Array.from(typeSelect.options).forEach(opt => {
                    // 比對選項的文字或值 (忽略大小寫)，確保抓到 Salesforce 真實的內部 value
                    if (opt.text.toLowerCase() === targetType.toLowerCase() || opt.value.toLowerCase() === targetType.toLowerCase()) {
                        targetOptionValue = opt.value;
                    }
                });

                if (targetOptionValue && typeSelect.value !== targetOptionValue) {
                    this.updateStatus(`正在切換目標類型為: ${targetType}...`);
                    typeSelect.value = targetOptionValue;
                    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    await this.delay(600);
                }
            }

            this.updateStatus(`尋找輸入框...`);
            const input = await this.waitForElement('input[title="Case Owner"], input[id$=":ownerfield"]');

            if (!input) {
                this.updateStatus(`找不到輸入框，暫停！`, 'error');
                GM_setValue('salesforce_assign_autorun', { active: false });
                setTimeout(() => { const p = document.getElementById('vf-auto-status-panel'); if(p) p.remove(); }, 4000);
                return;
            }

            if (!this.checkActive()) return;
            await this.delay(150);

            if (!this.checkActive()) return;
            this.updateStatus(`正在填寫與校驗: ${targetName}`);

            input.value = targetName;
            input.dispatchEvent(new Event('focus', { bubbles: true }));
            await this.delay(30);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await this.delay(30);
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await this.delay(30);
            input.dispatchEvent(new Event('blur', { bubbles: true }));

            const hiddenLkid = document.querySelector('input[id$=":ownerfield_lkid"]');
            if (hiddenLkid) hiddenLkid.value = '';

            if (!this.checkActive()) return;
            await this.delay(400);

            if (!this.checkActive()) return;
            const submitBtn = await this.waitForElement('input[type="button"][value="Submit"], input[type="submit"][value="Submit"]');

            if (submitBtn) {
                this.updateStatus(`準備提交任務...`);
                submitBtn.click();
                this.waitForSuccessToast();
            } else {
                this.updateStatus(`找不到提交按鈕，暫停！`, 'error');
                GM_setValue('salesforce_assign_autorun', { active: false });
                setTimeout(() => { const p = document.getElementById('vf-auto-status-panel'); if(p) p.remove(); }, 4000);
            }
        }

        waitForSuccessToast() {
            let isProcessed = false;
            this.updateStatus(`等待系統處理中...`);

            const obs = new MutationObserver((mutations) => {
                const toast = document.querySelector('.slds-notify_toast.slds-theme_success');
                if (toast && !isProcessed) {
                    isProcessed = true;
                    obs.disconnect();

                    let cart = GM_getValue('salesforce_assign_cart', {});
                    let assignee = this.autorun.assignee;
                    let processedIds = this.autorun.processedIds || [];
                    let processedCaseNums = this.autorun.processedCaseNums || [];

                    if (cart[assignee]) {
                        cart[assignee] = cart[assignee].filter(id => !processedIds.includes(id));
                        if (cart[assignee].length === 0) delete cart[assignee];
                        GM_setValue('salesforce_assign_cart', cart);
                    }

                    if (processedCaseNums.length > 0) {
                        const today = new Date();
                        const safeToday = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
                        const timeString = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}:${String(today.getSeconds()).padStart(2, '0')}`;

                        let historyData = GM_getValue('salesforce_dispatch_history', { date: safeToday, records: {} });
                        if (historyData.date !== safeToday) historyData = { date: safeToday, records: {} };
                        if (!historyData.records[assignee]) historyData.records[assignee] = [];

                        historyData.records[assignee].push({ timestamp: timeString, cases: processedCaseNums });
                        GM_setValue('salesforce_dispatch_history', historyData);
                    }

                    const panel = document.getElementById('vf-auto-status-panel');
                    if (panel) {
                        panel.style.backgroundColor = '#04844b';
                        const spinner = panel.querySelector('.sf-spinner');
                        if (spinner) spinner.style.display = 'none';
                    }

                    const closeBtn = toast.querySelector('a');
                    if (closeBtn) {
                        // ✨ 修復 2：動態判斷剩餘任務數量
                        let remainingAssignees = Object.keys(cart).filter(k => cart[k].length > 0).length;
                        // 如果沒有其他人了，只需等待 1 秒；否則等待 30 秒
                        let countdown = remainingAssignees === 0 ? 1 : 30;

                        this.updateStatus(`分派成功！將在 ${countdown} 秒後安全返回列表...`);

                        const intervalId = setInterval(() => {
                            countdown--;
                            if (countdown > 0) {
                                this.updateStatus(`分派成功！將在 ${countdown} 秒後安全返回列表...`);
                            } else {
                                clearInterval(intervalId);
                                this.updateStatus(`正在返回列表...`);
                                closeBtn.click();
                            }
                        }, 1000);
                    } else {
                        setTimeout(() => { window.location.reload(); }, 10000);
                    }
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                if (!isProcessed) {
                    obs.disconnect();
                    alert(`⚠️ 自動分派發生異常或超時！\n\n系統未能彈出成功訊息，請確認人員名稱是否正確。\n自動任務已被暫停。`);
                    GM_setValue('salesforce_assign_autorun', { active: false });
                    const p = document.getElementById('vf-auto-status-panel');
                    if (p) p.remove();
                }
            }, 12000);
        }

        delay(ms) { return new Promise(res => setTimeout(res, ms)); }
    }


    /**
     * Salesforce Case Optimizer 核心類 (Lightning 列表專用)
     */
    class SalesforceCaseOptimizer {

        static CONFIG = {
            TARGET_URL_KEYWORD: "My_Open_Cases_CEC",

            TEXT: {
                DUPLICATE_BUTTON: "查重排序",
                FIND_ACCOUNT_BUTTON: "查找指定賬號",
                FIND_TN_BUTTON: "查提單號案號",
                RANGE_BUTTON: "範圍勾選",
                TPX_ANALYSIS_BUTTON: "TPX分析",
                ASSIGN_ANALYSIS_BUTTON: "ERN分析",

                BTN_ADD_CART: "加入分派隊列",
                BTN_EXEC_CART: "執行分派",
                PROMPT_ASSIGNEE: "請輸入此批 Case 的分派對象 (如: Jerry Law)：\n(系統將自動解除勾選並將這些項目凍結)",
                CART_EMPTY: "目前分派隊列為空！\n請先勾選 Case 並點擊「加入隊列」。",

                ASSIGN_SETTINGS_TITLE: "設置指派分析映射表",
                ASSIGN_SETTINGS_PROMPT: "格式：關鍵字1/關鍵字2=人員名稱\n例如：HKG2SAP/ERN-AK=Aki Lee",
                ASSIGN_SETTINGS_SAVE: "保存設置",
                ASSIGN_SETTINGS_CANCEL: "取消",
                ASSIGN_SETTINGS_SUCCESS: "映射表已保存！",
                ASSIGN_SETTINGS_EMPTY: "請先長按“指派分析”按鈕設置映射表。",

                BTN_MARK_CACHE: "保存識別結果",
                BTN_CLEAR_CACHE: "清除緩存",
                BTN_COPY_UNIDENTIFIED: "複製未識別追蹤號",
                BTN_EXPORT_TASKS: "導出分派任務",

                CACHE_CLEARED: "緩存已清除！",
                MARK_SUCCESS: "標示完成並已寫入緩存！",

                col_unidentified: "未識別追蹤號",
                col_tpx_input: "輸入TPX結果",
                col_identified: "已識別結果",

                DIALOG_TITLE_TPX: "TPX分析結果 (只掃描追蹤號，忽略ERN二字碼)",
                DIALOG_TITLE_DUPLICATE: "重複項掃描完畢！",
                DIALOG_TITLE_FIND: "指定賬號查找完畢！",
                DIALOG_SUMMARY_DUPLICATE: (total, groups) => `共掃描 <strong>${total}</strong> 列，發現 <strong>${groups}</strong> 組重複的追蹤號碼`,
                DIALOG_SUMMARY_FIND: (total, groups) => `共掃描 <strong>${total}</strong> 列，發現 <strong>${groups}</strong> 組匹配的指定賬號`,
                COPY_BUTTON: "複製重複單號",
                COPY_MATCHED_BUTTON: "複製匹配單號",
                COPY_SUCCESS_BUTTON: "已複製！",
                REORDER_TOP_BUTTON: "全部置頂",
                REORDER_INPLACE_BUTTON: "原地聚合",
                CANCEL_BUTTON: "關閉",

                ACCOUNT_SETTINGS_TITLE: "設置要查找的賬號列表",
                ACCOUNT_SETTINGS_PROMPT: "請每行輸入一個賬號（1Z後的6位，可帶*號）。",
                ACCOUNT_SETTINGS_SAVE: "保存設置",
                ACCOUNT_SETTINGS_CANCEL: "取消",
                ACCOUNT_SETTINGS_SUCCESS: "賬號列表已保存！",
                ACCOUNT_SETTINGS_EMPTY: "請先長按“查找指定賬號”按鈕設置賬號列表。",

                DIALOG_TITLE_FIND_TN_INPUT: "查找 / 提取單號",
                DIALOG_PROMPT_FIND_TN: "請貼上單號列以進行比對 (支援追蹤號 1Z... 與 Case號 C-...)，或者點擊底部按鈕提取所有單號：",
                DIALOG_TITLE_FIND_TN_RESULT: "單號比對結果",
                BTN_COPY_RICH_TEXT: "複製帶色結果 (貼回Excel)",

                EXTRACT_ALL_BUTTON: "提取列表所有單號",
                DIALOG_TITLE_EXTRACT_RESULT: "頁面所有單號提取結果",
            },
            SELECTORS: {
                BUTTON_CONTAINERS: [
                    'div.actionsWrapper',
                    'div[class*="Header"] .slds-button-group-list'
                ],
                TABLE: 'table.slds-table',
                TABLE_BODY: 'table.slds-table > tbody',
                TABLE_ROW: 'tbody > tr[data-row-key-value]',
                PREVIEW_BUTTON: 'button[title*="1Z"]',
                CHECKBOX: 'input[type="checkbox"]',
                TOTAL_COUNT_SPAN: 'span.countSortedByFilteredBy'
            },
            REGEX: {
                TRACKING_NUMBER: /(?:1Z(?:\s*[A-Z0-9]){16}|W5(?:\s*\d){9}|437051(?:\s*\d){5})/ig,
                CASE_NUMBER: /C-\d{10}/i,
                ACCOUNT_NUMBER: /^1Z([A-Z0-9]{6})/,
                TOTAL_COUNT: /of\s+(\d+)/,
                ITEMS_COUNT: /(\d+)\s*items/,
                ERN_CODE: /\((ERN-[A-Z]+)\)/i
            },
            STYLE: {
                HIGHLIGHT_COLORS: ['#FFAADA', '#FFD6A5', '#FDFF60', '#CAFFBF', '#9BF6FF', '#A0C4FF', '#BDB2FF', '#FFC6FF', '#E4F698', '#C9F0FF', '#D6F5C9', '#DF68C9'],
                STICKY_HEADER_CLASS: 'sticky-header-active',
                CART_FROZEN_BG_COLOR: '#565657'
            },
            TIMEOUTS: {
                COPY_SUCCESS_MSG: 1500,
                NOTIFICATION: 3500,
                LOAD_MORE_TIMEOUT: 5000,
                LONG_PRESS_DURATION: 1000,
                DEBOUNCE_DELAY: 300,
                CACHE_EXPIRY: 30 * 24 * 60 * 60 * 1000,
                CACHE_EXPIRY_SHORT: 12 * 60 * 60 * 1000
            },
            STORAGE_KEY: 'salesforce_target_accounts',
            STORAGE_KEY_ASSIGN: 'salesforce_assign_analysis_map',
            STORAGE_KEY_CACHE: 'salesforce_assign_cache_v1',
            STORAGE_KEY_CART: 'salesforce_assign_cart',
            STORAGE_KEY_AUTORUN: 'salesforce_assign_autorun',
            STORAGE_KEY_HISTORY: 'salesforce_dispatch_history', // ✨ 新增：歷史記錄
            STORAGE_KEY_QUEUE_LIST: 'salesforce_queue_list', // ✨ 新增：自訂佇列識別名單
            STORAGE_KEY_DISTRIBUTE_LIST: 'salesforce_distribute_list', // ✨ 新增：賬號查找均分名單
            STORAGE_KEY_QUICK_ASSIGN: 'salesforce_quick_assign_list' // ✨ 新增：常用快捷分派名單
        };

        constructor() {
            this.originalRowOrder = null;
            this.isLoading = false;
            this.buttons = {};
            this.targetAccounts = this.loadTargetAccounts();
            this.longPressTimer = null;
            this.isLongPress = false;

            this._mainObserver = null;
            this._urlObserver = null;
            this._cartObserver = null;

            // ✨ 新增：分頁專屬指紋 (Tab ID)
            // 利用 sessionStorage 確保同一個分頁跳轉回來時 ID 依然一致，但新開的分頁會獲得新 ID
            this.tabId = sessionStorage.getItem('sf_assign_tab_id');
            if (!this.tabId) {
                this.tabId = 'TAB_' + Math.random().toString(36).substr(2, 9);
                sessionStorage.setItem('sf_assign_tab_id', this.tabId);
            }

            // ✨ 新增：為心跳引擎準備的狀態變數
            this.currentUrl = location.href;
            this.observedTableBody = null;
            this.heartbeatTimer = null;

            this.init();
        }

        debounce(func, delay) {
            let timeout;
            return function (...args) {
                const context = this;
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(context, args), delay);
            };
        }

        init() {
            this.addStyles();
            console.log('[Case助手 V42]：腳本已啟動 (載入中控面板與今日記錄模組)。');

            // ✨ 新增：跨域頁籤握手協議 (Lightning 父層回應器)
            window.addEventListener('message', (event) => {
                if (event.data && event.data.action === 'REQUEST_SF_TAB_ID') {
                    if (event.source) {
                        event.source.postMessage({
                            action: 'RESPONSE_SF_TAB_ID',
                            tabId: this.tabId
                        }, event.origin);
                    }
                }
            });

            // ✨ 核心優化：移除所有綁定在 document.body 的高頻 MutationObserver
            // 改為啟用 1Hz 輕量級心跳引擎，徹底解決 CPU 30% 佔用問題
            this.startLightweightHeartbeat();
            this.setupCartGlobalListeners();

            const autorun = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
            if (autorun.active) {
                // ✨ 新增：分頁鎖校驗 (防止新分頁搶奪任務)
                if (autorun.tabLock && autorun.tabLock !== this.tabId) {
                    console.log(`[自動分派引擎] 🔒 偵測到任務正在其他分頁運行 (持鎖人: ${autorun.tabLock})，本分頁將保持靜默，防止亂竄。`);
                    return; // 終止接力，不注入按鈕，不向下執行
                }

                this.injectEmergencyStopButton();
                console.log("[自動分派引擎] 偵測到本分頁的接力任務，正在啟動智能等待...");
                this.waitForTableAndResume();
            }
        }

        async waitForTableAndResume() {
            this.showNotification("接力任務啟動中，等待列表加載...", "info");
            console.log("[自動分派引擎] 啟動跨頁面接力等待機制...");

            const maxWaitTime = 20000; // 拉長到 20 秒容錯
            const interval = 500;
            let elapsed = 0;

            while (elapsed < maxWaitTime) {
                const currentAutorun = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                if (!currentAutorun.active) {
                    console.warn("[自動分派引擎] 等待期間偵測到終止指令，放棄加載。");
                    return;
                }

                // ✨ 修正：不能只看 table，必須確保 tbody 裡面有實體的 tr 資料列！
                const tableBody = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE_BODY);
                const rows = tableBody ? tableBody.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW) : [];

                const table = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE);

                if (table) {
                    console.log(`[自動分派引擎] 表格框架已出現 (耗時 ${elapsed}ms)`);
                    await this.delay(1000); // 給予渲染緩衝

                    // ✨ 新增：早退機制 (最後一人分派完成後，直接結束)
                    let cart = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_CART, {});
                    let remainingAssignees = Object.keys(cart).filter(k => cart[k].length > 0);
                    if (remainingAssignees.length === 0) {
                        console.log(`[自動分派引擎] 🎉 偵測到分派隊列已全數清空！最後一批無需驗證，任務圓滿結束。`);

                        // 1. 先執行狀態清理
                        GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                        this.removeEmergencyStopButton();
                        this.updateCartButtonsUI(0);

                        // 2. 延遲 100ms 彈出確認框 (確保底層按鈕已移除再阻擋畫面)
                        setTimeout(() => {
                            alert("🎉 所有分派隊列已全數執行完畢！\n\n(註：此為最後一批，為節省時間將不進行同步檢驗，若畫面上仍有剛分派完的案件殘留屬正常現象，您可以手動刷新列表。)");
                        }, 100);
                        return;
                    }

                    const autorun = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                    console.log(`[自動分派引擎] 當前狀態機: Mode=${autorun.assignMode}, 待驗證IDs=${autorun.processedIds ? autorun.processedIds.length : 0}`);

                    if (autorun.assignMode === 'stable' && autorun.processedIds && autorun.processedIds.length > 0) {
                        this.verifyStableModeAndProcess(autorun.processedIds);
                    } else {
                        console.log(`[自動分派引擎] 進入極速模式，準備全加載後分派下一批...`);
                        this._executeFullLoadAndProcess(() => this.processNextBatch());
                    }
                    return;
                }

                await this.delay(interval);
                elapsed += interval;
            }

            console.error(`[自動分派引擎] 嚴重錯誤：等待 ${maxWaitTime}ms 後，表格仍未實體化！任務中斷。`);
            this.showNotification("網路嚴重延遲：無法讀取到列表，自動任務已被暫停。", "error");
            GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
            this.removeEmergencyStopButton();
        }

        // ✨ 尋找 Salesforce 原生刷新按鈕 (穿透 Shadow DOM)
        findNativeRefreshButton() {
            const searchDom = (root) => {
                if (!root) return null;
                let btn = root.querySelector('button[name="refreshButton"], button[title="Refresh"], button[title="重新整理"], button[title="刷新"]');
                if (btn) return btn;
                for (let el of Array.from(root.querySelectorAll('*'))) {
                    if (el.shadowRoot) {
                        btn = searchDom(el.shadowRoot);
                        if (btn) return btn;
                    }
                }
                return null;
            };
            return searchDom(document.body);
        }

        // ✨ 穩定分派檢驗引擎：動態退避與實體 DOM 雙重校驗
        async verifyStableModeAndProcess(processedIds) {
            console.log(`[穩定模式引擎] 啟動！開始驗證上一批分派是否已從 Salesforce 後端移出。`);
            console.log(`[穩定模式引擎] 待驗證的 Case IDs:`, processedIds);

            this.showNotification("進入穩定模式：正在驗證上一批案件是否已移出...", "info");

            const monitor = document.createElement('div');
            monitor.id = 'stable-mode-monitor';
            monitor.style.cssText = `position:fixed; top:20px; left:50%; transform:translateX(-50%); background-color:#1e3a8a; color:white; padding:12px 24px; border-radius:30px; z-index:999999; font-weight:bold; box-shadow:0 4px 15px rgba(0,0,0,0.3); display:flex; align-items:center; gap:15px; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size:14px;`;
            monitor.innerHTML = `
                <div class="sf-spinner" style="width:14px; height:14px; border:2px solid #fff; border-top:2px solid transparent; border-radius:50%; animation: sf-spin 1s linear infinite;"></div>
                <div id="stable-status-text">準備校驗中...</div>
                <button id="stable-stop-btn" style="background:#c23934; color:#fff; border:none; padding:5px 12px; border-radius:6px; cursor:pointer; font-weight:bold; transition:transform 0.1s;">終止任務</button>
            `;
            document.body.appendChild(monitor);

            const statusText = document.getElementById('stable-status-text');
            const stopBtn = document.getElementById('stable-stop-btn');

            let isAborted = false;
            stopBtn.onclick = () => {
                isAborted = true;
                console.warn(`[穩定模式引擎] 使用者手動點擊了終止按鈕。`);
                GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                this.removeEmergencyStopButton();
                monitor.remove();
                this.showNotification("🛑 穩定分派已手動終止。", "error");
                this.setButtonsDisabled(false);
            };

            const startTime = Date.now();
            const MAX_WAIT_MS = 30 * 60 * 1000;
            let checkCount = 0;
            let lastDelaySec = 0;

            while (!isAborted) {
                // 背景防護機制
                if (document.visibilityState === 'hidden') {
                    statusText.textContent = `[背景暫停中] 等待視窗恢復顯示...`;
                    await this.delay(2000);
                    continue;
                }

                checkCount++;
                const elapsedMs = Date.now() - startTime;
                if (elapsedMs > MAX_WAIT_MS) {
                    console.error(`[穩定模式引擎] 觸發死鎖保護！已超時 30 分鐘，強制終止任務。`);
                    alert("🛑 穩定模式超時保護：已超過 30 分鐘仍未完成資料同步，任務強制終止。");
                    GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                    this.removeEmergencyStopButton();
                    monitor.remove();
                    this.setButtonsDisabled(false);
                    return;
                }

                const elapsedMin = Math.floor(elapsedMs / 60000);
                const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
                const timeStr = `${String(elapsedMin).padStart(2, '0')}:${String(elapsedSec).padStart(2, '0')}`;

                let delaySec = 5;
                if (elapsedMin >= 15) delaySec = 30;
                else if (elapsedMin >= 5) delaySec = 15;
                else if (elapsedMin >= 3) delaySec = 10;

                if (delaySec !== lastDelaySec) {
                    if (lastDelaySec !== 0) console.log(`[穩定模式引擎] ⏱️ 系統延遲較高，退避頻率自動調整為每 ${delaySec} 秒一次`);
                    lastDelaySec = delaySec;
                }

                let tableBody = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE_BODY);
                if (tableBody) {

                    // ✨ 核心修復：靜默全加載 (Silent Full Load)
                    statusText.textContent = `[耗時 ${timeStr}] 正在展開全列表以確保準確校驗...`;

                    // 💡 改用物理探測器，100% 確保抓到真正的 LWC 滾動容器
                    const scroller = this.getScrollParent(tableBody);
                    if (scroller && scroller !== document.documentElement && scroller !== document.body) {
                        let loadRetries = 0;
                        let lastCount = 0;
                        while (loadRetries < 3 && !isAborted) {
                            const countSpan = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TOTAL_COUNT_SPAN);
                            if (countSpan && countSpan.textContent && !countSpan.textContent.includes('+')) break;

                            scroller.scrollTop = scroller.scrollHeight;
                            await this.delay(800); // ⚡ 給予 800ms 充分的網路加載與渲染時間

                            const curCount = tableBody.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW).length;
                            if (curCount === lastCount && curCount >= 0) loadRetries++;
                            else loadRetries = 0;
                            lastCount = curCount;
                        }
                    }

                    // 恢復 UI 提示
                    statusText.textContent = `[耗時 ${timeStr}] 地毯式檢驗 ${processedIds.length} 筆案件中...`;

                    let foundLingering = false;
                    let foundAnyOtherRow = false;
                    let isListTrulyEmpty = false;

                    // 在「全展開」的狀態下，進行地毯式比對
                    for (let id of processedIds) {
                        if (this.findElementInShadowDom(`tr[data-row-key-value="${id}"]`)) {
                            foundLingering = true;
                            break;
                        }
                    }

                    if (!foundLingering) {
                        const allRows = this.findAllElementsInShadowDom('tr[data-row-key-value]');
                        if (allRows.length > 0) {
                            foundAnyOtherRow = true;
                        } else {
                            const countSpan = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TOTAL_COUNT_SPAN);
                            if (countSpan && countSpan.textContent && countSpan.textContent.includes('0 items')) {
                                isListTrulyEmpty = true;
                            }
                        }
                    }

                    if (foundLingering) {
                        console.log(`[穩定模式引擎] ⏳ 發現殘留！數據尚未同步，持續觸發原生刷新與重試中...`);
                    } else if (foundAnyOtherRow || isListTrulyEmpty) {
                        console.log(`[穩定模式引擎] ✅ 驗證通過！目標 IDs 已完全移出。總共掃描: ${checkCount}次，總耗時: ${timeStr}。`);
                        monitor.style.backgroundColor = '#04844b';
                        monitor.querySelector('.sf-spinner').style.display = 'none';
                        stopBtn.style.display = 'none';

                        const autorun = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                        autorun.processedIds = [];
                        GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, autorun);

                        await this.delay(1000);
                        monitor.remove();

                        // 最後一人分派完成後的早退機制
                        let cart = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_CART, {});
                        let remainingAssignees = Object.keys(cart).filter(k => cart[k].length > 0);
                        if (remainingAssignees.length === 0) {
                            console.log(`[穩定模式引擎] 🎉 購物車已全空！分派任務圓滿結束。`);
                            GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                            this.removeEmergencyStopButton();
                            this.updateCartButtonsUI(0);
                            setTimeout(() => {
                                alert("🎉 所有分派隊列已全數執行完畢！\n\n(註：此為最後一批，若畫面上仍有剛分派完的案件殘留屬正常現象，您可以手動刷新列表。)");
                            }, 100);
                        } else {
                            statusText.textContent = `✅ 驗證成功！準備下一批分派...`;
                            this._executeFullLoadAndProcess(() => this.processNextBatch());
                        }
                        return;
                    } else {
                        console.log(`[穩定模式引擎] ⚠️ DOM 框架重建中，跳過本次判斷等待刷新...`);
                    }
                }

                // ✨ UI 升級：實時動態倒計時取代靜態死等
                for (let remaining = delaySec; remaining > 0; remaining--) {
                    if (isAborted) return; // 倒數期間若按下終止，瞬間跳出
                    statusText.textContent = `[耗時 ${timeStr}] 等待 ${remaining} 秒後刷新 (防錯分冷卻)`;
                    await this.delay(1000);
                }

                if (isAborted) return;

                const refreshBtn = this.findNativeRefreshButton();
                if (refreshBtn) {
                    refreshBtn.click();
                    await this.delay(2000);
                }
            }
        }

        quickClearAllCart() {
            const C = this.constructor.CONFIG;
            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            let totalCount = 0;
            Object.keys(cart).forEach(k => totalCount += cart[k].length);

            if (totalCount === 0) {
                return this.showNotification("當前分派隊列原本就是空的。", "info");
            }

            if (confirm(`⚠️ 快捷清除確認：\n\n確定要立即清空所有分派隊列嗎？(共 ${totalCount} 筆案件)\n\n這將會還原所有被鎖定的案件視覺狀態。`)) {
                Object.keys(cart).forEach(name => {
                    this.unfreezeRows(name);
                });
                GM_setValue(C.STORAGE_KEY_CART, {});
                this.updateCartButtonsUI(0);
                this.showNotification("已還原所有案件，分派隊列已清空。", "success");
            }
        }

        addStyles() {
            // ✨ 圖標全局縮放比例參數 (1.0 為原生標準大小，建議可調為 0.75 ~ 0.85)
            const ICON_SCALE = 0.9;

            // 動態計算縮放後的像素大小
            const boxSize = Math.round(24 * ICON_SCALE);
            const imgSize = Math.round(16 * ICON_SCALE);
            const smallBoxSize = Math.round(18 * ICON_SCALE);
            const smallImgSize = Math.round(12 * ICON_SCALE);

            GM_addStyle(`
                /* ✨ 新增：核心按鈕專屬背景色與 Hover 效果 */
                /* 加入分派隊列 (柔和琥珀橘) */
                #addCartButton:not([disabled]) { background-color: #fff8e1 !important; border-color: #ffc107 !important; transition: all 0.2s ease; }
                #addCartButton:not([disabled]) a { color: #e65100 !important; font-weight: 600 !important; }

                /* 執行分派 (翡翠亮綠) */
                #execCartButton:not([disabled]) { background-color: #e8f5e9 !important; border-color: #4caf50 !important; transition: all 0.2s ease; }
                #execCartButton:not([disabled]) a { color: #2e7d32 !important; font-weight: 600 !important; }

                /* 原有樣式保持不變 */
                .${this.constructor.CONFIG.STYLE.STICKY_HEADER_CLASS} { position: sticky !important; top: 0 !important; z-index: 10 !important; background-color: rgb(250, 250, 249) !important; }
                tr[data-highlighted-by-script="true"].slds-is-selected > td, tr[data-highlighted-by-script="true"].slds-is-selected > th,
                tr[data-highlighted-by-script="true"]:hover > td, tr[data-highlighted-by-script="true"]:hover > th { background-color: inherit !important; }
                li.slds-button a.forceActionLink:hover, li.slds-button a.forceActionLink:focus { text-decoration: none !important; }

                /* ✨ 新增：Salesforce 原生風格分派圖標與菜單 CSS (已導入 ICON_SCALE 動態縮放) */
                .sf-assign-icon-box { background-color: #1B96FF; width: ${boxSize}px; height: ${boxSize}px; border-radius: 3px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
                .sf-assign-icon-box img { width: ${imgSize}px; height: ${imgSize}px; display: block; }
                .sf-assign-icon-box.small { width: ${smallBoxSize}px; height: ${smallBoxSize}px; border-radius: 2px; }
                .sf-assign-icon-box.small img { width: ${smallImgSize}px; height: ${smallImgSize}px; }
                /* 微調選項的上下 Padding 與 Gap，配合縮小後的圖標讓排版更緊湊精緻 */
                .sf-assign-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 13px; color: #181818; cursor: pointer; transition: background-color 0.1s; border-radius: 4px; }
                .sf-assign-item:hover { background-color: #f3f2f2; color: #0070d2; }

                .cart-tag {
                    color: #c23934;
                    font-weight: bold;
                    margin-right: 6px;
                    background: #ffebee;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 11px;
                    flex-shrink: 0;
                }

                .cart-subject-container {
                    display: flex !important;
                    align-items: center !important;
                    white-space: nowrap !important;
                    overflow: hidden !important;
                    text-overflow: ellipsis !important;
                }

                .custom-dialog-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.6); z-index: 10000; display: flex; justify-content: center; align-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                .custom-dialog-box { background-color: #fff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); width: 90%; max-width: 480px; padding: 24px; text-align: center; animation: dialog-fade-in 0.3s ease-out; display: flex; flex-direction: column; }
                .custom-dialog-box.dashboard-dialog { width: fit-content; max-width: 95vw; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
                @keyframes dialog-fade-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
                .custom-dialog-title { font-size: 20px; font-weight: bold; color: #181818; margin-bottom: 12px; }
                .custom-dialog-message { font-size: 16px; line-height: 1.6; color: #333; margin-bottom: 16px; white-space: pre-wrap; }
                .custom-dialog-details { max-height: 180px; overflow-y: auto; background-color: #f7f7f7; border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin-bottom: 24px; text-align: left; font-size: 14px; }
                .custom-dialog-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 0; }
                .custom-dialog-buttons.dashboard-buttons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 20px; }

                .custom-dialog-buttons button { width: 100%; padding: 12px; font-size: 14px; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; transition: background-color 0.2s, transform 0.1s; white-space: nowrap; }
                .custom-dialog-buttons button:hover { transform: translateY(-1px); }
                .custom-dialog-buttons button:disabled { background-color: #f3f3f3 !important; color: #adadad !important; cursor: not-allowed !important; transform: none !important; border: 1px solid #ddd !important; }

                .btn-primary { background-color: #0070d2; color: white; }
                .btn-primary:hover { background-color: #005A9E; }
                .btn-secondary { background-color: #eef1f6; color: #181818; }
                .btn-secondary:hover { background-color: #dde4ee; }
                .btn-danger { background-color: #c23934; color: white; }
                .btn-danger:hover { background-color: #a61a14; }
                .btn-export { background-color: #ff9800; color: white; }
                .btn-export:hover { background-color: #e68a00; }
                .custom-toast-notification { position: fixed; top: 20px; right: 20px; background-color: #333; color: white; padding: 12px 20px; border-radius: 6px; z-index: 10001; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: opacity 0.3s, transform 0.3s; transform: translateX(100%); opacity: 0; }
                .custom-toast-notification.show { transform: translateX(0); opacity: 1; }
                .custom-toast-notification.error { background-color: #c23934; }
                .custom-toast-notification.success { background-color: #04844b; }
                #full-load-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.75); z-index: 99999; display: flex; justify-content: center; align-items: center; color: white; font-size: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; transition: opacity 0.3s; flex-direction: column; }
                li.slds-button[disabled] { background-color: #f3f3f3; cursor: not-allowed; }
                li.slds-button[disabled] > a { color: #adadad; pointer-events: none; }
                records-hoverable-link { pointer-events: none !important; }
                records-hoverable-link a { pointer-events: auto !important; }
                .settings-dialog-textarea { width: 100%; height: 200px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-family: monospace; font-size: 14px; resize: vertical; margin-bottom: 16px; }
                .settings-dialog-prompt { font-size: 14px; color: #555; margin-bottom: 8px; text-align: left; }
                .assign-grid-container { display: grid; grid-template-columns: 260px 260px 260px; gap: 16px; height: 380px; margin-bottom: 0; text-align: left; }
                .assign-column { border: 1px solid #e1e4e8; border-radius: 8px; display: flex; flex-direction: column; background-color: #fafafa; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
                .assign-col-header { background-color: #f0f2f5; padding: 10px; font-weight: 700; font-size: 13px; border-bottom: 1px solid #e1e4e8; text-align: center; color: #444; letter-spacing: 0.5px; }
                .assign-col-content { flex: 1; overflow-y: auto; padding: 8px; font-size: 12px; font-family: monospace; color: #555; }
                .assign-col-content div { margin-bottom: 4px; border-bottom: 1px dashed #eee; padding-bottom: 2px; cursor: pointer; }
                .sync-active { background-color: #b3d7ff !important; border-left: 4px solid #0070d2; padding-left: 4px; font-weight: bold; color: #000; }
            `);
        }

        showNotification(message, type = 'info') {
            const n = document.createElement('div');
            n.className = `custom-toast-notification ${type}`;
            n.textContent = message;
            document.body.appendChild(n);
            setTimeout(() => n.classList.add('show'), 10);
            setTimeout(() => {
                n.classList.remove('show');
                n.addEventListener('transitionend', () => n.remove());
            }, 3500);
        }

        findAllElementsInShadowDom(selector, root = document) {
            let r = Array.from(root.querySelectorAll(selector));
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
                acceptNode: function(node) {
                    return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                }
            });
            let shadowHost;
            while ((shadowHost = walker.nextNode())) {
                r = r.concat(this.findAllElementsInShadowDom(selector, shadowHost.shadowRoot));
            }
            return r;
        }

        findElementInShadowDom(selector, root = document) {
            return this.findAllElementsInShadowDom(selector, root)[0] || null;
        }

        delay(ms) {
            return new Promise(res => setTimeout(res, ms));
        }

        // ✨ 新增：穿透 Shadow DOM 的物理滾動容器探測器 (不依賴任何 SF 類名)
        getScrollParent(el) {
            let cur = el;
            while (cur) {
                if (cur instanceof HTMLElement) {
                    const style = window.getComputedStyle(cur);
                    const oy = style.overflowY;
                    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight) {
                        return cur;
                    }
                }
                cur = cur.parentNode;
                if (!cur) {
                    const root = el.getRootNode && el.getRootNode();
                    if (root && root.host) {
                        el = root.host;
                        cur = el;
                    }
                }
            }
            return document.scrollingElement || document.documentElement;
        }

        clearHighlights() {
            this.highlightMemory = new Map();
            const e = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE);
            if (e) {
                const frozenColor = this.constructor.CONFIG.STYLE.CART_FROZEN_BG_COLOR;
                e.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW).forEach(r => {
                    r.removeAttribute("data-highlighted-by-script");
                    if (r.hasAttribute('data-queued-assignee')) {
                        r.style.backgroundColor = frozenColor;
                    } else {
                        r.style.backgroundColor = "";
                    }
                });
            }
        }

        scrollToTableTop(table, offset = 12) {
            if (!table) return;
            const headerRow = table.querySelector("thead tr[data-row-key-value='HEADER']") || table.querySelector('thead tr') || table.querySelector('thead');
            const target = headerRow || table;

            const scroller = this.getScrollParent(target);
            const scrollInContainer = () => {
                if (!scroller || scroller === document.body) return;
                const scRect = scroller.getBoundingClientRect();
                const tgRect = target.getBoundingClientRect();
                const top = (tgRect.top - scRect.top) + scroller.scrollTop;
                scroller.scrollTo({ top: Math.max(0, top - offset), behavior: 'smooth' });
            };

            setTimeout(() => {
                setTimeout(() => {
                    try {
                        if (scroller === document.scrollingElement || scroller === document.documentElement) {
                            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            setTimeout(() => window.scrollBy(0, -Math.max(0, offset)), 50);
                        } else {
                            scrollInContainer();
                        }
                    } catch (e) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                });
            });
        }

        // ✨ 全新方案：Shadow DOM 內部攔截器 (直接綁定底層 Table，突破 LWS 防護)
        // ⚡ 效能優化：改為接收 table 參數，避免無謂的 Shadow DOM 搜尋
        bindShadowTableShiftInterceptor(tableEl = null) {
            const C = this.constructor.CONFIG;
            // 若沒有傳入，且沒有記憶，才作為備用進行搜尋
            const table = tableEl || this.findElementInShadowDom(C.SELECTORS.TABLE);
            if (!table) return;

            // 防重複綁定標籤
            if (table.dataset.shiftBound === 'true') return;
            table.dataset.shiftBound = 'true';

            console.log("[Case助手] ⚡ 已成功將終極版 Shift 攔截器注入底層 Shadow Table！(同步無延遲 + 動態差集支援)");

            // 輔助函數：確認點擊是否發生在「Checkbox 所在的列」，並識別是否為表頭(全選框)
            const getRowAndCheckbox = (e) => {
                const path = e.composedPath ? e.composedPath() : [];
                const cell = path.find(el => el && (el.tagName === 'TD' || el.tagName === 'TH'));
                if (!cell) return null;

                const chk = cell.querySelector('input[type="checkbox"]');
                if (!chk) return null;

                const isThead = cell.closest('thead') !== null;
                const tr = path.find(el => el && el.tagName === 'TR');
                if (!tr) return null;

                return { tr, chk, isThead };
            };

            // 1. 核心接管：攔截點擊
            table.addEventListener('click', (e) => {
                // 🛑 核心修復 1：戴上遮罩！忽略腳本自身觸發的批次點擊，防止「起點錨點(Anchor)」被洗掉
                if (this.isBatchClicking) return;

                const target = getRowAndCheckbox(e);
                if (!target) return;

                // 🛡️ 防呆 1：使用者點擊了原生「全選框」，必須重置所有記憶，完美銜接原生邏輯
                if (target.isThead) {
                    this.lastClickedRowAnchor = null;
                    this.lastShiftTargetRow = null;
                    return; // 放行原生全選動作
                }

                // 🛡️ 防呆 2：若點擊的是「已凍結(入列)」的 Case，視為無效起點/終點
                if (target.tr.hasAttribute('data-queued-assignee')) {
                    if (e.shiftKey) {
                        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                        window.getSelection().removeAllRanges();
                    }
                    return;
                }

                // 若沒有按 Shift，則正常紀錄這列為「起點 (Anchor)」，並清空上一輪的終點記憶
                if (!e.shiftKey) {
                    this.lastClickedRowAnchor = target.tr;
                    this.lastShiftTargetRow = null;
                    return;
                }

                // 🛑 偵測到 Shift+Click！瞬間掐死原生事件
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                // 雙重保險：抹除可能殘留的瀏覽器原生文字反白
                window.getSelection().removeAllRanges();

                if (!this.lastClickedRowAnchor || !table.contains(this.lastClickedRowAnchor)) return;

                const tbody = table.querySelector('tbody');
                if (!tbody) return;

                // 以「肉眼可見的 DOM 順序」來計算真實範圍
                const rows = Array.from(tbody.querySelectorAll(C.SELECTORS.TABLE_ROW));
                const startIdx = rows.indexOf(this.lastClickedRowAnchor);
                const endIdx = rows.indexOf(target.tr);

                if (startIdx === -1 || endIdx === -1) return;

                // 判斷起點狀態
                const anchorChk = this.lastClickedRowAnchor.querySelector('input[type="checkbox"]');
                const targetState = anchorChk ? anchorChk.checked : true;

                // ✨ 計算本次的新範圍與上一次的舊範圍
                const minNew = Math.min(startIdx, endIdx);
                const maxNew = Math.max(startIdx, endIdx);

                let minOld = -1, maxOld = -1;
                if (this.lastShiftTargetRow) {
                    const oldEndIdx = rows.indexOf(this.lastShiftTargetRow);
                    if (oldEndIdx !== -1) {
                        minOld = Math.min(startIdx, oldEndIdx);
                        maxOld = Math.max(startIdx, oldEndIdx);
                    }
                }

                // 更新當前這輪的 Shift 終點記憶
                this.lastShiftTargetRow = target.tr;

                // 先收集需要變更狀態的 Checkbox
                const chksToClick = [];

                // 計算需要掃描的最大聯集範圍
                const scanMin = minOld !== -1 ? Math.min(minNew, minOld) : minNew;
                const scanMax = maxOld !== -1 ? Math.max(maxNew, maxOld) : maxNew;

                for (let i = scanMin; i <= scanMax; i++) {
                    const currentRow = rows[i];
                    if (!currentRow) continue;

                    // 遇到被凍結(加入派送隊列)的 Case，結界防護，直接跳過
                    if (currentRow.hasAttribute('data-queued-assignee')) continue;

                    const rowChk = currentRow.querySelector('input[type="checkbox"]');
                    if (!rowChk || rowChk.disabled) continue;

                    const inNewRange = (i >= minNew && i <= maxNew);

                    if (inNewRange) {
                        // 在新範圍內，狀態必須跟起點(targetState)一致
                        if (rowChk.checked !== targetState) chksToClick.push(rowChk);
                    } else {
                        // ⚡ 核心邏輯：在舊範圍但「不在」新範圍內，代表使用者「縮小範圍了」，必須把狀態復原(相反)
                        if (rowChk.checked === targetState) chksToClick.push(rowChk);
                    }
                }

                // 🛑 核心修復 2：移除 setTimeout，改為「完全同步」執行，達到零延遲原生手感
                this.isBatchClicking = true;
                try {
                    chksToClick.forEach(chk => chk.click());
                } finally {
                    this.isBatchClicking = false;
                }

            }, { capture: true });

            // 🛑 核心優化 3：在 mousedown 源頭強制阻止藍色反白產生，手感提升 100%
            const blockNative = (e) => {
                if (e.shiftKey) {
                    const target = getRowAndCheckbox(e);
                    if (target && !target.isThead) {
                        e.preventDefault();
                    }
                }
            };
            table.addEventListener('mousedown', blockNative, { capture: true });
        }

        // ✨ 新增：輕量級心跳引擎 (取代全局 MutationObserver)
        startLightweightHeartbeat() {
            this.heartbeatTimer = setInterval(() => {
                // 1. URL 變更檢測與幽靈監聽器銷毀 (SPA 切換防護)
                if (location.href !== this.currentUrl) {
                    this.currentUrl = location.href;
                    if (this.originalRowOrder !== null) {
                        this.originalRowOrder = null;
                    }

                    // ✨ 核心修復：網址一切換，立刻強制殺死殘留的表格監聽器與快取
                    if (this._cartObserver) {
                        this._cartObserver.disconnect();
                        this._cartObserver = null;
                    }
                    this.observedTableBody = null;
                    console.log('[Case助手] 檢測到路由跳轉，已清空表格緩存與背景監聽器。');
                }

                // 🛑 終極防護：精準排除 Case 詳細頁面
                // 依照指示，只要網址包含 '/r/Case/'，直接罷工提早退出！0 運算消耗！
                if (location.href.includes('/r/Case/')) {
                    return;
                }

                // 2. 按鈕注入檢測 (⚡ 快取優化：利用 isConnected 判斷按鈕是否還活著)
                const isButtonAlive = this.buttons && this.buttons.addCart && this.buttons.addCart.isConnected;
                if (!isButtonAlive) {
                    for (const selector of this.constructor.CONFIG.SELECTORS.BUTTON_CONTAINERS) {
                        const container = this.findElementInShadowDom(selector);
                        if (container) {
                            this.addCustomButtons(container);
                            break;
                        }
                    }
                }

                // 3. 購物車狀態與表格動態載入檢測 (⚡ 快取優化)
                let tableBody = null;
                // 若記憶體中的表格還在畫面上，直接沿用，不進行全圖 DOM 搜索
                if (this.observedTableBody && this.observedTableBody.isConnected) {
                    tableBody = this.observedTableBody;
                } else {
                    tableBody = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE_BODY);
                }

                if (tableBody && this.observedTableBody !== tableBody) {
                    if (this._cartObserver) this._cartObserver.disconnect();
                    this.observedTableBody = tableBody;

                    this._cartObserver = new MutationObserver(this.debounce(() => this.performCartCheckAndFreeze(), 150));
                    this._cartObserver.observe(tableBody, { childList: true, subtree: true });
                    console.log(`[Case助手] 表格監聽器已精準綁定至實體 tbody。`);

                    this.performCartCheckAndFreeze();
                } else if (tableBody) {
                    this.performCartCheckAndFreeze();
                }
            }, 1000);
        }

        // ✨ 獨立提取凍結邏輯
        performCartCheckAndFreeze() {
            const cart = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_CART, {});
            const autorun = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
            const protectedIds = autorun.active ? (autorun.processedIds || []) : [];
            const allIds = {};
            let totalCartCount = 0;

            for (let a in cart) {
                cart[a].forEach(id => allIds[id] = a);
                totalCartCount += cart[a].length;
            }

            this.updateCartButtonsUI(totalCartCount);

            // ⚡ 快取優化：直接使用記憶體中的 tableBody，不再執行耗時的 findElementInShadowDom
            const tableBody = this.observedTableBody;
            if (tableBody && tableBody.isConnected) {

                // 傳遞實體 table 給攔截器
                const tableEl = tableBody.closest('table');
                if (tableEl) this.bindShadowTableShiftInterceptor(tableEl);

                tableBody.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW).forEach(tr => {
                    const id = tr.getAttribute('data-row-key-value');
                    if (id && allIds[id] && !protectedIds.includes(id)) {
                        const chk = tr.querySelector('input[type="checkbox"]');
                        if (chk && chk.checked) {
                            chk.disabled = false;
                            chk.click();
                            chk.disabled = true;
                        }
                        if (!tr.hasAttribute('data-queued-assignee')) {
                            this.applyVisualFreeze(tr, allIds[id]);
                        }
                    }
                });
            }
        }

        setupCartGlobalListeners() {
            document.body.addEventListener('mouseup', (e) => {
                if (e.shiftKey) setTimeout(() => this.performCartCheckAndFreeze(), 50);
            }, true);
        }

        updateCartButtonsUI(totalCount) {
            if (this.buttons.execCart) {
                const textNode = this.buttons.execCart.querySelector('div');
                if (textNode) {
                    textNode.textContent = totalCount > 0
                        ? `${this.constructor.CONFIG.TEXT.BTN_EXEC_CART} (${totalCount})`
                        : this.constructor.CONFIG.TEXT.BTN_EXEC_CART;
                }
            }
        }

        // ✨ 觸發手動輸入 UI 加入隊列
        async addToCart() {
            const C = this.constructor.CONFIG;
            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);
            if (!table) return;

            const checkboxes = Array.from(table.querySelectorAll('tbody input[type="checkbox"]:checked'));
            if (checkboxes.length === 0) return this.showNotification("錯誤：請先在列表中手動勾選要分派的 Case。", "error");

            const result = await this.promptAssigneeWithUI();
            if (!result || !result.name) return;

            const assigneeKey = `${result.type}:${result.name}`;
            this.processAddToCartTarget(checkboxes, assigneeKey, result.name);
        }

        // ✨ 新增：核心寫入隊列引擎 (供 UI 與 快捷選單 共同呼叫)
        processAddToCartTarget(checkboxes, assigneeKey, displayName) {
            const C = this.constructor.CONFIG;
            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            if (!cart[assigneeKey]) cart[assigneeKey] = [];

            let idMap = JSON.parse(localStorage.getItem('salesforce_id_to_case_map') || '{}');
            let addedCount = 0;
            const rowsToProcess = [];

            checkboxes.forEach(chk => {
                const tr = chk.closest('tr');
                if (tr) {
                    const rowId = tr.getAttribute('data-row-key-value');
                    if (rowId && !cart[assigneeKey].includes(rowId)) {
                        cart[assigneeKey].push(rowId);
                        addedCount++;
                        const cn = this.extractCaseNumberFromRow(tr);
                        if (cn) idMap[rowId] = cn;
                        rowsToProcess.push({ tr, chk });
                    }
                }
            });

            if (addedCount === 0) return this.showNotification("這些案件已在隊列中。", "info");

            GM_setValue(C.STORAGE_KEY_CART, cart);
            localStorage.setItem('salesforce_id_to_case_map', JSON.stringify(idMap));

            rowsToProcess.forEach(item => item.chk.click());

            setTimeout(() => {
                rowsToProcess.forEach(item => this.applyVisualFreeze(item.tr, assigneeKey));
                this.showNotification(`成功加入 ${addedCount} 筆 Case 至隊列。目標: ${displayName}`, "success");
                this.performCartCheckAndFreeze();
            }, 16);
        }

        // ✨ 升級：純 UI 驅動版右鍵一鍵自動掃描與佇列 (Queue) 智能識別
        autoAddToCartFromAnalysis() {
            const C = this.constructor.CONFIG;
            const tableBody = this.findElementInShadowDom(C.SELECTORS.TABLE_BODY);
            if (!tableBody) return this.showNotification("錯誤：找不到表格資料列！", "error");

            const markedSpans = tableBody.querySelectorAll('.script-injected-assignee');
            if (markedSpans.length === 0) return this.showNotification("💡 列表中目前沒有任何已標示分析結果的案件。", "info");

            const groups = new Map();

            markedSpans.forEach(span => {
                const name = span.getAttribute('data-assignee');
                const tr = span.closest('tr');

                // 收集所有已標記且尚未進入購物車的案件
                if (name && tr && !tr.hasAttribute('data-queued-assignee')) {
                    if (!groups.has(name)) groups.set(name, []);
                    groups.get(name).push(tr);
                }
            });

            if (groups.size === 0) {
                return this.showNotification("💡 所有已識別的案件都已經在分派隊列中。", "info");
            }

            // ✨ 載入 UI 儲存的強大路由規則
            const router = this.loadRouterRules();
            let confirmMsg = "⚠️ 確定要將以下已識別的案件「一鍵加入分派隊列」嗎？\n\n";
            let totalCount = 0;
            let excludedCount = 0;
            let redirectedCount = 0;
            const finalGroups = new Map();

            groups.forEach((rows, name) => {
                const lowerName = name.toLowerCase();

                // 1. 執行排除過濾
                if (router.exclude.has(lowerName)) {
                    excludedCount += rows.length;
                    return; // 忽略此人
                }

                // 2. 執行重定向
                let targetName = name;
                if (router.redirect.has(lowerName)) {
                    targetName = router.redirect.get(lowerName);
                    redirectedCount += rows.length;
                }

                // 3. 判斷是否為 Queue
                const isQueue = Array.from(router.queues).some(q => q.toLowerCase() === targetName.toLowerCase());
                const typeCode = isQueue ? 'Q' : 'U';
                const assigneeKey = `${typeCode}:${targetName}`;

                // 聚合結果
                if (!finalGroups.has(assigneeKey)) finalGroups.set(assigneeKey, []);
                finalGroups.get(assigneeKey).push(...rows);
            });

            // 重新計算合併後的輸出文字
            finalGroups.forEach((rows, assigneeKey) => {
                const isQueue = assigneeKey.startsWith('Q:');
                const displayName = assigneeKey.substring(2);
                const icon = isQueue ? '🏢 [Queue]' : '👤 [User]';
                confirmMsg += `- ${icon} ${displayName}：${rows.length} 筆\n`;
                totalCount += rows.length;
            });

            confirmMsg += `\n共計：${totalCount} 筆案件`;

            if (excludedCount > 0 || redirectedCount > 0) {
                confirmMsg += "\n\n(⚙️ 規則套用中：";
                if (excludedCount > 0) confirmMsg += `已排除 ${excludedCount} 筆`;
                if (redirectedCount > 0) confirmMsg += `${excludedCount > 0 ? '，' : ''}已重定向 ${redirectedCount} 筆`;
                confirmMsg += ")";
            }

            if (!confirm(confirmMsg)) return;

            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            let idMap = JSON.parse(localStorage.getItem('salesforce_id_to_case_map') || '{}');
            let addedCount = 0;

            finalGroups.forEach((rows, assigneeKey) => {
                if (!cart[assigneeKey]) cart[assigneeKey] = [];
                rows.forEach(tr => {
                    const rowId = tr.getAttribute('data-row-key-value');
                    if (rowId && !cart[assigneeKey].includes(rowId)) {
                        cart[assigneeKey].push(rowId);
                        addedCount++;
                        const cn = this.extractCaseNumberFromRow(tr);
                        if (cn) idMap[rowId] = cn;

                        const chk = tr.querySelector('input[type="checkbox"]');
                        if (chk && chk.checked) chk.click();

                        this.applyVisualFreeze(tr, assigneeKey);
                    }
                });
            });

            GM_setValue(C.STORAGE_KEY_CART, cart);
            localStorage.setItem('salesforce_id_to_case_map', JSON.stringify(idMap));
            this.showNotification(`🎉 成功將 ${addedCount} 筆已識別案件自動歸入分派隊列！`, "success");
            this.updateCartButtonsUI(Object.keys(cart).reduce((sum, k) => sum + cart[k].length, 0));
        }

        applyVisualFreeze(tr, assignee) {
            const frozenColor = this.constructor.CONFIG.STYLE.CART_FROZEN_BG_COLOR;
            tr.setAttribute('data-queued-assignee', assignee);

            tr.style.backgroundColor = frozenColor;
            tr.style.opacity = '0.85';
            tr.style.pointerEvents = 'none';

            const subjectCell = tr.querySelector('td[data-label="Subject"]');
            if (subjectCell) {
                let tag = subjectCell.querySelector('.cart-tag');
                if (!tag) {
                    tag = document.createElement('span');
                    tag.className = 'cart-tag';

                    // ✨ 原生化視覺美化：使用 SLDS 圖標與排版
                    let isQueue = assignee.startsWith('Q:');
                    let cleanName = assignee.substring(2);
                    let iconSrc = isQueue ? '/img/icon/t4v35/standard/orders_120.png' : '/img/icon/t4v35/standard/user_120.png';

                    tag.style.cssText = `
                        color: #c23934; font-weight: bold; margin-right: 6px; background: #ffebee;
                        padding: 2px 6px 2px 4px; border-radius: 4px; font-size: 11px; flex-shrink: 0;
                        display: inline-flex; align-items: center; gap: 4px; border: 1px solid #f2cfcf;
                    `;

                    tag.innerHTML = `
                        <div class="sf-assign-icon-box small">
                            <img src="${iconSrc}">
                        </div>
                        <span>待轉出: ${cleanName}</span>
                    `;

                    const container = subjectCell.querySelector('a') || subjectCell.querySelector('.slds-truncate') || subjectCell;
                    container.classList.add('cart-subject-container');

                    if (container.firstChild) container.insertBefore(tag, container.firstChild);
                    else container.appendChild(tag);
                }
            }

            const chk = tr.querySelector('input[type="checkbox"]');
            if (chk) chk.disabled = true;
        }

        unfreezeRows(assignee) {
            const tableBody = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE_BODY);
            if (!this.highlightMemory) this.highlightMemory = new Map();

            if (tableBody) {
                tableBody.querySelectorAll(`tr[data-queued-assignee="${assignee}"]`).forEach(tr => {
                    tr.removeAttribute('data-queued-assignee');

                    const caseNum = this.extractCaseNumberFromRow(tr);
                    if (caseNum && this.highlightMemory.has(caseNum)) {
                        tr.style.backgroundColor = this.highlightMemory.get(caseNum);
                        tr.setAttribute('data-highlighted-by-script', 'true');
                    } else {
                        tr.style.backgroundColor = "";
                    }

                    tr.style.opacity = "";
                    tr.style.pointerEvents = "";

                    const tag = tr.querySelector('.cart-tag');
                    if (tag) tag.remove();

                    const subjectContainer = tr.querySelector('.cart-subject-container');
                    if (subjectContainer) subjectContainer.classList.remove('cart-subject-container');

                    const chk = tr.querySelector('input[type="checkbox"]');
                    if (chk) chk.disabled = false;
                });
            }
        }

        // =================================================================================
        // ✨ 新增/優化：中控中心與記錄面板
        // =================================================================================

        showCartManagerDialog() {
            const C = this.constructor.CONFIG;
            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            let assignees = Object.keys(cart);

            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const box = document.createElement('div');
            box.className = 'custom-dialog-box';
            box.style.maxWidth = '550px';

            const title = document.createElement('div');
            title.className = 'custom-dialog-title';
            title.textContent = "分派中心";

            const details = document.createElement('div');
            details.className = 'custom-dialog-details';
            details.style.maxHeight = '300px';

            const renderCartList = () => {
                cart = GM_getValue(C.STORAGE_KEY_CART, {});
                assignees = Object.keys(cart);

                if (assignees.length === 0) {
                    details.innerHTML = `
                        <div style="text-align:center; padding: 25px 10px; color:#666;">
                            <div style="font-size:16px; font-weight:bold; color:#444;">目前分派隊列為空</div>
                            <div style="font-size:13px; color:#888; margin-top:5px;">請先在列表中勾選 Case 並點擊「加入分派隊列」</div>
                        </div>
                    `;
                    return;
                }

                details.innerHTML = '';
                assignees.forEach(key => {
                    // ✨ 原生化：提取圖標與名稱
                    const isQueue = key.startsWith('Q:');
                    const iconSrc = isQueue ? '/img/icon/t4v35/standard/orders_120.png' : '/img/icon/t4v35/standard/user_120.png';
                    const displayName = key.substring(2);

                    const row = document.createElement('div');
                    row.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #eee;";
                    row.innerHTML = `
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div class="sf-assign-icon-box"><img src="${iconSrc}"></div>
                            <div style="font-size:14px; color:#333; text-align: left;">
                                <strong>${displayName}</strong> <span style="color:#666; font-size: 13px;">(${cart[key].length} 筆)</span>
                            </div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button class="btn-reselect" style="padding:4px 8px; font-size:12px; background:#e8f5e9; color:#2e7d32; border:1px solid #c8e6c9; border-radius:4px; cursor:pointer;">重新編輯</button>
                            <button class="btn-edit" style="padding:4px 8px; font-size:12px; background:#eef4fc; color:#0070d2; border:1px solid #d8dde6; border-radius:4px; cursor:pointer;">修改對象</button>
                            <button class="btn-clear" style="padding:4px 8px; font-size:12px; background:#fff0f0; color:#c23934; border:1px solid #f2cfcf; border-radius:4px; cursor:pointer;">移出</button>
                        </div>
                    `;

                    row.querySelector('.btn-reselect').onclick = () => {
                        const targetIds = cart[key];
                        this.unfreezeRows(key);
                        delete cart[key];
                        GM_setValue(C.STORAGE_KEY_CART, cart);

                        targetIds.forEach(id => {
                            const tr = this.findElementInShadowDom(`tr[data-row-key-value="${id}"]`);
                            if (tr) {
                                const chk = tr.querySelector('input[type="checkbox"]');
                                if (chk && !chk.disabled && !chk.checked) chk.click();
                            }
                        });
                        document.body.removeChild(overlay);
                        this.updateCartButtonsUI(Object.keys(cart).reduce((sum, k) => sum + cart[k].length, 0));
                        this.showCartManagerDialog();
                    };

                    row.querySelector('.btn-edit').onclick = async () => {
                        const res = await this.promptAssigneeWithUI(displayName, isQueue ? 'Q' : 'U');
                        if (res && res.name) {
                            const newKey = `${res.type}:${res.name}`;
                            if (newKey !== key) {
                                if (cart[newKey]) cart[newKey] = cart[newKey].concat(cart[key]);
                                else cart[newKey] = cart[key];
                                delete cart[key];
                                GM_setValue(C.STORAGE_KEY_CART, cart);

                                this.unfreezeRows(key);
                                cart[newKey].forEach(id => {
                                    const tr = this.findElementInShadowDom(`tr[data-row-key-value="${id}"]`);
                                    if (tr) this.applyVisualFreeze(tr, newKey);
                                });
                                renderCartList();
                            }
                        }
                    };

                    row.querySelector('.btn-clear').onclick = () => {
                        if (confirm(`確定將分給 [${displayName}] 的所有案件移出隊列嗎？`)) {
                            this.unfreezeRows(key);
                            delete cart[key];
                            GM_setValue(C.STORAGE_KEY_CART, cart);
                            renderCartList();
                            this.updateCartButtonsUI(Object.keys(cart).reduce((sum, k) => sum + cart[k].length, 0));
                            document.body.removeChild(overlay);
                            this.showCartManagerDialog();
                        }
                    };

                    details.appendChild(row);
                });
            };

            renderCartList();

            const handleClearAll = () => {
                if (confirm("確定要清空所有分派隊列嗎？\n\n這將會還原所有鎖定案件。")) {
                    cart = GM_getValue(C.STORAGE_KEY_CART, {});
                    Object.keys(cart).forEach(name => {
                        this.unfreezeRows(name);
                    });
                    GM_setValue(C.STORAGE_KEY_CART, {});
                    document.body.removeChild(overlay);
                    this.updateCartButtonsUI(0);
                    this.showNotification("已還原所有鎖定案件並清空隊列。", "success");
                }
            };

            const handleExportCart = () => {
                cart = GM_getValue(C.STORAGE_KEY_CART, {});
                const idMap = JSON.parse(localStorage.getItem('salesforce_id_to_case_map') || '{}');
                let exportText = "";
                let totalTasks = 0;

                Object.keys(cart).forEach(name => {
                    const caseNumbers = [];
                    cart[name].forEach(id => {
                        if (idMap[id]) {
                            caseNumbers.push(idMap[id]);
                        } else {
                            const tr = this.findElementInShadowDom(`tr[data-row-key-value="${id}"]`);
                            if (tr) {
                                const cn = this.extractCaseNumberFromRow(tr);
                                if (cn) {
                                    caseNumbers.push(cn);
                                    idMap[id] = cn;
                                }
                            }
                        }
                    });

                    if (caseNumbers.length > 0) {
                        exportText += `=== ${name} (共 ${caseNumbers.length} 筆) ===\n`;
                        exportText += caseNumbers.join('\n') + '\n\n';
                        totalTasks += caseNumbers.length;
                    }
                });

                localStorage.setItem('salesforce_id_to_case_map', JSON.stringify(idMap));

                if (totalTasks === 0) {
                    this.showNotification("無法獲取任何單號，請確認隊列中是否含有有效單號。", "error");
                    return;
                }

                this.showExportDialog(exportText, totalTasks);
            };

            // ✨ 動態判定是否空車
            const isCartEmpty = assignees.length === 0;

            const btns = document.createElement('div');
            btns.style.cssText = "display: flex; flex-direction: column; gap: 12px; margin-top: 15px;";

            // 第一排：開始分派 (極速/穩定雙按鈕)
            // ✨ 第一排：開始分派 (極簡智能單一按鈕：短按穩定 / 長按 3 秒極速)
            const row1 = document.createElement('div');
            row1.className = 'custom-dialog-buttons';
            row1.style.cssText = "display: grid; grid-template-columns: 1fr;"; // 滿版單按鈕

            const btnStart = document.createElement('button');
            btnStart.className = isCartEmpty ? 'btn-secondary' : 'btn-primary';
            btnStart.textContent = "開始自動分派";

            // ✨ 更新懸浮提示 (詳細運作原理說明)
            btnStart.title =
                "【普通點擊】 啟動「穩定模式」 (日常推薦)\n" +
                "分派返回後，腳本會自動點擊「重新整理」並嚴格校驗，\n" +
                "確保上一批案件徹底從列表中消失後，才執行下一輪。\n" +
                "特性：防死鎖、防殘留、100% 防止錯分。\n\n" +
                "【長按 3 秒】 啟動「極速模式」 (網路極佳時使用)\n" +
                "分派返回後，不進行刷新等待，立即展開列表執行下一輪。\n" +
                "特性：省時極速，但若系統同步較慢可能會抓到舊資料。";

            if (isCartEmpty) {
                btnStart.disabled = true;
            } else {
                let pressTimer;
                let isLongPress = false;

                // 滑鼠按下：開始無聲計時
                btnStart.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return; // 僅限滑鼠左鍵
                    isLongPress = false;

                    // 按滿 3 秒後，直接執行極速模式
                    pressTimer = setTimeout(() => {
                        isLongPress = true;
                        document.body.removeChild(overlay);
                        this.startAutoDispatchExecution('fast'); // ⚡ 極速模式
                    }, 3000);
                });

                // 滑鼠放開：如果還沒到 3 秒，就執行普通的穩定模式
                btnStart.addEventListener('mouseup', (e) => {
                    if (e.button !== 0) return;
                    if (!isLongPress) {
                        clearTimeout(pressTimer); // 取消長按計時
                        document.body.removeChild(overlay);
                        this.startAutoDispatchExecution('stable'); // 🛡️ 穩定模式
                    }
                });

                // 防呆：如果中途滑鼠移走，直接取消計時
                btnStart.addEventListener('mouseleave', () => {
                    if (!isLongPress) clearTimeout(pressTimer);
                });
            }

            row1.appendChild(btnStart);

            // 第二排：導出 / 清除 / 關閉 (三等分)
            const row2 = document.createElement('div');
            row2.className = 'custom-dialog-buttons';
            row2.style.cssText = "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 0;";

            const btnExport = document.createElement('button');
            btnExport.className = isCartEmpty ? 'btn-secondary' : 'btn-export';
            btnExport.textContent = "導出分派任務";
            if (isCartEmpty) btnExport.disabled = true;
            btnExport.onclick = handleExportCart;

            const btnClearAll = document.createElement('button');
            btnClearAll.className = 'btn-secondary';
            if (!isCartEmpty) {
                btnClearAll.style.backgroundColor = '#ffebee';
                btnClearAll.style.color = '#c23934';
            }
            btnClearAll.textContent = "清除所有隊列";
            if (isCartEmpty) btnClearAll.disabled = true;
            btnClearAll.onclick = handleClearAll;

            const btnCancel = document.createElement('button');
            btnCancel.className = 'btn-secondary';
            btnCancel.textContent = "關閉面板";
            btnCancel.onclick = () => document.body.removeChild(overlay);

            row2.append(btnExport, btnClearAll, btnCancel);

            // ✨ 第三排：今日記錄 (滿版，常駐亮起)
            const row3 = document.createElement('div');
            row3.className = 'custom-dialog-buttons';
            row3.style.cssText = "display: grid; grid-template-columns: 1fr; margin-top: 5px;";
            const btnHistory = document.createElement('button');
            btnHistory.className = 'btn-secondary';
            btnHistory.style.cssText = "background-color: #f4f6f9; color: #0070d2; border: 1px dashed #0070d2; display: flex; justify-content: center; align-items: center; gap: 8px;";
            btnHistory.innerHTML = `查看今日分派記錄`;
            btnHistory.onclick = () => {
                document.body.removeChild(overlay);
                this.showDispatchHistoryDialog();
            };
            row3.appendChild(btnHistory);

            btns.append(row1, row2, row3);
            box.append(title, details, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        // ✨ 記錄 UI 渲染 (時間軸批次模式)
        // ✨ 戰報 UI 渲染 (輪次聚合與摺疊模式)
        showDispatchHistoryDialog() {
            const C = this.constructor.CONFIG;
            const today = new Date();
            const safeToday = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

            let historyData = GM_getValue(C.STORAGE_KEY_HISTORY, { date: '', records: {} });
            if (historyData.date !== safeToday) {
                historyData = { date: safeToday, records: {} };
                GM_setValue(C.STORAGE_KEY_HISTORY, historyData);
            }

            const records = historyData.records;
            const assignees = Object.keys(records);

            // 1. 扁平化整合
            let timeline = [];
            assignees.forEach(name => {
                const batches = records[name];
                if (Array.isArray(batches)) {
                    batches.forEach(b => {
                        if (typeof b === 'string') {
                            timeline.push({ time: '歷史歸檔', name: name, cases: [b] });
                        } else if (b && Array.isArray(b.cases)) {
                            timeline.push({ time: b.timestamp, name: name, cases: b.cases });
                        }
                    });
                }
            });

            // 2. 依照時間排序
            timeline.sort((a, b) => {
                if (a.time === '歷史歸檔') return -1;
                if (b.time === '歷史歸檔') return 1;
                return a.time.localeCompare(b.time);
            });

            // 3. 智能聚合輪次 (判斷間隔大於 30 分鐘為新的一輪)
            let rounds = [];
            let currentRound = null;

            const timeToSeconds = (t) => {
                if(t === '歷史歸檔') return 0;
                const [h, m, s] = t.split(':').map(Number);
                return h * 3600 + m * 60 + s;
            };

            let lastTimeSec = -1;

            timeline.forEach(batch => {
                const currentSec = timeToSeconds(batch.time);
                if (!currentRound || (currentSec !== 0 && currentSec - lastTimeSec > 1800)) {
                    currentRound = {
                        id: rounds.length + 1,
                        startTime: batch.time,
                        batches: []
                    };
                    rounds.push(currentRound);
                }
                currentRound.batches.push(batch);
                if (currentSec !== 0) lastTimeSec = currentSec;
            });

            // ✨ 4. 同輪人員智能合併 (Merge by Assignee within Round)
            let totalDispatched = 0;
            rounds.forEach(round => {
                const mergedMap = new Map();
                round.batches.forEach(batch => {
                    if (!mergedMap.has(batch.name)) {
                        mergedMap.set(batch.name, {
                            name: batch.name,
                            time: batch.time, // 保留該員在此輪的首次派送時間
                            cases: [...batch.cases]
                        });
                    } else {
                        // 若同輪中已存在該人員，則合併單號並去重
                        const existing = mergedMap.get(batch.name);
                        existing.cases = [...new Set([...existing.cases, ...batch.cases])];
                    }
                });

                // 將該輪的批次替換為「合併後的人員陣列」
                round.batches = Array.from(mergedMap.values());
                // 計算該輪精確總數
                round.totalCases = round.batches.reduce((sum, b) => sum + b.cases.length, 0);
                totalDispatched += round.totalCases;
            });

            // UI 構建
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const box = document.createElement('div');
            box.className = 'custom-dialog-box';
            box.style.maxWidth = '580px';
            box.style.padding = '20px';

            box.innerHTML = `
                <div class="custom-dialog-title" style="margin-bottom: 8px;">今日派送戰報</div>
                <div style="font-size: 13px; color: #0070d2; margin-bottom: 15px; background: #eef4fc; padding: 8px; border-radius: 4px; font-weight: bold; border: 1px solid #d8dde6;">
                    今日總計成功派送：<span style="font-size: 15px;">${totalDispatched}</span> 筆
                </div>
            `;

            const details = document.createElement('div');
            details.className = 'custom-dialog-details';
            details.style.maxHeight = '400px';
            details.style.textAlign = 'left';
            details.style.padding = '5px';
            details.style.backgroundColor = '#fff';
            details.style.border = 'none';

            let globalExportText = `=== ${safeToday} 總派送戰報 ===\n今日共派送：${totalDispatched} 筆\n\n`;

            if (rounds.length === 0) {
                details.innerHTML = '<div style="text-align:center; padding: 30px 0; color:#888; border: 1px dashed #ccc; border-radius: 6px;">今日尚未有任何成功分派的記錄。</div>';
                globalExportText += "今日尚無記錄。";
            } else {
                rounds.forEach((round, rIndex) => {
                    const isLastRound = rIndex === rounds.length - 1;
                    const displayState = isLastRound ? 'block' : 'none';
                    const iconState = isLastRound ? '▼' : '▶';

                    let roundExportText = `=== 第 ${round.id} 輪派送任務 (開始於 ${round.startTime}) - 共 ${round.totalCases} 筆 ===\n\n`;
                    let batchesHtml = '';

                    round.batches.forEach((batch, bIndex) => {
                        // 導出純文字排版
                        const batchText = `分配給：${batch.name} (共 ${batch.cases.length} 筆)\n${batch.cases.join('\n')}\n\n`;
                        roundExportText += batchText;
                        globalExportText += batchText;

                        // ✨ 原生化：提取圖標與名稱
                        const isQueue = batch.name.startsWith('Q:');
                        const iconSrc = isQueue ? '/img/icon/t4v35/standard/orders_120.png' : '/img/icon/t4v35/standard/user_120.png';
                        const displayName = batch.name.startsWith('Q:') || batch.name.startsWith('U:') ? batch.name.substring(2) : batch.name;

                        batchesHtml += `
                            <div style="margin-bottom: 12px; border-bottom: ${bIndex < round.batches.length - 1 ? '1px dashed #eee' : 'none'}; padding-bottom: 10px; margin-left: 10px;">
                                <div style="font-size: 13px; color: #555; font-weight: bold; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="display: flex; align-items: center; gap: 6px; background: #eef4fc; padding: 2px 8px 2px 2px; border-radius: 4px; border: 1px solid #cce4f6; color: #0070d2;">
                                        <div class="sf-assign-icon-box small"><img src="${iconSrc}"></div>
                                        <span>${displayName}</span>
                                    </span>
                                    <span style="font-size: 11px; color: #888;">⏱️ ${batch.time} (共 ${batch.cases.length} 筆)</span>
                                </div>
                                <div style="font-family: monospace; font-size: 12px; color: #444; word-break: break-all; background: #fbfbfb; padding: 6px; border: 1px solid #eee; border-radius: 4px;">
                                    ${batch.cases.join(', ')}
                                </div>
                            </div>
                        `;
                    });

                    // 構建輪次卡片
                    const roundCard = document.createElement('div');
                    roundCard.style.cssText = `margin-bottom: 10px; border: 1px solid #d8dde6; border-radius: 6px; overflow: hidden; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.05);`;

                    const header = document.createElement('div');
                    header.style.cssText = `background: #f4f6f9; padding: 10px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.2s; border-bottom: ${isLastRound ? '1px solid #d8dde6' : 'none'};`;
                    header.onmouseover = () => header.style.background = '#eef4fc';
                    header.onmouseout = () => header.style.background = '#f4f6f9';

                    header.innerHTML = `
                        <div style="font-weight: bold; font-size: 14px; color: #181818; display: flex; align-items: center; gap: 8px;">
                            <span class="toggle-icon" style="color: #0070d2; font-size: 12px; width: 12px; text-align: center;">${iconState}</span>
                            第 ${round.id} 輪派送 <span style="font-size: 12px; color: #666; font-weight: normal;">(共 ${round.totalCases} 筆)</span>
                        </div>
                    `;

                    // 單輪複製按鈕
                    const btnCopyRound = document.createElement('button');
                    btnCopyRound.innerHTML = '複製此輪記錄';
                    btnCopyRound.style.cssText = `background: #fff; border: 1px solid #c9c9c9; border-radius: 4px; padding: 4px 8px; font-size: 11px; color: #333; cursor: pointer; font-weight: bold; transition: all 0.2s; outline: none;`;
                    btnCopyRound.onmouseover = () => { btnCopyRound.style.borderColor = '#0070d2'; btnCopyRound.style.color = '#0070d2'; };
                    btnCopyRound.onmouseout = () => { btnCopyRound.style.borderColor = '#c9c9c9'; btnCopyRound.style.color = '#333'; };

                    btnCopyRound.onclick = async (e) => {
                        e.stopPropagation();
                        await navigator.clipboard.writeText(roundExportText.trim());
                        const originalText = btnCopyRound.innerHTML;
                        btnCopyRound.innerHTML = '✅ 已複製';
                        btnCopyRound.style.background = '#e8f5e9';
                        btnCopyRound.style.color = '#2e7d32';
                        btnCopyRound.style.borderColor = '#c8e6c9';
                        setTimeout(() => {
                            btnCopyRound.innerHTML = originalText;
                            btnCopyRound.style.background = '#fff';
                            btnCopyRound.style.color = '#333';
                            btnCopyRound.style.borderColor = '#c9c9c9';
                        }, 1500);
                    };
                    header.appendChild(btnCopyRound);

                    const body = document.createElement('div');
                    body.style.cssText = `display: ${displayState}; padding: 12px 12px 2px 12px;`;
                    body.innerHTML = batchesHtml;

                    // 摺疊/展開
                    header.onclick = () => {
                        const isHidden = body.style.display === 'none';
                        body.style.display = isHidden ? 'block' : 'none';
                        header.style.borderBottom = isHidden ? '1px solid #d8dde6' : 'none';
                        header.querySelector('.toggle-icon').textContent = isHidden ? '▼' : '▶';
                    };

                    roundCard.appendChild(header);
                    roundCard.appendChild(body);
                    details.appendChild(roundCard);
                });
            }

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';
            btns.style.gridTemplateColumns = '1fr 1fr 1fr';
            btns.style.marginTop = '15px';

            const btnCopyGlobal = document.createElement('button');
            btnCopyGlobal.className = rounds.length === 0 ? 'btn-secondary' : 'btn-primary';
            btnCopyGlobal.textContent = "複製所有記錄";
            if (rounds.length === 0) btnCopyGlobal.disabled = true;
            btnCopyGlobal.onclick = async () => {
                await navigator.clipboard.writeText(globalExportText.trim());
                const originalText = btnCopyGlobal.textContent;
                btnCopyGlobal.textContent = "✅ 已複製全部！";
                setTimeout(() => btnCopyGlobal.textContent = originalText, 1500);
            };

            const btnClear = document.createElement('button');
            btnClear.className = 'btn-secondary';
            btnClear.textContent = "手動清空";
            if (rounds.length > 0) {
                btnClear.style.color = '#c23934';
            } else {
                btnClear.disabled = true;
            }
            btnClear.onclick = () => {
                if (confirm("⚠️ 確定要提早清空今日的戰報記錄嗎？\n清空後無法復原。")) {
                    GM_setValue(C.STORAGE_KEY_HISTORY, { date: safeToday, records: {} });
                    document.body.removeChild(overlay);
                    this.showDispatchHistoryDialog();
                }
            };

            const btnClose = document.createElement('button');
            btnClose.className = 'btn-secondary';
            btnClose.textContent = "關閉";
            btnClose.onclick = () => document.body.removeChild(overlay);

            btns.append(btnCopyGlobal, btnClear, btnClose);
            box.append(details, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        startAutoDispatchExecution(mode = 'fast') {
            const C = this.constructor.CONFIG;
            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            let assignees = Object.keys(cart);
            if (assignees.length === 0) return;

            let totalTasks = 0;
            assignees.forEach(a => totalTasks += cart[a].length);

            // ✨ 上鎖：將自動分派任務綁定給當前這個分頁
            GM_setValue(C.STORAGE_KEY_AUTORUN, { active: true, assignMode: mode, tabLock: this.tabId });
            this.injectEmergencyStopButton();

            this._executeFullLoadAndProcess(() => this.processNextBatch());
        }

        injectEmergencyStopButton() {
            let btn = document.getElementById('emergency-stop-btn');
            if (btn) return;
            btn = document.createElement('button');
            btn.id = 'emergency-stop-btn';
            btn.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:99999; background-color:#c23934; color:white; font-weight:bold; padding:6px 8px; border:none; border-radius:8px; cursor:pointer; box-shadow:0 4px 15px rgba(0,0,0,0.4); font-size:16px; font-family:sans-serif; transition: background-color 0.2s;';
            btn.textContent = '終止任務';

            btn.onclick = () => {
                GM_setValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                btn.textContent = '已強制終止';
                btn.style.backgroundColor = '#7a1f1d';
                this.showNotification("🛑 已接收到強制終止指令，正在中斷所有背景任務...", "error");

                // ✨ 修復 3-1：瞬間拆除加載黑屏與解鎖按鈕
                const overlay = document.getElementById('full-load-overlay');
                if (overlay) overlay.remove();
                this.setButtonsDisabled(false);

                setTimeout(() => this.removeEmergencyStopButton(), 2000);
            };
            document.body.appendChild(btn);
        }

        removeEmergencyStopButton() {
            const btn = document.getElementById('emergency-stop-btn');
            if (btn) btn.remove();
        }

        // ✨ 新增輔助方法：強制深度清空當前列表的所有選取狀態
        clearAllSelections(tableBody) {
            if (!tableBody) return;
            const table = tableBody.closest('table');
            if (table) {
                const headerChk = table.querySelector('thead input[type="checkbox"]');
                if (headerChk && headerChk.checked) {
                    headerChk.disabled = false;
                    headerChk.click();
                }
            }
            const checkedBoxes = tableBody.querySelectorAll('input[type="checkbox"]:checked');
            checkedBoxes.forEach(chk => {
                chk.disabled = false;
                chk.click();
            });
        }

        async processNextBatch() {
            const C = this.constructor.CONFIG;

            const autorunState = GM_getValue(C.STORAGE_KEY_AUTORUN, { active: false });
            if (!autorunState.active) {
                this.removeEmergencyStopButton();
                alert("🛑 自動分派任務已被手動終止。");
                this.setButtonsDisabled(false);
                return;
            }

            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            let assignee = Object.keys(cart).find(k => cart[k].length > 0);

            if (!assignee) {
                GM_setValue(C.STORAGE_KEY_AUTORUN, { active: false });
                this.removeEmergencyStopButton();
                alert("🎉 所有分派隊列已執行完畢！");
                this.updateCartButtonsUI(0);
                return;
            }

            const targetIds = cart[assignee];
            const MAX_CHUNK = 50;

            this.setButtonsDisabled(true);

            const tableBody = this.findElementInShadowDom(C.SELECTORS.TABLE_BODY);
            if (!tableBody) return;

            // 1. 強制清空目前表格內「所有」選取狀態，防止上一批次或手動勾選殘留
            this.clearAllSelections(tableBody);
            await this.delay(300); // 給予 Salesforce 框架反應與狀態同步時間

            let foundRows = [];
            let processedIds = [];
            let processedCaseNums = [];

            const scroller = this.getScrollParent(tableBody);

            let attempts = 0;
            while(processedIds.length < Math.min(MAX_CHUNK, targetIds.length) && attempts < 15) {
                const rows = tableBody.querySelectorAll(C.SELECTORS.TABLE_ROW);
                rows.forEach(tr => {
                    const id = tr.getAttribute('data-row-key-value');
                    if (targetIds.includes(id) && !processedIds.includes(id) && processedIds.length < MAX_CHUNK) {
                        processedIds.push(id);
                        foundRows.push(tr);

                        const cn = this.extractCaseNumberFromRow(tr);
                        if (cn) processedCaseNums.push(cn);
                    }
                });

                if (processedIds.length < Math.min(MAX_CHUNK, targetIds.length)) {
                    if (scroller && scroller !== document.documentElement) {
                        scroller.scrollTop += 600;
                        await this.delay(350);
                    }
                    attempts++;
                } else {
                    break;
                }
            }

            // ✨ 智能幽靈案件清理機制：第一回合直接了斷 (一刀切)
            const expectedChunk = targetIds.slice(0, MAX_CHUNK);
            const ghostIds = expectedChunk.filter(id => !processedIds.includes(id));

            if (ghostIds.length > 0) {
                let idMap = JSON.parse(localStorage.getItem('salesforce_id_to_case_map') || '{}');
                const ghostCaseNums = ghostIds.map(id => idMap[id] || '未知單號');

                console.warn(`[自動分派核心] 發現 ${ghostIds.length} 筆案件已從列表中消失 (已被拿走/結案):`, ghostCaseNums);
                this.showNotification(`💡 發現 ${ghostIds.length} 筆案件已移出，自動跳過並寫入戰報。`, "info");

                // 1. 立即從購物車中永久剔除，絕不留到第二回合
                cart[assignee] = cart[assignee].filter(id => !ghostIds.includes(id));
                if (cart[assignee].length === 0) delete cart[assignee];
                GM_setValue(C.STORAGE_KEY_CART, cart);

                // 2. 直接寫入戰報紀錄，明確標示狀態為「已被接走」
                const today = new Date();
                const safeToday = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
                const timeString = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}:${String(today.getSeconds()).padStart(2, '0')}`;

                let historyData = GM_getValue(C.STORAGE_KEY_HISTORY, { date: safeToday, records: {} });
                if (historyData.date !== safeToday) historyData = { date: safeToday, records: {} };
                if (!historyData.records[assignee]) historyData.records[assignee] = [];

                historyData.records[assignee].push({
                    timestamp: timeString,
                    cases: ghostCaseNums.map(c => `${c} (⚠️ 已被接走)`)
                });
                GM_setValue(C.STORAGE_KEY_HISTORY, historyData);
            }

            // 處理本批次全數都是幽靈的情況 (例如 5 筆全都不見了)
            if (foundRows.length === 0) {
                console.log(`[自動分派核心] [${assignee}] 本批次案件已全數消失，自動處理下一順位...`);
                this.updateCartButtonsUI(Object.keys(cart).reduce((sum, k) => sum + cart[k].length, 0));

                // 接力下一批 (若全空，則下一批啟動時會觸發「圓滿結束」的早退機制)
                setTimeout(() => { this.processNextBatch(); }, 500);
                return;
            }

            let totalRemaining = 0;
            Object.keys(cart).forEach(k => {
                totalRemaining += cart[k].length;
            });
            totalRemaining -= processedIds.length;

            // 🛡️ 寫入保護名單與戰報用的單號
            GM_setValue(C.STORAGE_KEY_AUTORUN, {
                active: true,
                assignMode: autorunState.assignMode || 'fast',
                assignee: assignee,
                processedIds: processedIds,
                processedCaseNums: processedCaseNums,
                remaining: totalRemaining,
                tabLock: this.tabId // ✨ 續期上鎖，確保下一棒依然屬於自己
            });

            // 2. 僅勾選當前目標人的 Case
            foundRows.forEach(tr => {
                tr.style.pointerEvents = 'auto';
                tr.removeAttribute('data-queued-assignee');
                const chk = tr.querySelector('input[type="checkbox"]');
                if (chk) {
                    chk.disabled = false;
                    if (!chk.checked) chk.click();
                }
            });

            // 3. 主動校驗防禦機制（防錯分核心邏輯）
            await this.delay(300); // 確保 LWC checkbox click 事件冒泡完成
            const actualCheckedCount = tableBody.querySelectorAll('input[type="checkbox"]:checked').length;
            const expectedCount = foundRows.length;

            if (actualCheckedCount !== expectedCount) {
                console.error(`[自動分派安全校驗失敗] 期望勾選: ${expectedCount} 筆，實際勾選: ${actualCheckedCount} 筆。`);
                this.showNotification(`⚠️ 安全校驗攔截：本批次期望勾選 ${expectedCount} 筆，但系統實際檢測到有 ${actualCheckedCount} 筆被勾選！分派已被自動終止以防錯分。`, "error");
                GM_setValue(C.STORAGE_KEY_AUTORUN, { active: false });
                this.removeEmergencyStopButton();
                this.setButtonsDisabled(false);
                return;
            }

            await this.waitForSFSelectedCount(processedIds.length);

            // ✨ 優化：在勾選完成且驗證通過後，引入 5 秒防頻安全冷卻時間
            this.showNotification(`⏳ 勾選校驗完成！目標: [${assignee}]，防錯安全冷卻 1 秒中...`, "info");
            await this.delay(1000);

            // 🛡️ 二次安全檢測：防止用戶在 5 秒冷卻等待期點擊了「終止自動分派」
            const postDelayState = GM_getValue(C.STORAGE_KEY_AUTORUN, { active: false });
            if (!postDelayState.active) {
                this.removeEmergencyStopButton();
                this.showNotification("🛑 分派任務已在安全冷卻期被手動終止，已攔截跳轉。", "error");
                this.setButtonsDisabled(false);
                return;
            }

            const changeOwnerBtn = this.findElementInShadowDom('li[data-target-selection-name="sfdc:CustomButton.Case.Change_Owner"] a');
            if (changeOwnerBtn) {
                console.log(`[自動分派引擎] 狀態已同步且冷卻結束，即將進入VF，發送 ${processedIds.length} 筆案件`);
                changeOwnerBtn.click();
            } else {
                this.showNotification("錯誤：找不到原生的 Change Owner 按鈕！自動任務終止。", "error");
                GM_setValue(C.STORAGE_KEY_AUTORUN, { active: false });
                this.removeEmergencyStopButton();
            }
        }

        async waitForSFSelectedCount(targetCount) {
            const startTime = Date.now();
            const countSpan = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TOTAL_COUNT_SPAN);

            while (Date.now() - startTime < 1600) {
                if (countSpan && countSpan.textContent) {
                    const text = countSpan.textContent.toLowerCase();
                    if (text.includes(`${targetCount} item`)) {
                        console.log(`[自動分派引擎] 狀態握手成功：Salesforce 已確認勾選 ${targetCount} 筆。`);
                        break;
                    }
                }
                await this.delay(100);
            }
            await this.delay(200);
        }

        loadAssignCache() {
            const raw = localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY_CACHE);
            if (!raw) return {};
            try {
                const cache = JSON.parse(raw);
                const now = Date.now();
                let hasChanges = false;
                let removedNewUnassignCount = 0;
                Object.keys(cache).forEach(tn => {
                    const item = cache[tn];
                    const person = item && typeof item.name === 'string'
                        ? item.name.trim().toUpperCase()
                        : '';
                    if (person === "NEW UNASSIGN") {
                        delete cache[tn];
                        hasChanges = true;
                        removedNewUnassignCount++;
                    } else if (!item || typeof item !== 'object' || now > item.expiry) {
                        delete cache[tn];
                        hasChanges = true;
                    }
                });
                if (hasChanges) localStorage.setItem(this.constructor.CONFIG.STORAGE_KEY_CACHE, JSON.stringify(cache));
                if (removedNewUnassignCount > 0) {
                    console.log(`[緩存] 已自動清除 ${removedNewUnassignCount} 條歷史 New Unassign 緩存。`);
                }
                return cache;
            } catch (e) {
                return {};
            }
        }

        saveAssignCache(dataMap) {
            const cache = this.loadAssignCache();
            const now = Date.now();
            const defaultExpiry = now + this.constructor.CONFIG.TIMEOUTS.CACHE_EXPIRY;
            const shortExpiry = now + this.constructor.CONFIG.TIMEOUTS.CACHE_EXPIRY_SHORT;
            let savedCount = 0;
            let skippedNewUnassignCount = 0;
            dataMap.forEach((data, tn) => {
                const person = typeof data === 'object' ? data.name : data;
                const source = typeof data === 'object' ? data.source : 'page';
                const normalizedPerson = typeof person === 'string'
                    ? person.trim().toUpperCase()
                    : '';
                if (normalizedPerson === "NEW UNASSIGN") {
                    if (cache[tn]) {
                        delete cache[tn];
                    }
                    skippedNewUnassignCount++;
                    return;
                }
                const expiryTime = (person === "No ERN") ? shortExpiry : defaultExpiry;
                cache[tn] = { name: person, expiry: expiryTime, source: source };
                savedCount++;
            });
            localStorage.setItem(this.constructor.CONFIG.STORAGE_KEY_CACHE, JSON.stringify(cache));
            console.log(`[緩存] 已更新 ${savedCount} 條記錄，略過 ${skippedNewUnassignCount} 條 New Unassign。`);
        }

        clearAssignCache() {
            localStorage.removeItem(this.constructor.CONFIG.STORAGE_KEY_CACHE);
            this.showNotification(this.constructor.CONFIG.TEXT.CACHE_CLEARED, 'success');
        }

        extractTrackingNumberFromRow(row) {
            const C = this.constructor.CONFIG;
            const extractAndSanitize = (text) => {
                if (!text) return null;
                const match = text.match(C.REGEX.TRACKING_NUMBER);
                if (match) {
                    return match[0].replace(/\s+/g, '').toUpperCase();
                }
                return null;
            };

            const subjectCell = row.querySelector('td[data-label="Subject"]');
            let tn = extractAndSanitize(subjectCell ? subjectCell.innerText : null);
            if (tn) return tn;

            const tnCell = row.querySelector('td[data-label="Tracking Number(s)"]');
            tn = extractAndSanitize(tnCell ? tnCell.innerText : null);
            if (tn) return tn;

            const descCell = row.querySelector('td[data-label="Initial Description"]');
            tn = extractAndSanitize(descCell ? descCell.innerText : null);

            return tn;
        }

        extractCaseNumberFromRow(row) {
            const C = this.constructor.CONFIG;
            const cell = row.querySelector('td[data-label="Case Number"]');
            const text = cell ? cell.innerText : row.innerText;
            const match = text.match(C.REGEX.CASE_NUMBER);
            if (match) {
                return match[0].toUpperCase();
            }
            return null;
        }

        async _executeFullLoadAndProcess(processor) {
            if (this.isLoading) return this.showNotification("正在處理中，請勿重複點擊。", "info");
            const table = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE);
            if (!table) return this.showNotification('錯誤：找不到案件列表表格！', 'error');

            this.isLoading = true;
            this.setButtonsDisabled(true);
            const overlay = document.createElement('div');
            overlay.id = 'full-load-overlay';
            overlay.innerHTML = '<p>正在初始化...</p><p class="loader-subtitle">請稍候</p>';
            document.body.appendChild(overlay);

            try {
                const tableBody = table.querySelector('tbody');
                let lastRowCount = 0;
                let retryCount = 0;
                const MAX_RETRIES = 3;

                while (true) {
                    // ✨ 修復 3-2：每次滾動前檢查狀態機，如果被按下終止，瞬間粉碎迴圈退出
                    const currentAutorun = GM_getValue(this.constructor.CONFIG.STORAGE_KEY_AUTORUN, { active: false });
                    if (this.isLoading && !currentAutorun.active && document.getElementById('emergency-stop-btn')) {
                        console.warn("[自動加載模組] 偵測到強制終止指令，瞬間中斷加載迴圈！");
                        throw new Error("Aborted by user"); // 丟出錯誤直接跳轉到 catch/finally 區塊
                    }

                    const currentRowCount = tableBody.querySelectorAll('tr').length;
                    overlay.querySelector('p').textContent = `正在自動加載... (${currentRowCount} 條)`;

                    const countSpan = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TOTAL_COUNT_SPAN);
                    let isLoadComplete = false;

                    if (countSpan && countSpan.textContent) {
                        const txt = countSpan.textContent.trim();
                        if (!txt.includes('+')) {
                            const match = txt.match(/(\d+)\s*items/) || txt.match(/of\s+(\d+)/);
                            if (match && currentRowCount >= parseInt(match[1])) {
                                isLoadComplete = true;
                            }
                        }
                    }

                    if (isLoadComplete) {
                        overlay.querySelector('p').textContent = '數據加載完畢，等待畫面渲染...';
                        await this.delay(1200);
                        break;
                    }

                    // ✨ 修正：改為 currentRowCount >= 0，確保即使列表空轉也能增加重試次數，打破無限迴圈
                    if (lastRowCount === currentRowCount && currentRowCount >= 0) {
                        retryCount++;
                        if (retryCount >= MAX_RETRIES) {
                            console.warn(`[自動加載模組] 連續 ${MAX_RETRIES} 次未檢測到新數據 (當前 ${currentRowCount} 筆)，強制結束加載進入下一步。`);
                            break;
                        }
                    } else {
                        retryCount = 0;
                    }

                    lastRowCount = currentRowCount;
                    const lastRow = tableBody.querySelector('tr:last-child');

                    if (lastRow) {
                        lastRow.scrollIntoView({ behavior: 'auto', block: 'end' });
                        // 💡 統一使用最強的物理探測器，確保任何情況下加載都絕不失效
                        const scroller = this.getScrollParent(tableBody);
                        if (scroller && scroller !== document.documentElement) {
                            scroller.scrollTop = scroller.scrollHeight;
                        }
                    }

                    try {
                        await new Promise((res) => {
                            const obs = new MutationObserver(() => {
                                if (tableBody.querySelectorAll('tr').length > lastRowCount) {
                                    obs.disconnect();
                                    clearTimeout(tm);
                                    res();
                                }
                            });
                            const tm = setTimeout(() => {
                                obs.disconnect();
                                res();
                            }, 3000);
                            obs.observe(tableBody, { childList: true, subtree: true });
                        });
                        await this.delay(300);
                    } catch (e) {
                        break;
                    }
                }

                overlay.querySelector('p').textContent = '開始分析...';
                await this.delay(500);
                processor();

            } catch (err) {
                console.error(err);
                this.showNotification('自動加載發生異常，請檢查日誌。', 'error');
            } finally {
                document.body.removeChild(overlay);
                this.isLoading = false;
                this.setButtonsDisabled(false);
            }
        }

        startAssignAnalysis() {
            const map = this.parseAssignMap();
            if (map.size === 0) {
                this.showNotification(this.constructor.CONFIG.TEXT.ASSIGN_SETTINGS_EMPTY, 'info');
                this.showAssignSettingsDialog();
                return;
            }
            this._executeFullLoadAndProcess(() => this.performAssignAnalysis(false));
        }

        startTpxAnalysis() {
            const map = this.parseAssignMap();
            if (map.size === 0) {
                this.showNotification(this.constructor.CONFIG.TEXT.ASSIGN_SETTINGS_EMPTY, 'info');
                this.showAssignSettingsDialog();
                return;
            }
            this._executeFullLoadAndProcess(() => this.performAssignAnalysis(true));
        }

        performAssignAnalysis(ignorePageErn = false) {
            const C = this.constructor.CONFIG;
            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);

            this.clearHighlights();

            const thead = table.querySelector('thead');
            if (thead) thead.classList.remove(C.STYLE.STICKY_HEADER_CLASS);

            const assignMap = this.parseAssignMap();
            const resultMap = new Map();
            const unidentifiedMap = new Map();
            const cachePendingData = new Map();

            const cache = this.loadAssignCache();
            const rows = table.querySelectorAll(C.SELECTORS.TABLE_ROW);

            const totalRows = rows.length;
            let totalExtractedTNs = 0;
            const uniqueTNsSet = new Set();
            let noTnRowCount = 0;

            rows.forEach(row => {
                const rowTN = this.extractTrackingNumberFromRow(row);

                if (rowTN) {
                    totalExtractedTNs++;
                    uniqueTNsSet.add(rowTN);
                } else {
                    noTnRowCount++;
                }

                let isIdentified = false;
                let personName = null;

                if (rowTN && cache[rowTN]) {
                    const cachedItem = cache[rowTN];
                    if (ignorePageErn && cachedItem.source !== 'tpx') {
                        isIdentified = false;
                    } else {
                        personName = cachedItem.name;
                        isIdentified = true;
                    }
                }

                if (!ignorePageErn && !isIdentified) {
                    const match = row.innerText.match(C.REGEX.ERN_CODE);
                    if (match) {
                        const code = match[1].toUpperCase();
                        if (assignMap.has(code)) {
                            personName = assignMap.get(code);
                            isIdentified = true;
                            if (rowTN) {
                                cachePendingData.set(rowTN, { name: personName, source: 'page' });
                            }
                        }
                    }
                }

                if (isIdentified && personName) {
                    if (!resultMap.has(personName)) resultMap.set(personName, []);
                    resultMap.get(personName).push(row);
                }

                if (rowTN && !isIdentified) {
                    if (!unidentifiedMap.has(rowTN)) unidentifiedMap.set(rowTN, []);
                    unidentifiedMap.get(rowTN).push(row);
                }
            });

            const metrics = {
                totalRows,
                totalExtractedTNs,
                uniqueTNsCount: uniqueTNsSet.size,
                noTnRowCount
            };

            this.showAssignAnalysisDialog(table, unidentifiedMap, resultMap, cachePendingData, ignorePageErn, metrics);
        }

        showAssignAnalysisDialog(table, unidentifiedMap, resultMap, cachePendingData, ignorePageErn = false, metrics = {}) {
            const C = this.constructor.CONFIG.TEXT;
            const COLORS = this.constructor.CONFIG.STYLE.HIGHLIGHT_COLORS;

            const unidentifiedKeys = Array.from(unidentifiedMap.keys());
            const unidentifiedCount = unidentifiedKeys.length;

            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const dialogBox = document.createElement('div');
            dialogBox.className = 'custom-dialog-box dashboard-dialog';

            const title = document.createElement('div');
            title.className = 'custom-dialog-title';
            title.textContent = ignorePageErn ? C.DIALOG_TITLE_TPX : "ERN分析結果";

            const summaryBox = document.createElement('div');
            summaryBox.style.cssText = "font-size: 14px; color: #444; margin-bottom: 16px; background-color: #f4f6f9; padding: 10px; border-radius: 6px; border: 1px solid #d8dde6; display: flex; justify-content: center; gap: 16px; letter-spacing: 0.5px;";
            summaryBox.innerHTML = `
                <span>共掃描 <b>${metrics.totalRows || 0}</b> 列記錄</span> <span style="color:#ccc">|</span>
                <span>共提取 <b>${metrics.totalExtractedTNs || 0}</b> 個追蹤號</span> <span style="color:#ccc">|</span>
                <span>撇除重複有 <b style="color:#04844b">${metrics.uniqueTNsCount || 0}</b> 個追蹤號</span> <span style="color:#ccc">|</span>
                <span>無追蹤號case <b style="color:#c23934">${metrics.noTnRowCount || 0}</b> 個</span>
            `;

            const grid = document.createElement('div');
            grid.className = 'assign-grid-container';

            const colLeft = this.createAssignColumn(`${C.col_unidentified} (${unidentifiedCount})`, unidentifiedKeys);

            const colMid = document.createElement('div');
            colMid.className = 'assign-column';
            const midHeader = document.createElement('div');
            midHeader.className = 'assign-col-header';
            midHeader.textContent = `${C.col_tpx_input} (0 / ${unidentifiedCount})`;
            const midContent = document.createElement('div');
            midContent.className = 'assign-col-content';
            midContent.style.padding = '0';

            const textarea = document.createElement('textarea');
            textarea.id = 'tpx-input-area';
            textarea.style.cssText = "width:100%; height:100%; border:none; resize:none; padding:10px; font-family:monospace; font-size:12px; box-sizing:border-box; outline:none; background-color:#fff;";
            textarea.placeholder = ignorePageErn
                ? "請在此貼上 TPX 查詢結果...\n(將嚴格按照左側清單順序進行覆寫比對)"
            : "在此粘貼 TPX 結果...\n(每行對應左側一個追蹤號)";

            const updateCount = () => {
                const lines = textarea.value.split('\n').filter(l => l.trim() !== '').length;
                midHeader.textContent = `${C.col_tpx_input} (${lines} / ${unidentifiedCount})`;
                midHeader.style.color = (lines !== unidentifiedCount) ? '#c23934' : '#444';
            };
            textarea.addEventListener('input', updateCount);
            midContent.appendChild(textarea);
            colMid.append(midHeader, midContent);

            const initialSortedEntries = Array.from(resultMap.entries())
            .sort((a, b) => b[1].length - a[1].length);
            const sortedIdentifiedText = initialSortedEntries
            .map(([name, rows]) => `${name} (${rows.length})`);
            const colRight = this.createAssignColumn(`${C.col_identified} (按數量排序)`, sortedIdentifiedText);

            grid.append(colLeft, colMid, colRight);

            setTimeout(() => {
                const leftItems = colLeft.querySelectorAll('.assign-col-content > div');
                leftItems.forEach((div, index) => {
                    div.addEventListener('click', () => {
                        leftItems.forEach(d => d.classList.remove('sync-active'));
                        div.classList.add('sync-active');
                        const lines = textarea.value.split('\n');
                        let start = 0;
                        for (let i = 0; i < index; i++) start += (lines[i] !== undefined ? lines[i].length : 0) + 1;
                        const currentLineLen = (lines[index] !== undefined ? lines[index].length : 0);
                        textarea.focus();
                        textarea.setSelectionRange(start, start + currentLineLen);
                        const lineHeight = 16;
                        const visibleLines = textarea.clientHeight / lineHeight;
                        textarea.scrollTop = (index > visibleLines / 2) ? (index - visibleLines / 2) * lineHeight : 0;
                    });
                });
                const syncFromTextarea = () => {
                    const val = textarea.value;
                    const sel = textarea.selectionStart;
                    const lineNum = val.substr(0, sel).split('\n').length - 1;
                    if (leftItems[lineNum]) {
                        leftItems.forEach(d => d.classList.remove('sync-active'));
                        leftItems[lineNum].classList.add('sync-active');
                        leftItems[lineNum].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                };
                textarea.addEventListener('click', syncFromTextarea);
                textarea.addEventListener('keyup', syncFromTextarea);
            }, 0);

            const btnContainer = document.createElement('div');
            btnContainer.className = 'custom-dialog-buttons dashboard-buttons';
            btnContainer.style.gridTemplateColumns = 'repeat(3, 1fr)';

            const closeDialog = () => document.body.removeChild(overlay);

            const btnCopyUnidentified = document.createElement('button');
            btnCopyUnidentified.textContent = C.BTN_COPY_UNIDENTIFIED;
            btnCopyUnidentified.className = 'btn-secondary';
            btnCopyUnidentified.onclick = async () => {
                if (unidentifiedKeys.length === 0) {
                    btnCopyUnidentified.textContent = "無數據";
                } else {
                    const textToCopy = unidentifiedKeys.join('\n');
                    await navigator.clipboard.writeText(textToCopy);
                    btnCopyUnidentified.textContent = C.COPY_SUCCESS_BUTTON;
                }
                setTimeout(() => btnCopyUnidentified.textContent = C.BTN_COPY_UNIDENTIFIED, 1500);
            };

            const btnMark = document.createElement('button');
            btnMark.textContent = C.BTN_MARK_CACHE;
            btnMark.className = 'btn-primary';
            btnMark.onclick = () => {
                const inputLines = textarea.value.split('\n').filter(l => l.trim() !== '').length;
                if (inputLines !== unidentifiedCount) {
                    let msg = `⚠️ 數量不匹配，無法執行！\n\n左側未識別數：${unidentifiedCount}\nTPX 輸入行數：${inputLines}`;
                    if (inputLines === 0) msg += `\n\n(請先輸入 TPX 結果)`;
                    else msg += `\n\n請檢查是否有漏行或多餘空行。`;
                    alert(msg);
                    return;
                }
                this.executeMarkAndCache(resultMap, cachePendingData, unidentifiedMap, textarea.value);
            };

            const btnTop = document.createElement('button');
            btnTop.textContent = "整理排序";
            btnTop.className = 'btn-secondary';
            btnTop.onclick = () => {
                const currentSortedEntries = Array.from(resultMap.entries()).sort((a, b) => b[1].length - a[1].length);
                const sortedGroups = currentSortedEntries.map(entry => entry[1]);

                this.clearHighlights();
                if (!this.highlightMemory) this.highlightMemory = new Map();
                const frozenColor = this.constructor.CONFIG.STYLE.CART_FROZEN_BG_COLOR;
                let colorIndex = 0;

                currentSortedEntries.forEach(([personName, group]) => {
                    const color = COLORS[colorIndex % COLORS.length];
                    group.forEach(row => {
                        row.setAttribute('data-highlighted-by-script', 'true');

                        const caseNum = this.extractCaseNumberFromRow(row);
                        if (caseNum) this.highlightMemory.set(caseNum, color);

                        if (row.hasAttribute('data-queued-assignee')) {
                            row.style.backgroundColor = frozenColor;
                        } else {
                            row.style.backgroundColor = color;
                        }
                        this.markRowDom(row, personName);
                    });
                    colorIndex++;
                });

                this.reorderRowsToTop(table.querySelector('tbody'), sortedGroups);
                this.scrollToTableTop(table);
                closeDialog();
            };

            const btnExport = document.createElement('button');
            btnExport.textContent = C.BTN_EXPORT_TASKS;
            btnExport.className = 'btn-export';
            btnExport.onclick = () => this.executeExportTasks(resultMap);

            const btnClear = document.createElement('button');
            btnClear.textContent = C.BTN_CLEAR_CACHE;
            btnClear.className = 'btn-secondary';
            btnClear.style.backgroundColor = '#ffebee';
            btnClear.style.color = '#c23934';
            btnClear.onclick = () => { if (confirm("確定清除緩存？")) this.clearAssignCache(); };

            const btnClose = document.createElement('button');
            btnClose.textContent = C.CANCEL_BUTTON;
            btnClose.className = 'btn-secondary';
            btnClose.onclick = closeDialog;

            btnContainer.append(btnMark, btnTop, btnExport, btnCopyUnidentified, btnClear, btnClose);

            dialogBox.append(title, summaryBox, grid, btnContainer);
            overlay.appendChild(dialogBox);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
        }

        createAssignColumn(headerText, items) {
            const col = document.createElement('div');
            col.className = 'assign-column';
            col.innerHTML = `<div class="assign-col-header">${headerText}</div><div class="assign-col-content">${items.length ? items.map(i => `<div>${i}</div>`).join('') : '<div style="color:#ccc;text-align:center">(無數據)</div>'}</div>`;
            return col;
        }

        executeExportTasks(resultMap) {
            let exportText = "";
            let totalTasks = 0;

            const sortedEntries = Array.from(resultMap.entries()).sort((a, b) => b[1].length - a[1].length);

            sortedEntries.forEach(([personName, rows]) => {
                const caseNumbers = new Set();
                rows.forEach(row => {
                    const cn = this.extractCaseNumberFromRow(row);
                    if (cn) caseNumbers.add(cn);
                });
                if (caseNumbers.size > 0) {
                    exportText += `=== ${personName} (共 ${caseNumbers.size} 筆) ===\n`;
                    exportText += Array.from(caseNumbers).join('\n') + '\n\n';
                    totalTasks += caseNumbers.size;
                }
            });

            if (totalTasks === 0) {
                this.showNotification("目前沒有可導出的 Case Number，請確認表格資料是否齊全。", "error");
                return;
            }

            this.showExportDialog(exportText, totalTasks);
        }

        showExportDialog(text, totalTasks) {
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const box = document.createElement('div');
            box.className = 'custom-dialog-box';

            box.innerHTML = `
                <div class="custom-dialog-title">導出分派列隊</div>
                <div class="custom-dialog-message" style="margin-bottom:12px; background: #f9f9fa; padding: 10px; border-radius: 6px; border: 1px solid #e5e5e5; text-align: left;">
                    ✅ 成功提取 <strong>${totalTasks}</strong> 筆單號<br>
                    <span style="font-size: 13px; color: #666;">請複製以下內容並發送給對應的處理人員。</span>
                </div>
            `;

            const textarea = document.createElement('textarea');
            textarea.className = 'settings-dialog-textarea';
            textarea.style.height = '250px';
            textarea.readOnly = true;
            textarea.value = text.trim();

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';

            const btnCopy = document.createElement('button');
            btnCopy.className = 'btn-primary';
            btnCopy.textContent = "一鍵複製全部名單";
            btnCopy.onclick = async () => {
                await navigator.clipboard.writeText(textarea.value);
                btnCopy.textContent = "✅ 已複製！";
                setTimeout(() => btnCopy.textContent = "一鍵複製全部名單", 1500);
            };

            const btnClose = document.createElement('button');
            btnClose.className = 'btn-secondary';
            btnClose.textContent = "關閉";
            btnClose.onclick = () => document.body.removeChild(overlay);

            btns.append(btnCopy, btnClose);
            box.append(textarea, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        executeMarkAndCache(resultMap, cachePendingData, unidentifiedMap, tpxInputString) {
            const assignMap = this.parseAssignMap();
            let markCount = 0;
            let tpxMatchCount = 0;

            if (tpxInputString && tpxInputString.trim() !== '') {
                const tpxLines = tpxInputString.split('\n');
                const unidentifiedTNs = Array.from(unidentifiedMap.keys());

                tpxLines.forEach((line, index) => {
                    if (index >= unidentifiedTNs.length) return;

                    const lineUpper = line.toUpperCase();
                    const targetTN = unidentifiedTNs[index];

                    for (const [code, personName] of assignMap) {
                        if (lineUpper.includes(code)) {
                            tpxMatchCount++;
                            cachePendingData.set(targetTN, { name: personName, source: 'tpx' });

                            const targetRows = unidentifiedMap.get(targetTN);
                            if (targetRows) {
                                if (!resultMap.has(personName)) resultMap.set(personName, []);
                                const group = resultMap.get(personName);

                                targetRows.forEach(row => {
                                    if (this.markRowDom(row, personName)) markCount++;
                                    if (!group.includes(row)) group.push(row);
                                });
                            }
                            break;
                        }
                    }
                });
            }

            if (cachePendingData.size > 0) this.saveAssignCache(cachePendingData);

            resultMap.forEach((rows, personName) => {
                rows.forEach(row => {
                    if (this.markRowDom(row, personName)) markCount++;
                });
            });

            const msg = tpxMatchCount > 0
            ? `${this.constructor.CONFIG.TEXT.MARK_SUCCESS}\n(原有識別: ${markCount - tpxMatchCount}, TPX匹配: ${tpxMatchCount})`
                : `${this.constructor.CONFIG.TEXT.MARK_SUCCESS} (標記了 ${markCount} 行)`;

            this.showNotification(msg, 'success');
        }

        markRowDom(row, personName) {
            const subjectCell = row.querySelector('td[data-label="Subject"]');
            if (!subjectCell) return false;

            const flexContainer = subjectCell.querySelector('.slds-grid');
            if (flexContainer) {
                flexContainer.style.justifyContent = 'flex-start';
                flexContainer.style.alignItems = 'center';
            }

            const container = flexContainer || subjectCell.querySelector('div.slds-truncate') || subjectCell.querySelector('a') || subjectCell;
            const existingSpan = container.querySelector('.script-injected-assignee');

            if (existingSpan) {
                if (existingSpan.getAttribute('data-assignee') === personName) {
                    return false;
                } else {
                    existingSpan.innerHTML = `<b>${personName} - </b>`;
                    existingSpan.setAttribute('data-assignee', personName);
                    return true;
                }
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'script-injected-assignee';
            nameSpan.setAttribute('data-assignee', personName);
            nameSpan.innerHTML = `<b>${personName} - </b>`;
            nameSpan.style.color = '#000';
            nameSpan.style.marginRight = '5px';
            nameSpan.style.flexShrink = '0';

            if (container.firstChild) {
                container.insertBefore(nameSpan, container.firstChild);
            } else {
                container.appendChild(nameSpan);
            }
            return true;
        }

        startFullLoadAndCheckDuplicates() {
            this._executeFullLoadAndProcess(this.findAndHighlightDuplicates.bind(this));
        }

        startFullLoadAndFindAccounts() {
            if (this.targetAccounts.size === 0) {
                this.showNotification(this.constructor.CONFIG.TEXT.ACCOUNT_SETTINGS_EMPTY, 'info');
                this.showAccountSettingsDialog();
                return;
            }
            this._executeFullLoadAndProcess(this.findAndHighlightAccounts.bind(this));
        }

        findAndHighlightDuplicates() {
            const C = this.constructor.CONFIG;
            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);
            this.clearHighlights();
            const map = new Map();

            const rows = table.querySelectorAll(C.SELECTORS.TABLE_ROW);
            rows.forEach(row => {
                const tn = this.extractTrackingNumberFromRow(row);
                if (tn) {
                    if (!map.has(tn)) map.set(tn, []);
                    map.get(tn).push(row);
                }
            });

            const groups = [];
            const summary = [];
            const duplicateTNs = [];

            for (const [tn, rows] of map.entries()) {
                if (rows.length > 1) {
                    groups.push(rows);
                    summary.push(`${tn} (出現 ${rows.length} 次)`);
                    duplicateTNs.push(tn);
                }
            }

            const copyConfig = duplicateTNs.length > 0 ? {
                text: duplicateTNs.join('\n'),
                btnText: C.TEXT.COPY_BUTTON
            } : null;

            this.applyHighlightsAndShowDialog(table, groups, summary, map, C.TEXT.DIALOG_TITLE_DUPLICATE, C.TEXT.DIALOG_SUMMARY_DUPLICATE(map.size, groups.length), copyConfig, false);
        }

        findAndHighlightAccounts() {
            const C = this.constructor.CONFIG;
            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);
            this.clearHighlights();
            const map = new Map();

            const rows = table.querySelectorAll(C.SELECTORS.TABLE_ROW);
            rows.forEach(row => {
                const tn = this.extractTrackingNumberFromRow(row);
                if (tn) {
                    const accMatch = tn.match(C.REGEX.ACCOUNT_NUMBER);
                    if (accMatch && this.targetAccounts.has(accMatch[1])) {
                        const acc = accMatch[1];
                        if (!map.has(acc)) map.set(acc, []);
                        map.get(acc).push(row);
                    }
                }
            });

            const groups = Array.from(map.values());
            const summary = Array.from(map.entries()).map(([a, r]) => `${a} (匹配 ${r.length} 個)`);

            const matchedTNs = new Set();
            groups.forEach(rows => {
                rows.forEach(row => {
                    const tn = this.extractTrackingNumberFromRow(row);
                    if (tn) matchedTNs.add(tn);
                });
            });

            const copyConfig = matchedTNs.size > 0 ? {
                text: Array.from(matchedTNs).join('\n'),
                btnText: C.TEXT.COPY_MATCHED_BUTTON || "複製匹配單號"
            } : null;

            this.applyHighlightsAndShowDialog(table, groups, summary, map, C.TEXT.DIALOG_TITLE_FIND, C.TEXT.DIALOG_SUMMARY_FIND(map.size, groups.length), copyConfig, true);
        }

        applyHighlightsAndShowDialog(table, groups, summary, map, title, summaryHtml, copyConfig, autoCheckGroups = false) {
            const C = this.constructor.CONFIG;
            const frozenColor = C.STYLE.CART_FROZEN_BG_COLOR;
            if (!this.highlightMemory) this.highlightMemory = new Map();
            let ci = 0;

            groups.forEach(rows => {
                const color = C.STYLE.HIGHLIGHT_COLORS[ci++ % C.STYLE.HIGHLIGHT_COLORS.length];
                rows.forEach(r => {
                    r.setAttribute('data-highlighted-by-script', 'true');

                    const caseNum = this.extractCaseNumberFromRow(r);
                    if (caseNum) this.highlightMemory.set(caseNum, color);

                    if (r.hasAttribute('data-queued-assignee')) {
                        r.style.backgroundColor = frozenColor;
                    } else {
                        r.style.backgroundColor = color;
                    }
                });
            });

            if (groups.length === 0) return this.showNotification('未發現匹配項。', 'success');
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const box = document.createElement('div');
            box.className = 'custom-dialog-box';
            box.innerHTML = `<div class="custom-dialog-title">${title}</div><div class="custom-dialog-message">${summaryHtml}</div>`;

            const details = document.createElement('div');
            details.className = 'custom-dialog-details';
            details.innerHTML = summary.map(s => `<p>${s}</p>`).join('');

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';

            const btnTop = document.createElement('button');
            btnTop.className = 'btn-primary';
            btnTop.textContent = autoCheckGroups ? "置頂並自動勾選" : C.TEXT.REORDER_TOP_BUTTON;

            if (autoCheckGroups) {
                btnTop.title = "【短按】 置頂並手動勾選\n【長按 1 秒】 置頂並將案件均分加入分派隊列";
                let pressTimer;
                let feedbackTimer;
                let isLongPress = false;

                const resetBtn = () => {
                    clearTimeout(pressTimer);
                    clearTimeout(feedbackTimer);
                    btnTop.textContent = "置頂並自動勾選";
                    btnTop.style.backgroundColor = '';
                };

                btnTop.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    isLongPress = false;

                    feedbackTimer = setTimeout(() => {
                        btnTop.textContent = "⏳ 準備均分加入隊列...";
                        btnTop.style.backgroundColor = '#005a9e';
                    }, 500);

                    pressTimer = setTimeout(() => {
                        isLongPress = true;
                        resetBtn();
                        document.body.removeChild(overlay);
                        // ⚡ 觸發均分入隊列與置頂
                        this.reorderRowsToTop(table.querySelector('tbody'), groups);
                        this.scrollToTableTop(table);
                        setTimeout(() => this.distributeToQueue(groups), 50);
                    }, 1000);
                });

                btnTop.addEventListener('mouseup', (e) => {
                    if (e.button !== 0) return;
                    if (!isLongPress) {
                        resetBtn();
                        document.body.removeChild(overlay);
                        // 🛡️ 短按原本邏輯
                        this.reorderRowsToTop(table.querySelector('tbody'), groups);
                        this.scrollToTableTop(table);
                        setTimeout(() => {
                            let checkCount = 0;
                            groups.forEach(groupRows => {
                                groupRows.forEach(r => {
                                    const chk = r.querySelector('input[type="checkbox"]');
                                    if (chk && !chk.checked) { chk.click(); checkCount++; }
                                });
                            });
                            this.showNotification(`已成功置頂並勾選 ${checkCount} 筆項目！`, "success");
                        }, 50);
                    }
                });

                btnTop.addEventListener('mouseleave', () => { if (!isLongPress) resetBtn(); });
            } else {
                // 一般查重的原本邏輯
                btnTop.onclick = () => {
                    this.reorderRowsToTop(table.querySelector('tbody'), groups);
                    this.scrollToTableTop(table);
                    document.body.removeChild(overlay);
                };
            }

            const btnInPlace = document.createElement('button');
            btnInPlace.className = 'btn-primary';
            btnInPlace.textContent = C.TEXT.REORDER_INPLACE_BUTTON;
            btnInPlace.onclick = () => {
                this.reorderRowsInPlace(table.querySelector('tbody'), map);
                this.scrollToTableTop(table);
                document.body.removeChild(overlay);
            };

            const btnCancel = document.createElement('button');
            btnCancel.className = 'btn-secondary';
            btnCancel.textContent = C.TEXT.CANCEL_BUTTON;
            btnCancel.onclick = () => document.body.removeChild(overlay);

            btns.append(btnTop, btnInPlace);

            if (copyConfig) {
                const btnCopy = document.createElement('button');
                btnCopy.className = 'btn-secondary';
                btnCopy.textContent = copyConfig.btnText;
                btnCopy.onclick = async () => {
                    await navigator.clipboard.writeText(copyConfig.text);
                    const originalText = btnCopy.textContent;
                    btnCopy.textContent = C.TEXT.COPY_SUCCESS_BUTTON;
                    setTimeout(() => btnCopy.textContent = originalText, 1500);
                };
                btns.appendChild(btnCopy);
            }

            btns.appendChild(btnCancel);
            box.append(details, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        // ✨ 新增：核心輪詢均分演算法 (Round-Robin Distribution，支援 -Q 尾綴判定)
        distributeToQueue(groups) {
            const assignees = this.loadDistributeAssignees();
            if (assignees.length === 0) {
                return this.showNotification("⚠️ 均分失敗：您尚未在設置中填寫「均分派送名單」。", "error");
            }

            const C = this.constructor.CONFIG;
            let cart = GM_getValue(C.STORAGE_KEY_CART, {});
            let idMap = JSON.parse(localStorage.getItem('salesforce_id_to_case_map') || '{}');

            // 將所有匹配到的二維陣列攤平
            const matchedRows = [];
            groups.forEach(group => matchedRows.push(...group));

            // ✨ 先過濾出真正需要分配的案件 (排除已在隊列中的)，確保計算與分配數量絕對精準
            const validRows = matchedRows.filter(tr => !tr.hasAttribute('data-queued-assignee'));
            const totalValid = validRows.length;

            if (totalValid === 0) {
                return this.showNotification("💡 這些案件已經在分派隊列中了，無需重複加入。", "info");
            }

            // ✨ 計算連續分配陣列 (Chunking Algorithm)
            const numAssignees = assignees.length;
            const baseCount = Math.floor(totalValid / numAssignees);
            const remainder = totalValid % numAssignees;
            const distributionPlan = [];

            for (let i = 0; i < numAssignees; i++) {
                // 前幾個 assignee 會多拿一個餘數，確保絕對均分
                const count = baseCount + (i < remainder ? 1 : 0);
                for (let j = 0; j < count; j++) {
                    distributionPlan.push(assignees[i]);
                }
            }

            let addedCount = 0;
            let distributeStats = new Map(); // 用於統計每個人/佇列分到幾筆

            validRows.forEach((tr, index) => {
                // 從預先計算好的連續分配計畫中取出名字
                let rawName = distributionPlan[index];
                let isQueue = false;

                // 利用後綴 "-Q" 進行直覺判定
                if (rawName.toUpperCase().endsWith('-Q')) {
                    isQueue = true;
                    // 拔除結尾的 -Q 並去掉多餘空白
                    rawName = rawName.substring(0, rawName.length - 2).trim();
                }

                // 組合前綴鎖定 Key
                const assigneeKey = `${isQueue ? 'Q' : 'U'}:${rawName}`;

                const rowId = tr.getAttribute('data-row-key-value');
                if (rowId) {
                    if (!cart[assigneeKey]) cart[assigneeKey] = [];
                    if (!cart[assigneeKey].includes(rowId)) {
                        cart[assigneeKey].push(rowId);
                        addedCount++;

                        // 統計顯示 (若為 Queue 加上識別)
                        const statName = isQueue ? `🏢 ${rawName}` : `👤 ${rawName}`;
                        distributeStats.set(statName, (distributeStats.get(statName) || 0) + 1);

                        const cn = this.extractCaseNumberFromRow(tr);
                        if (cn) idMap[rowId] = cn;

                        // 取消勾選狀態防衝突
                        const chk = tr.querySelector('input[type="checkbox"]');
                        if (chk && chk.checked) chk.click();

                        // 視覺凍結
                        this.applyVisualFreeze(tr, assigneeKey);
                    }
                }
            });

            // 保存資料
            GM_setValue(C.STORAGE_KEY_CART, cart);
            localStorage.setItem('salesforce_id_to_case_map', JSON.stringify(idMap));

            // 更新 UI 與提示
            this.updateCartButtonsUI(Object.keys(cart).reduce((sum, k) => sum + cart[k].length, 0));

            let statsMsg = `🎉 成功將 ${addedCount} 筆案件連續均分入隊列：\n`;
            distributeStats.forEach((count, name) => statsMsg += `- ${name}: ${count} 筆\n`);
            this.showNotification(statsMsg, "success");
        }

        showFindTnInputDialog() {
            const C = this.constructor.CONFIG.TEXT;
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';

            const box = document.createElement('div');
            box.className = 'custom-dialog-box';
            box.innerHTML = `
                <div class="custom-dialog-title">${C.DIALOG_TITLE_FIND_TN_INPUT}</div>
                <p class="settings-dialog-prompt" style="white-space:pre-wrap">${C.DIALOG_PROMPT_FIND_TN}</p>
            `;

            const textarea = document.createElement('textarea');
            textarea.className = 'settings-dialog-textarea';
            textarea.placeholder = "請在此處貼上追蹤號 (1Z...) 或 Case 號 (C-...)\n可以混合貼上，未在列表中的號碼將被自動忽略。";

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';
            btns.style.gridTemplateColumns = '1fr 1fr';

            const btnScan = document.createElement('button');
            btnScan.className = 'btn-primary';
            btnScan.textContent = "開始分析匹配";
            btnScan.onclick = () => {
                const inputVal = textarea.value;
                if (!inputVal.trim()) return this.showNotification("請先貼上單號列！", "error");
                document.body.removeChild(overlay);
                this._executeFullLoadAndProcess(() => this.processFindSpecificTNs(inputVal));
            };

            const btnCancel = document.createElement('button');
            btnCancel.className = 'btn-secondary';
            btnCancel.textContent = "取消";
            btnCancel.onclick = () => document.body.removeChild(overlay);

            const btnExtractAll = document.createElement('button');
            btnExtractAll.className = 'btn-secondary';
            btnExtractAll.textContent = C.EXTRACT_ALL_BUTTON;
            btnExtractAll.style.gridColumn = '1 / -1';
            btnExtractAll.style.backgroundColor = '#eef4fc';
            btnExtractAll.style.color = '#0070d2';
            btnExtractAll.style.border = '1px solid #d8dde6';
            btnExtractAll.onclick = () => {
                document.body.removeChild(overlay);
                this._executeFullLoadAndProcess(() => this.processExtractAllTNs());
            };

            btns.append(btnScan, btnCancel, btnExtractAll);
            box.append(textarea, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
            textarea.focus();
        }

        processExtractAllTNs() {
            const C = this.constructor.CONFIG;
            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);
            if (!table) return this.showNotification('錯誤：找不到案件列表表格！', 'error');

            const allTNs = new Set();
            const rows = table.querySelectorAll(C.SELECTORS.TABLE_ROW);

            rows.forEach(row => {
                const rowText = row.innerText;
                const matches = rowText.match(C.REGEX.TRACKING_NUMBER);
                if (matches) {
                    matches.forEach(m => {
                        const cleanTn = m.replace(/\s+/g, '').toUpperCase();
                        allTNs.add(cleanTn);
                    });
                }
            });

            const tnArray = Array.from(allTNs);
            this.showExtractResultDialog(tnArray);
        }

        showExtractResultDialog(tnArray) {
            const C = this.constructor.CONFIG.TEXT;
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';

            const box = document.createElement('div');
            box.className = 'custom-dialog-box';

            box.innerHTML = `
                <div class="custom-dialog-title">${C.DIALOG_TITLE_EXTRACT_RESULT}</div>
                <div class="custom-dialog-message" style="margin-bottom:12px; text-align: left; background: #f9f9fa; padding: 12px; border-radius: 6px; border: 1px solid #e5e5e5;">
                    共提取出 <strong>${tnArray.length}</strong> 個不重複單號
                </div>
            `;

            const textarea = document.createElement('textarea');
            textarea.className = 'settings-dialog-textarea';
            textarea.style.height = '150px';
            textarea.readOnly = true;
            textarea.value = tnArray.join('\n');
            if (tnArray.length === 0) textarea.placeholder = "（無提取到任何單號）";

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';

            const btnCopy = document.createElement('button');
            btnCopy.className = 'btn-primary';
            btnCopy.textContent = "一鍵複製全部";
            btnCopy.onclick = async () => {
                if (tnArray.length === 0) return this.showNotification("沒有單號可複製", "info");
                await navigator.clipboard.writeText(textarea.value);
                const originalText = btnCopy.textContent;
                btnCopy.textContent = "✅ 已複製！";
                setTimeout(() => btnCopy.textContent = originalText, 1500);
            };

            const btnClose = document.createElement('button');
            btnClose.className = 'btn-secondary';
            btnClose.textContent = C.CANCEL_BUTTON;
            btnClose.onclick = () => document.body.removeChild(overlay);

            btns.append(btnCopy, btnClose);
            box.append(textarea, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        processFindSpecificTNs(inputText) {
            const C = this.constructor.CONFIG;
            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);
            if (!table) return;

            const pageItemMap = new Map();
            const rows = table.querySelectorAll(C.SELECTORS.TABLE_ROW);

            rows.forEach(row => {
                const tn = this.extractTrackingNumberFromRow(row);
                const cn = this.extractCaseNumberFromRow(row);
                if (tn) {
                    if (!pageItemMap.has(tn)) pageItemMap.set(tn, []);
                    pageItemMap.get(tn).push(row);
                }
                if (cn) {
                    if (!pageItemMap.has(cn)) pageItemMap.set(cn, []);
                    pageItemMap.get(cn).push(row);
                }
            });

            const inputLines = inputText.split(/\r?\n/);
            const foundItems = new Set();
            const requestedItems = new Set(); // ✨ 新增：收集用戶輸入的所有合法格式單號
            const matchedRowGroups = [];

            inputLines.forEach(line => {
                let matchedStr = null;
                const tnMatch = line.match(C.REGEX.TRACKING_NUMBER);
                const cnMatch = line.match(C.REGEX.CASE_NUMBER);

                if (tnMatch) matchedStr = tnMatch[0].replace(/\s+/g, '').toUpperCase();
                else if (cnMatch) matchedStr = cnMatch[0].toUpperCase();

                if (matchedStr) {
                    requestedItems.add(matchedStr); // ✨ 記錄為待查找對象
                    if (pageItemMap.has(matchedStr)) {
                        if (!foundItems.has(matchedStr)) {
                            foundItems.add(matchedStr);
                            matchedRowGroups.push(pageItemMap.get(matchedStr));
                        }
                    }
                }
            });

            const foundArray = Array.from(foundItems);
            // ✨ 新增：利用差集快速計算出「未能定位的單號」
            const unmatchedArray = Array.from(requestedItems).filter(item => !foundItems.has(item));

            this.clearHighlights();
            if (!this.highlightMemory) this.highlightMemory = new Map();
            const frozenColor = C.STYLE.CART_FROZEN_BG_COLOR;

            if (matchedRowGroups.length > 0) {
                let ci = 0;
                matchedRowGroups.forEach(groupRows => {
                    const color = C.STYLE.HIGHLIGHT_COLORS[ci++ % C.STYLE.HIGHLIGHT_COLORS.length];
                    groupRows.forEach(r => {
                        r.setAttribute('data-highlighted-by-script', 'true');

                        const caseNum = this.extractCaseNumberFromRow(r);
                        if (caseNum) this.highlightMemory.set(caseNum, color);

                        if (r.hasAttribute('data-queued-assignee')) {
                            r.style.backgroundColor = frozenColor;
                        } else {
                            r.style.backgroundColor = color;
                        }
                    });
                });
            }

            // ✨ 修改：將 unmatchedArray 作為第四個參數傳遞給彈窗渲染函數
            this.showFindTnResultDialog(foundArray, matchedRowGroups, table, unmatchedArray);
        }

        showFindTnResultDialog(foundArray, matchedRowGroups, table, unmatchedArray = []) {
            const C = this.constructor.CONFIG.TEXT;
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';

            const box = document.createElement('div');
            box.className = 'custom-dialog-box';

            const hasUnmatched = unmatchedArray && unmatchedArray.length > 0;

            // ✨ 整合優化：動態判別。若有未定位單號，則收緊上方定位成功框的下邊距，並渲染紅色的未匹配清單與複製按鈕
            box.innerHTML = `
                <div class="custom-dialog-title">${C.DIALOG_TITLE_FIND_TN_RESULT}</div>
                <div class="custom-dialog-message" style="margin-bottom: ${hasUnmatched ? '12px' : '20px'}; text-align: left; background: #f9f9fa; padding: 12px; border-radius: 6px; border: 1px solid #e5e5e5;">
                    ✅ 已在頁面上成功定位 <strong>${foundArray.length}</strong> 個有效單號<br>
                    <span style="font-size: 13px; color: #666;">(無效或不在當前頁面的單號已自動忽略)</span>
                </div>
                ${hasUnmatched ? `
                    <div style="margin-bottom: 20px; text-align: left;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <span style="font-size: 14px; font-weight: bold; color: #c23934;">
                                ❌ 未能定位的單號 (${unmatchedArray.length} 個)：
                            </span>
                            <button id="copy-unmatched-btn" style="padding: 2px 8px; font-size: 12px; font-weight: bold; background: #fff; color: #c23934; border: 1px solid #f2cfcf; border-radius: 4px; cursor: pointer; transition: all 0.2s; outline: none;">
                                複製未定位單號
                            </button>
                        </div>
                        <div class="custom-dialog-details" style="max-height: 100px; margin-bottom: 0; font-family: monospace; font-size: 13px; background-color: #fff0f0; border-color: #f2cfcf; color: #c23934; word-break: break-all;">
                            ${unmatchedArray.join('<br>')}
                        </div>
                    </div>
                ` : ''}
            `;

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';
            btns.style.gridTemplateColumns = '1fr';
            btns.style.gap = '10px';

            const btnTopAndCheck = document.createElement('button');
            btnTopAndCheck.className = 'btn-primary';
            btnTopAndCheck.textContent = "置頂並全自動打勾";
            btnTopAndCheck.style.fontSize = '16px';
            btnTopAndCheck.style.padding = '14px';
            btnTopAndCheck.onclick = () => {
                if (matchedRowGroups.length > 0) {
                    this.reorderRowsToTop(table.querySelector('tbody'), matchedRowGroups);
                    this.scrollToTableTop(table);

                    setTimeout(() => {
                        let checkCount = 0;
                        matchedRowGroups.forEach(groupRows => {
                            groupRows.forEach(r => {
                                const chk = r.querySelector('input[type="checkbox"]');
                                if (chk && !chk.checked) {
                                    chk.click();
                                    checkCount++;
                                }
                            });
                        });
                        this.showNotification(`已成功置頂並勾選 ${checkCount} 筆項目！`, "success");
                    }, 50);

                } else {
                    this.showNotification("沒有可處理的匹配項", "info");
                }
                document.body.removeChild(overlay);
            };

            const btnClose = document.createElement('button');
            btnClose.className = 'btn-secondary';
            btnClose.textContent = C.CANCEL_BUTTON;
            btnClose.onclick = () => document.body.removeChild(overlay);

            btns.append(btnTopAndCheck, btnClose);
            box.appendChild(btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            // ✨ 新增：為「複製未定位單號」按鈕綁定高互動性點擊事件與視覺回饋
            if (hasUnmatched) {
                const copyUnmatchedBtn = box.querySelector('#copy-unmatched-btn');
                if (copyUnmatchedBtn) {
                    copyUnmatchedBtn.onclick = async () => {
                        await navigator.clipboard.writeText(unmatchedArray.join('\n'));
                        const originalText = copyUnmatchedBtn.textContent;
                        copyUnmatchedBtn.textContent = "已複製！";
                        copyUnmatchedBtn.style.background = "#04844b";
                        copyUnmatchedBtn.style.color = "#fff";
                        copyUnmatchedBtn.style.borderColor = "#04844b";
                        setTimeout(() => {
                            copyUnmatchedBtn.textContent = originalText;
                            copyUnmatchedBtn.style.background = "#fff";
                            copyUnmatchedBtn.style.color = "#c23934";
                            copyUnmatchedBtn.style.borderColor = "#f2cfcf";
                        }, 1500);
                    };
                }
            }

            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        snapshotOriginalOrder() {
            if (this.originalRowOrder) return;
            const tb = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE_BODY);
            if (tb) this.originalRowOrder = Array.from(tb.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW));
        }

        restoreOriginalOrder() {
            if (!this.originalRowOrder) return;
            this.clearHighlights();
            const tb = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE_BODY);
            const f = document.createDocumentFragment();
            this.originalRowOrder.forEach(r => f.appendChild(r));
            tb.innerHTML = '';
            tb.appendChild(f);
        }

        reorderRowsToTop(e, t) {
            this.snapshotOriginalOrder();
            const o = Array.from(e.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW)),
                  l = new Set(t.flat()),
                  n = o.filter(e => !l.has(e)),
                  r = document.createDocumentFragment();
            t.forEach(e => e.forEach(e => r.appendChild(e))), n.forEach(e => r.appendChild(e)), e.appendChild(r);
        }

        reorderRowsInPlace(e, t) {
            this.snapshotOriginalOrder();
            const o = Array.from(e.querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW)),
                  l = [],
                  n = new Set;
            o.forEach(e => {
                if (n.has(e)) return;
                let x = null;
                for (const r of t.values())
                    if (r.length > 0 && r.includes(e)) {
                        x = r;
                        break
                    }
                x ? (l.push(...x), x.forEach(e => n.add(e))) : l.push(e)
            });
            const r = document.createDocumentFragment();
            l.forEach(e => r.appendChild(e)), e.appendChild(r);
        }

        selectRowRange() {
            const rows = this.findElementInShadowDom(this.constructor.CONFIG.SELECTORS.TABLE).querySelectorAll(this.constructor.CONFIG.SELECTORS.TABLE_ROW);
            const input = prompt(`輸入範圍 (如 1-20)，共 ${rows.length} 行`, "");
            if (!input) return;
            const m = input.match(/^(\d+)(?:-)?(\d*)?$/);
            if (!m) return;
            const s = parseInt(m[1]) - 1,
                  e = m[2] ? parseInt(m[2]) - 1 : (input.endsWith('-') ? rows.length - 1 : s);
            const chk = rows[s]?.querySelector('input[type="checkbox"]');
            if (chk) {
                const val = !chk.checked;
                for (let i = s; i <= e; i++) {
                    const c = rows[i]?.querySelector('input[type="checkbox"]');
                    if (c && !c.disabled && c.checked !== val) c.click();
                }
            }
        }

        loadTargetAccounts() {
            return new Set((localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY) || '').split('\n').map(l => l.replace(/\*/g, '').trim().toUpperCase()).filter(Boolean));
        }

        // ✨ 新增：讀取均分人員名單
        loadDistributeAssignees() {
            return (localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY_DISTRIBUTE_LIST) || '').split('\n').map(l => l.trim()).filter(Boolean);
        }

        parseAssignMap() {
            const raw = localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY_ASSIGN);
            const map = new Map();
            if (raw) raw.split('\n').forEach(l => {
                const [k, v] = l.split('=').map(s => s.trim());
                if (k && v) k.split('/').forEach(key => map.set(key.trim().toUpperCase(), v));
            });
            return map;
        }

        showAccountSettingsDialog() {
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const box = document.createElement('div');
            box.className = 'custom-dialog-box';
            box.style.maxWidth = '420px';

            box.innerHTML = `
                <div class="custom-dialog-title">設置指定賬號與分流名單</div>
                <div style="text-align: left; margin-bottom: 15px;">
                    <div style="font-size: 13px; font-weight: bold; color: #0070d2; margin-bottom: 5px;">1. 要查找的賬號 (每行一個，1Z後6位)</div>
                    <textarea id="acc-input" class="settings-dialog-textarea" style="height: 120px; margin-bottom: 10px;"></textarea>

                    <div style="font-size: 13px; font-weight: bold; color: #0070d2; margin-bottom: 5px;">2. 均分派送名單 (每行一個User或Queue)</div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 5px;">※ 若目標為Queue，請在結尾加上 "-Q" (例如：PCA_Queue -Q)。<br>查找完畢後，長按 1 秒即可將結果均分加入分派隊列。</div>
                    <textarea id="distribute-input" class="settings-dialog-textarea" style="height: 100px; margin-bottom: 10px;"></textarea>
                </div>
            `;

            const accInput = box.querySelector('#acc-input');
            const distInput = box.querySelector('#distribute-input');
            accInput.value = localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY) || '';
            distInput.value = localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY_DISTRIBUTE_LIST) || '';

            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';

            const save = document.createElement('button');
            save.className = 'btn-primary';
            save.textContent = "保存設置";
            save.onclick = () => {
                localStorage.setItem(this.constructor.CONFIG.STORAGE_KEY, accInput.value);
                localStorage.setItem(this.constructor.CONFIG.STORAGE_KEY_DISTRIBUTE_LIST, distInput.value);
                this.targetAccounts = this.loadTargetAccounts();
                this.showNotification("賬號與分流名單已保存！", 'success');
                document.body.removeChild(overlay);
            };

            const cancel = document.createElement('button');
            cancel.className = 'btn-secondary';
            cancel.textContent = "取消";
            cancel.onclick = () => document.body.removeChild(overlay);

            btns.append(save, cancel);
            box.appendChild(btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        // ✨ 升級：載入並解析「分流路由器」規則 (支援 -Q 尾綴智能標記)
        loadRouterRules() {
            const rules = { queues: new Set(), exclude: new Set(), redirect: new Map() };
            const raw = localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY_QUEUE_LIST) || '';

            raw.split('\n').forEach(line => {
                const text = line.trim();
                if (!text || text.startsWith('//')) return; // 忽略空行與註解

                if (text.startsWith('-')) {
                    // 排除規則： -名字
                    rules.exclude.add(text.substring(1).trim().toLowerCase());
                } else if (text.includes('>')) {
                    // 重定向規則： 原名 > 新名
                    const parts = text.split('>');
                    if (parts.length === 2) {
                        let originalName = parts[0].trim().toLowerCase();
                        let targetName = parts[1].trim();

                        // ✨ 智能偵測：如果結尾是 -Q (不分大小寫)，自動註冊為佇列
                        if (targetName.toUpperCase().endsWith('-Q')) {
                            // 拔除結尾的 -Q，並去掉多餘空白
                            targetName = targetName.substring(0, targetName.length - 2).trim();
                            // 自動幫您加入 Queue 識別名單中
                            rules.queues.add(targetName);
                        }

                        rules.redirect.set(originalName, targetName);
                    }
                } else {
                    // 預設為 Queue 名單
                    rules.queues.add(text);
                }
            });
            return rules;
        }

        // 為了相容其他函數的呼叫
        loadQueueList() {
            return this.loadRouterRules().queues;
        }

        // ✨ 升級：強大的「分派路由與佇列配置」面板 (更新提示文字)
        showQueueSettingsDialog() {
            const promptText = `【分派規則設定指南】\n此清單會在您「右鍵點擊」加入分派隊列時自動生效：\n\n1. Queue識別：直接輸入名稱 (將自動切換為 Queue 派送)\n   例如：HKG_PCA_Queue\n\n2. 排除不派：在名字前加減號 "-" (遇到此人將自動忽略)\n   例如：-Jerry Law\n\n3. 轉派定向：使用大於符號 ">" (把左邊的單轉分給右邊)\n   💡 若目標是Queue，可在結尾加上 "-Q" 自動識別\n   例如：Qqq > JJJ\n   例如：No ERN > CEC HK CSC English -Q`;

            this.showSettingsDialog("⚙️ 分派規則配置", promptText, this.constructor.CONFIG.STORAGE_KEY_QUEUE_LIST, () => {});
        }

        // ✨ 新增：讀取常用快捷名單 (支援 -Q 解析)
        loadQuickAssignList() {
            const raw = localStorage.getItem(this.constructor.CONFIG.STORAGE_KEY_QUICK_ASSIGN) || '';
            const list = [];
            raw.split('\n').forEach(line => {
                let name = line.trim();
                if (!name) return;
                let isQueue = false;
                if (name.toUpperCase().endsWith('-Q')) {
                    isQueue = true;
                    name = name.substring(0, name.length - 2).trim();
                }
                list.push({ displayName: name, isQueue: isQueue, assigneeKey: `${isQueue ? 'Q' : 'U'}:${name}` });
            });
            return list;
        }

        // ✨ 新增：呼叫常用快捷名單設定面板
        showQuickAssignSettingsDialog() {
            const promptText = `【常用快捷分派名單設定】\n請每行輸入一個常用的分派目標 (User或Queue)。\n設定後，將滑鼠停留在「加入分派隊列」按鈕上即可展開快捷選單。\n\n💡 若目標是Queue，請在結尾加上 "-Q"\n例如：Jerry Law\n例如：HKG_PCA_Queue -Q`;
            this.showSettingsDialog("⚡ 常用快捷分派目標配置", promptText, this.constructor.CONFIG.STORAGE_KEY_QUICK_ASSIGN, () => {});
        }

        // ✨ 新增：懸浮下拉選單引擎 (Hover Dropdown - 加入 0.5 秒防誤觸延遲)
        setupQuickAssignHover(btnEl) {
            let hideTimer;
            let showTimer;
            let dropdownEl = null;

            const hideDropdown = () => {
                clearTimeout(showTimer);
                hideTimer = setTimeout(() => {
                    if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; }
                }, 200);
            };

            const showDropdown = () => {
                clearTimeout(hideTimer);

                showTimer = setTimeout(() => {
                    if (dropdownEl) return;

                    const list = this.loadQuickAssignList();
                    if (list.length === 0) return;

                    dropdownEl = document.createElement('div');
                    dropdownEl.style.cssText = `position: fixed; background: #fff; border: 1px solid #d8dde6; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 999999; padding: 6px 0; min-width: 180px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;`;

                    const rect = btnEl.getBoundingClientRect();
                    dropdownEl.style.top = `${rect.bottom + 4}px`;
                    dropdownEl.style.left = `${rect.left}px`;

                    list.forEach(item => {
                        const iconSrc = item.isQueue ? '/img/icon/t4v35/standard/orders_120.png' : '/img/icon/t4v35/standard/user_120.png';
                        const opt = document.createElement('div');
                        opt.className = 'sf-assign-item';
                        opt.innerHTML = `
                            <div class="sf-assign-icon-box"><img src="${iconSrc}"></div>
                            <span style="font-weight:600;">${item.displayName}</span>
                        `;

                        opt.onclick = () => {
                            hideDropdown();
                            const C = this.constructor.CONFIG;
                            const table = this.findElementInShadowDom(C.SELECTORS.TABLE);
                            if (!table) return this.showNotification("錯誤：找不到表格資料列！", "error");

                            const checkboxes = Array.from(table.querySelectorAll('tbody input[type="checkbox"]:checked'));

                            if (checkboxes.length === 0) {
                                return this.showNotification("錯誤：請先在列表中手動勾選要分派的 Case。", "error");
                            }
                            this.processAddToCartTarget(checkboxes, item.assigneeKey, item.displayName);
                        };
                        dropdownEl.appendChild(opt);
                    });

                    dropdownEl.addEventListener('mouseenter', () => {
                        clearTimeout(hideTimer);
                        clearTimeout(showTimer);
                    });
                    dropdownEl.addEventListener('mouseleave', hideDropdown);
                    document.body.appendChild(dropdownEl);
                }, 300);
            };

            btnEl.addEventListener('mouseenter', showDropdown);
            btnEl.addEventListener('mouseleave', hideDropdown);

            document.addEventListener('scroll', () => { if (dropdownEl) hideDropdown(); }, true);
        }

        // ✨ 新增：全自訂分派對象 UI 彈窗 (修正手動覆蓋邏輯)
        promptAssigneeWithUI(defaultVal = '', defaultType = 'U') {
            return new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.className = 'custom-dialog-overlay';
                const box = document.createElement('div');
                box.className = 'custom-dialog-box';
                box.style.maxWidth = '380px';

                // ✨ 原生化：捨棄原生單選按鈕，改為精緻圖標卡片選擇器
                box.innerHTML = `
                    <div class="custom-dialog-title" style="font-size:18px; margin-bottom: 15px;">設定分派目標</div>
                    <div style="margin-bottom: 20px; display: flex; gap: 12px; justify-content: center;">
                        <input type="radio" id="radio-user" name="assigneeType" value="U" style="display:none;" ${defaultType==='U'?'checked':''}>
                        <label for="radio-user" class="sf-type-toggle" style="flex:1; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; padding:10px; border-radius:6px; border:2px solid ${defaultType==='U'?'#0070d2':'#e5e5e5'}; background:${defaultType==='U'?'#f0f8ff':'#fafafa'}; transition:all 0.2s;">
                            <div class="sf-assign-icon-box"><img src="/img/icon/t4v35/standard/user_120.png"></div>
                            <span style="font-weight:bold; color:${defaultType==='U'?'#0070d2':'#444'};">User</span>
                        </label>

                        <input type="radio" id="radio-queue" name="assigneeType" value="Q" style="display:none;" ${defaultType==='Q'?'checked':''}>
                        <label for="radio-queue" class="sf-type-toggle" style="flex:1; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; padding:10px; border-radius:6px; border:2px solid ${defaultType==='Q'?'#0070d2':'#e5e5e5'}; background:${defaultType==='Q'?'#f0f8ff':'#fafafa'}; transition:all 0.2s;">
                            <div class="sf-assign-icon-box"><img src="/img/icon/t4v35/standard/orders_120.png"></div>
                            <span style="font-weight:bold; color:${defaultType==='Q'?'#0070d2':'#444'};">Queue</span>
                        </label>
                    </div>
                `;

                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'settings-dialog-textarea';
                input.style.height = '40px';
                input.style.marginBottom = '20px';
                input.placeholder = '請輸入User或Queue名稱...';
                input.value = defaultVal;

                // 處理視覺狀態同步
                const updateRadioStyles = () => {
                    const isU = box.querySelector('#radio-user').checked;
                    const lblU = box.querySelector('label[for="radio-user"]');
                    const lblQ = box.querySelector('label[for="radio-queue"]');

                    lblU.style.borderColor = isU ? '#0070d2' : '#e5e5e5';
                    lblU.style.background = isU ? '#f0f8ff' : '#fafafa';
                    lblU.querySelector('span').style.color = isU ? '#0070d2' : '#444';

                    lblQ.style.borderColor = !isU ? '#0070d2' : '#e5e5e5';
                    lblQ.style.background = !isU ? '#f0f8ff' : '#fafafa';
                    lblQ.querySelector('span').style.color = !isU ? '#0070d2' : '#444';
                };

                let isManuallyToggled = false;
                const radioU = box.querySelector('#radio-user');
                const radioQ = box.querySelector('#radio-queue');

                // 使用者親自點擊時的同步
                radioU.addEventListener('change', () => { isManuallyToggled = true; updateRadioStyles(); });
                radioQ.addEventListener('change', () => { isManuallyToggled = true; updateRadioStyles(); });

                // 智能打字偵測 (偵測 Queue 尾綴或設定表)
                const queues = this.loadQueueList();
                input.addEventListener('input', () => {
                    if (isManuallyToggled) return;
                    const val = input.value.trim().toLowerCase();
                    const isQueue = Array.from(queues).some(q => q.toLowerCase() === val) || val.endsWith('-q');
                    if (isQueue) {
                        radioQ.checked = true;
                    } else {
                        radioU.checked = true;
                    }
                    updateRadioStyles();
                });

                const btns = document.createElement('div');
                btns.className = 'custom-dialog-buttons';

                const btnOk = document.createElement('button');
                btnOk.className = 'btn-primary';
                btnOk.textContent = '確定';
                btnOk.onclick = () => {
                    let val = input.value.trim();
                    if (!val) return this.showNotification('名稱不能為空！', 'error');

                    // 防呆處理：使用者若手殘打上 -Q，自動拔除並強制設為 Queue
                    const type = box.querySelector('input[name="assigneeType"]:checked').value;
                    if (val.toUpperCase().endsWith('-Q')) {
                        val = val.substring(0, val.length - 2).trim();
                        if (type !== 'Q') radioQ.checked = true; // 強制幫使用者矯正
                    }

                    document.body.removeChild(overlay);
                    resolve({ type: box.querySelector('input[name="assigneeType"]:checked').value, name: val });
                };

                const btnCancel = document.createElement('button');
                btnCancel.className = 'btn-secondary';
                btnCancel.textContent = '取消';
                btnCancel.onclick = () => {
                    document.body.removeChild(overlay);
                    resolve(null);
                };

                btns.append(btnOk, btnCancel);
                box.append(input, btns);
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                input.focus();
            });
        }

        // ✨ 補回：ERN/TPX 分析的映射表設定呼叫
        showAssignSettingsDialog() {
            this.showSettingsDialog(this.constructor.CONFIG.TEXT.ASSIGN_SETTINGS_TITLE, this.constructor.CONFIG.TEXT.ASSIGN_SETTINGS_PROMPT, this.constructor.CONFIG.STORAGE_KEY_ASSIGN, () => { });
        }

        // ✨ 補回：所有設定面板共用的底層 UI 繪製框架
        showSettingsDialog(title, promptText, storageKey, onSave) {
            const overlay = document.createElement('div');
            overlay.className = 'custom-dialog-overlay';
            const box = document.createElement('div');
            box.className = 'custom-dialog-box';
            box.innerHTML = `<div class="custom-dialog-title">${title}</div><p class="settings-dialog-prompt" style="white-space:pre-wrap">${promptText}</p>`;
            const area = document.createElement('textarea');
            area.className = 'settings-dialog-textarea';
            area.value = localStorage.getItem(storageKey) || '';
            const btns = document.createElement('div');
            btns.className = 'custom-dialog-buttons';
            const save = document.createElement('button');
            save.className = 'btn-primary';
            save.textContent = "保存";
            save.onclick = () => {
                localStorage.setItem(storageKey, area.value);
                onSave();
                this.showNotification("設置已保存", 'success');
                document.body.removeChild(overlay);
            };
            const cancel = document.createElement('button');
            cancel.className = 'btn-secondary';
            cancel.textContent = "取消";
            cancel.onclick = () => document.body.removeChild(overlay);
            btns.append(save, cancel);
            box.append(area, btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) document.body.removeChild(overlay); });
        }

        addCustomButtons(container) {
            this.removeCustomButtons();
            const C = this.constructor.CONFIG.TEXT;

            // 1. 建立分派工具組的 4 個子按鈕
            const btnExecCart = this.createButton('execCartButton', C.BTN_EXEC_CART, this.showCartManagerDialog.bind(this));
            const btnAddCart = this.createButton('addCartButton', C.BTN_ADD_CART, this.addToCart.bind(this));

            // ✨ 設定加入分派按鈕的多維度提示
            const customCartTitle = "【左鍵點擊】 手動輸入目標\n【右鍵點擊】 自動將已識別的ERN Case加入隊列\n【左鍵長按】 設置ERN Case分派規則\n【右鍵長按】 設置常用快捷分派名單";
            btnAddCart.title = customCartTitle;
            const innerA = btnAddCart.querySelector('a'); if (innerA) innerA.title = customCartTitle;
            const innerDiv = btnAddCart.querySelector('div'); if (innerDiv) innerDiv.title = customCartTitle;

            // ✨ 掛載懸浮下拉選單引擎
            this.setupQuickAssignHover(btnAddCart);

            // ✨ 右鍵與右鍵長按控制邏輯
            let rightPressTimer;
            let isRightLongPress = false;

            btnAddCart.addEventListener('mousedown', (e) => {
                if (e.button === 2) { // 偵測滑鼠右鍵
                    isRightLongPress = false;
                    rightPressTimer = setTimeout(() => {
                        isRightLongPress = true;
                        this.showQuickAssignSettingsDialog(); // 長按 1 秒呼叫快捷名單設定
                    }, 1000);
                }
            });

            btnAddCart.addEventListener('mouseup', (e) => {
                if (e.button === 2) {
                    clearTimeout(rightPressTimer);
                    if (!isRightLongPress && !btnAddCart.getAttribute('disabled')) {
                        this.autoAddToCartFromAnalysis(); // 短按執行原本的自動掃描分流
                    }
                }
            });

            btnAddCart.addEventListener('contextmenu', e => e.preventDefault()); // 阻擋原生右鍵選單

            btnExecCart.addEventListener('contextmenu', e => {
                e.preventDefault();
                this.quickClearAllCart();
            });

            const btnTpx = this.createButton('tpxAnalysisButton', C.TPX_ANALYSIS_BUTTON, this.startTpxAnalysis.bind(this));
            const btnAssign = this.createButton('assignAnalysisButton', C.ASSIGN_ANALYSIS_BUTTON, this.startAssignAnalysis.bind(this));

            // 2. 建立收納開關按鈕 (放置於最右側)
            const btnToggle = this.createButton('dispatchToolsToggle', '分派工具', () => this.toggleDispatchTools());
            btnToggle.title = "點擊 展開/收起 分派相關工具";

            // 3. 建立其他基礎工具按鈕
            const btnFindTN = this.createButton('findTnButton', C.FIND_TN_BUTTON, this.showFindTnInputDialog.bind(this));
            const btnFind = this.createButton('findAccountButton', C.FIND_ACCOUNT_BUTTON, this.startFullLoadAndFindAccounts.bind(this));
            const btnRange = this.createButton('rangeSelectButton', C.RANGE_BUTTON, this.selectRowRange.bind(this));
            const btnDup = this.createButton('duplicateCheckButton', C.DUPLICATE_BUTTON, this.startFullLoadAndCheckDuplicates.bind(this));

            this.addLongPressHandler(btnTpx, this.showAssignSettingsDialog.bind(this));
            this.addLongPressHandler(btnAssign, this.showAssignSettingsDialog.bind(this));
            this.addLongPressHandler(btnFind, this.showAccountSettingsDialog.bind(this));
            // ✨ 新增：長按「加入分派隊列」設置佇列識別名單
            this.addLongPressHandler(btnAddCart, this.showQueueSettingsDialog.bind(this));

            this.buttons = {
                addCart: btnAddCart,
                execCart: btnExecCart,
                tpx: btnTpx,
                assign: btnAssign,
                findTN: btnFindTN,
                find: btnFind,
                range: btnRange,
                dup: btnDup,
                toggle: btnToggle // 儲存收納按鈕引用
            };

            // 4. 精確排序插入 (由右至左插入，確保網頁畫面上從左到右自然排開)
            container.insertBefore(btnToggle, container.firstChild);     // 最右側
            container.insertBefore(btnExecCart, container.firstChild);
            container.insertBefore(btnAddCart, container.firstChild);
            container.insertBefore(btnTpx, container.firstChild);
            container.insertBefore(btnAssign, container.firstChild);
            container.insertBefore(btnFindTN, container.firstChild);
            container.insertBefore(btnFind, container.firstChild);
            container.insertBefore(btnRange, container.firstChild);
            container.insertBefore(btnDup, container.firstChild);        // 最左側

            // 5. 讀取歷史喜好，套用展開/收起狀態
            const isExpanded = localStorage.getItem('salesforce_dispatch_tools_expanded') === 'true';
            this.applyDispatchToolsState(isExpanded);

            console.log('[Case助手]：按鈕注入與側滑收納配置完成。');
        }

        // ✨ 新增：切換分派工具收納狀態
        toggleDispatchTools() {
            const isExpanded = localStorage.getItem('salesforce_dispatch_tools_expanded') === 'true';
            this.applyDispatchToolsState(!isExpanded);
        }

        // ✨ 新增：套用並記憶收納狀態 (動態實心箭頭 修正版)
        applyDispatchToolsState(isExpanded) {
            const subButtonKeys = ['assign', 'tpx', 'addCart', 'execCart'];

            // 顯示或隱藏 4 個子按鈕
            subButtonKeys.forEach(key => {
                const btn = this.buttons[key];
                if (btn) {
                    btn.style.display = isExpanded ? "" : "none";
                }
            });

            // 更新收納按鈕的排版 (展開/摺疊時箭頭位置對調，且顏色繼承字體原生色)
            const toggleBtn = this.buttons.toggle;
            if (toggleBtn) {
                const textDiv = toggleBtn.querySelector('div');
                if (textDiv) {
                    const arrowLeft = '\u25C0\uFE0E';  // 實心左三角 (文字化)
                    const arrowRight = '\u25B6\uFE0E'; // 實心右三角 (文字化)

                    if (isExpanded) {
                        // ✨ 展開狀態下：文字在左，箭頭在右 [分派工具 ▶]
                        textDiv.innerHTML = `分派工具 <span style="color: inherit; font-size: 10px; margin-left: -1px; display: inline-block;">${arrowRight}</span>`;
                    } else {
                        // ✨ 摺疊狀態下：箭頭在左，文字在右 [◀ 分派工具]
                        textDiv.innerHTML = `<span style="color: inherit; font-size: 10px; margin-right: -1px; display: inline-block;">${arrowLeft}</span> 分派工具`;
                    }
                }

                // 保持 100% Salesforce 原生外觀
                toggleBtn.style.borderLeft = '';
                toggleBtn.style.background = '';
            }

            // 記憶狀態
            localStorage.setItem('salesforce_dispatch_tools_expanded', isExpanded);
        }

        removeCustomButtons() {
            ['duplicateCheckButton', 'findAccountButton', 'findTnButton', 'rangeSelectButton', 'assignAnalysisButton', 'tpxAnalysisButton', 'addCartButton', 'execCartButton', 'dispatchToolsToggle'].forEach(id => {
                const el = document.getElementById(id) || this.findElementInShadowDom('#' + id);
                if (el) el.remove();
            });
            this.buttons = {};
        }

        createButton(id, text, handler) {
            const li = document.createElement('li');
            li.className = 'slds-button slds-button--neutral slds-button_neutral';
            li.id = id;
            li.style.cssText = `width: 113px;text-align: center;margin-left: 0.25rem;padding-right: 6px;padding-left: 6px;`;
            li.innerHTML = `<a href="javascript:void(0);" role="button" class="forceActionLink" style="display:flex;justify-content:center;align-items:center;height:2rem;padding:0 0rem;color:var(--slds-c-button-text-color);"><div title="${text}">${text}</div></a>`;
            li.addEventListener('click', e => {
                if (!li.getAttribute('disabled') && !this.isLongPress) handler(e);
            });
            return li;
        }

        addLongPressHandler(el, callback) {
            el.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                this.isLongPress = false;
                this.longPressTimer = setTimeout(() => {
                    this.isLongPress = true;
                    callback();
                }, 1000);
            });
            const clear = () => clearTimeout(this.longPressTimer);
            el.addEventListener('mouseup', clear);
            el.addEventListener('mouseleave', clear);
        }

        setButtonsDisabled(disabled) {
            Object.values(this.buttons).forEach(b => {
                disabled ? b.setAttribute('disabled', 'true') : b.removeAttribute('disabled');
            });
        }
    }

    const currentHref = window.location.href;
    const isChangeOwnerPage = currentHref.includes('CEC_Change_Case_Owner') || document.querySelector('form[action*="CEC_Change_Case_Owner"]') !== null;

    if (isChangeOwnerPage) {
        new VFChangeOwnerOptimizer();
    } else {
        new SalesforceCaseOptimizer();
    }
})();
