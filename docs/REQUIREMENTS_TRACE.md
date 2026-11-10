# 提案需求追蹤表

本表把 [PROPOSAL.md](PROPOSAL.md) 的每一項需求，對應到實作位置、自動化測試與畫面驗證方式。畫面操作的完整步驟見 [TA_GUIDE.md](TA_GUIDE.md)。

- 實作位置以「檔案：函式」標示，避免行號變動後失效。
- 測試以「測試檔：測試名稱」標示，全部用 `npm test` 執行。
- 「畫面」欄寫 TA 在網頁上要按什麼、看哪裡。

## 1. 問題描述與 2. 目標受眾

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 前後行車記錄器、電子後視鏡、中控音響、儀表螢幕、空調、座椅加熱、車用插座跨區整合 | `src/config/defaultVehicle.json` 定義 5 個分區、24 台設備；`src/engine/deviceTypes.js` 定義耗電模型 | system：reset restores the known initial state… | 「車輛區域與設備」面板 |
| 發電機預設 1000 W | `defaultVehicle.json`：`settings.capacityW` | b5：default state is NORMAL at 211 W / 1000 W | 電力預算「211 / 1000 W」 |
| 駕駛獲得主動聽視覺警示（盲區閃爍、救護車避讓、加油站推薦） | 視覺：`rules.js`：`computeAlerts`；聽覺：`public/app.js`：`updateSound`（蜂鳴器持續警示音、救護車與低里程提示音） | b2、b3、b4 各測試 | 儀表警示橫幅；頁首「警示音」開啟後可聽到 |
| 撞擊時自動存證與 110/119 通報支援 | 見行為 1 | 見行為 1 | eCall 通話視窗 |
| 乘客正常使用座椅加熱與車載充電插座，超載時獲得明確的延後／降載提示 | `rules.js`：`computeAlerts`（電力警示列出降載、卸載、延後啟動的設備）；`app.js`：`powerNote` | b5：a device turned on without headroom is DEFERRED… | 區域卡片設備列顯示「延後啟動・電力不足（容量回升後自動啟動）」等文字 |
| TA 注入事件、調整氣溫／電力、控制模擬時鐘、檢視日誌以驗證可重現性 | `public/index.html` TA 操作台；`Engine.js`：`dispatch`、`exportLog`、`exportLogCsv`；`server.js`：`GET /api/log` | system：reproducibility…、HTTP API: the full log can be exported… | 操作台、頁首時鐘、日誌篩選與「匯出 JSON／CSV」 |

## 3. 專案範疇

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 分區（Zone）與各級設備的拓撲規劃 | `Engine.js`：`addZone`、`updateZone`、`deleteZone`、`addDevice`、`updateDevice`、`deleteDevice` | system：config: zones cannot be deleted…、config: device priority affects shedding… | 「區域與設備配置」頁 |
| 狀態監視（Normal, Warning, Emergency, Standby, Shed, Deferred, Fault） | 設備：`rules.js`：`deriveStatus`；分區：`rules.js`：`deriveZoneStatus` | system：device status is always one of the seven…、zone status is the most severe… | 每台設備與每個區域卡片的狀態標籤，觸發方式見下表 |
| 以各設備瓦特數加總計算負載率 | `powerManager.js`：`allocatePower`（`requestedPct` 管理前、`loadPct` 管理後） | b5：winter overload scenario… | 電力預算「設備需求（管理前）」與「實際負載率」 |
| P0–P3 階梯式自動降載、延後啟動與恢復 | 見行為 5 | 見行為 5 | 電力預算「負載管理決策」 |
| 六大重大行為 | 見第 4 節 | b1–b6 | 見第 4 節 |
| TA 模擬測試控制台、確定性模擬時鐘（可單步／暫停）、一鍵重置 | `Engine.js`：`tick`、`actions.clock`、`reset`、`factoryReset`；`server.js` 每秒推進一次 | system：reset restores…、reproducibility… | 頁首「暫停」「+1 秒」「+5 秒」「+10 秒」；操作台「重置狀態」「恢復原廠配置」 |
| Out of Scope：影片編碼與電信撥號以模擬進度條與視窗呈現 | `app.js`：`renderCockpit`（上傳進度條）、`renderEcallWindow`（模擬通話視窗） | b1：eCall counts down 10 s… | 撞擊後的進度條與左下角「eCall 緊急通報」視窗 |

七種狀態的觸發方式：

| 狀態 | 操作 | 會看到的設備 |
|---|---|---|
| NORMAL | 預設狀態 | 前碰撞傳感器 MONITORING |
| WARNING | 按「左盲區有車」 | 左盲區雷達 DETECTED、左電子後視鏡 STEADY |
| EMERGENCY | 按「觸發前撞」 | 前行車記錄器 UPLOADING、eCall COUNTDOWN |
| STANDBY | 預設狀態 | 座椅加熱 OFF |
| SHED | 載入「寒流夜間長途」，或撞擊後的緊急電力保留 | 娛樂音響 |
| DEFERRED | 載入「寒流夜間長途」 | 車用逆變器插座、後座娛樂螢幕 |
| FAULT | 「設備故障注入」選任一設備按「注入故障」 | 被注入的設備 |

## 4. 重大行為

### 行為 1：前／後撞擊存證、自動報警與緊急電力保留

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 前碰撞或後碰撞傳感器回報衝擊值 ≥ 4.0 g | `Engine.js`：`actions.impact`（受撞側需有正常的 `g_sensor`） | b1：impact below 4.0 g only logs…、a side without any collision sensor… | 操作台「觸發前撞」「觸發後撞」 |
| 系統升為 CRITICAL_EMERGENCY | `rules.js`：`deriveSystemLevel`；`Engine.js`：`_logChanges` 記錄等級轉換 | b1：a collision raises the system level to CRITICAL_EMERGENCY… | 頁首「系統等級 CRITICAL_EMERGENCY（緊急事故）」 |
| 儀表跳出紅色事故警告並標記碰撞方位（前側／後側） | `rules.js`：`computeAlerts`（collision）；`app.js`：`renderCockpit` | b1：rear impact is marked as rear… | 紅色橫幅與「碰撞方位：後方（後側）」 |
| 前後記錄器切換至 EMERGENCY_LOCK，受撞擊側優先執行 UPLOADING（10 秒完成 100%） | `rules.js`：`deriveMode`（dashcam）；`Engine.js`：`_pickUploadSource`、`_advanceIncident` | b1：eCall counts down 10 s…、rear impact is marked as rear… | 上傳進度條與記錄器模式 |
| 10 秒 eCall 倒數，可選擇撥打 119 或 110，可取消誤觸 | `Engine.js`：`actions.selectEcall`、`actions.cancelEcall`、`_advanceIncident` | b1：the driver can choose 119 or 110…、driver can cancel eCall… | eCall 通話視窗的三個按鈕 |
| 倒數結束轉為 CONNECTED 並發送座標與撞擊方向 | `Engine.js`：`_startCall`、`_connectCall` | b1：eCall counts down 10 s, then CONNECTED… | 通話視窗列出 GPS 座標、撞擊方向、衝擊值 |
| 緊急電力保留，強制關閉 P2、P3 設備與音響 | `powerManager.js`：`allocatePower`（`emergency`） | b1：impact >= 4.0 g starts the incident chain、the audio is forced off… | 「負載管理決策」原因為「緊急電力保留」 |

### 行為 2：後方救護車避讓提示

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 音訊傳感器偵測到緊急車輛笛聲並解析出方位 | `rules.js`：`sirenDetected`（需有正常的 `audio_sensor`）；`Engine.js`：`actions.siren` | b2：the siren is detected by the audio sensor…、a faulted audio sensor cannot hear…、without an audio sensor… | 「音訊傳感器」小卡顯示「笛聲：後方」 |
| 娛樂音響切換為 MUTED（保存原音量） | `rules.js`：`muteReasons`；`deviceTypes.js`：`drawFor`（MUTED 不計音量功率） | b2：siren mutes audio… | 音響小卡「🔇 靜音（保留音量 5）」 |
| 中控儀表跳出「[方位] 有救護車，請注意避讓」 | `rules.js`：`computeAlerts`（siren） | b2：siren mutes audio and shows direction… | 儀表橫幅 |
| 笛聲消失後音響與介面自動恢復 | 每次狀態變化重新推導 | b2：siren mutes audio…；ending restores volume | 按「救護車離開」 |

### 行為 3：盲區變換車道衝突警告

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 盲區雷達回報 DETECTED 且同側方向燈為 ACTIVE | `rules.js`：`radarDetects`、`turnSignalActive`、`laneChangeConflict` | b3：radar reports DETECTED / CLEAR and the turn signal reports ACTIVE | 「盲區監測」卡片的雷達與方向燈狀態 |
| 該側後視鏡 LED 快速閃爍（FLASHING） | `rules.js`：`deriveMode`（mirror） | b3：same-side detection + turn signal -> flashing + buzzer | 盲區監測卡片的 LED 燈號 |
| 中控蜂鳴器持續發出警示音 | `rules.js`：`buzzerDemanded`；`app.js`：`updateSound` | b3：same-side detection…、buzzer fault… | 「中控蜂鳴器」小卡；開啟警示音可聽到 |
| 關閉方向燈或車輛離開後立即解除 | 每次狀態變化重新推導 | b3：warning clears immediately… | 方向燈按「關」或再按「左盲區有車」 |
| 僅盲區有車但未打燈則 LED 恆亮不鳴響 | `rules.js`：`deriveMode`（mirror STEADY） | b3：same-side detection…、opposite turn signal does not trigger | LED「恆亮」、蜂鳴器「靜止」 |

### 行為 4：剩餘里程過低與加油站導航推薦

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 續航里程 ≤ 30 km 觸發（≤ 10 km 升級為紅色 CRITICAL_RANGE） | `Engine.js`：`actions.setRange`；`rules.js`：`deriveMode`（ecu） | b4：range <= 30 km…、<= 10 km is critical…、hysteresis… | 操作台「25」「8」 |
| 以剩餘里程 × 0.9 篩選可抵達加油站 POI | `rules.js`：`computeNavigation` | b4：range <= 30 km shows warning and reachable stations… | 推薦表標題顯示計算式 |
| 依距離排序顯示站名、距離、預估抵達消耗 | `app.js`：`navigationHtml` | b4：range <= 30 km…（sorted by distance） | 推薦表 |
| 提供模擬導航設定 | `Engine.js`：`actions.navigate`、`actions.cancelNavigation`、`_reconcileNavigation` | b4：navigation only to reachable stations…、navigation can be cancelled、a target that falls out of range… | 「設定導航」「導航中・取消」「取消導航」 |

### 行為 5：車載電力超載與動態負載管理

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 總功率需求超過發電機容量（負載率 > 100%） | `powerManager.js`：`allocatePower`（`requestedPct`） | b5：winter overload scenario…（129.6%） | 「設備需求（管理前）1296 W・129.6%」 |
| (1) 關閉 P3 逆變器插座與音響 | `powerManager.js`：P3 整台關閉，同等級依 `shedOrder` | b5：winter overload scenario… | 載入「寒流夜間長途」 |
| (2) 依序調降 P2 座椅加熱（後座→副駕→駕駛，每次降 1 檔至 0 檔） | `powerManager.js`：可調設備逐檔降載 | b5：P1/P2 seat heaters are reduced one level at a time…、alternator fault… | 載入「寒流＋發電機故障」 |
| (3) P1 空調每次調降 1 檔（最低保留 1 檔，除霧不關閉） | `powerManager.js`：P1 可調設備最低 1 檔，P1 非可調設備不卸載 | b5：alternator fault (400 W)… | 空調降為 2 檔、除霧維持 |
| (4) P0 永不卸載 | `powerManager.js`：候選只含 P1 以上 | b5：CRITICAL_POWER when P0 + P1 minimum exceeds capacity | 載入「電力危急」 |
| 容量回升依反向順序自動恢復或解除 DEFERRED | 每次重新由需求狀態分配電力 | b5：restoring capacity restores devices in reverse order、a device turned on without headroom is DEFERRED… | 按「發電機故障中（點擊恢復）」 |

P3 內部順序：提案第 (1) 步點名「逆變器插座與音響」。內建配置另有車用冰箱與兩台後座螢幕，目前 P3 卸載順序為冰箱、逆變器、左螢幕、右螢幕、音響。只需要卸載部分 P3 時，會先關冰箱。這一點列為待使用者決定的事項。

### 行為 6：車外溫度與座艙舒適度連動

| 需求 | 實作 | 測試 | 畫面 |
|---|---|---|---|
| 車外溫度變化（測試範圍 −20 °C 至 45 °C） | `Engine.js`：`actions.setAmbient`（範圍驗證） | system：invalid actions are rejected… | 操作台溫度滑桿 |
| 自動模式下依溫差動態調節空調檔位 | `rules.js`：`hvacAutoLevel`、`applyClimate`；`Engine.js`：`_logChanges` 記錄每次調節 | b6：HVAC auto level…、temperature changes HVAC level/mode and power、automatic HVAC level changes… | 空調小卡與日誌 |
| ≤ 3 °C 自動開啟後擋風除霧（180 W），回升至 > 5 °C 自動關閉 | `Engine.js`：`actions.setAmbient`（遲滯）、`_logChanges` | b6：defroster auto on at <= 3 °C…、a repaired auto defroster… | 後擋風除霧設備列與日誌 |
| 功耗隨時回饋至電力預算 | 每次狀態變化重新分配電力 | b6：temperature changes HVAC level/mode and power | 電力預算即時變化 |

## 5. 技術選型與執行方式

| 需求 | 實作 | 測試 |
|---|---|---|
| Node.js 20+（Express） | `package.json`：`engines.node >= 20`、`express` | 全部測試 |
| 純 JavaScript 狀態機與規則引擎 | `src/engine/` | b1–b6 |
| HTML5／CSS／JavaScript，REST ＋ Server-Sent Events | `public/`、`server.js`：`/api/actions`、`/api/stream` | system：HTTP API… |
| 資料以內建 JSON 檔初始化 | `src/config/defaultVehicle.json`、`src/config/stations.json` | system：reset restores…（從 JSON 重載） |
| `node:test` 針對六大行為進行可重現的自動化測試 | `test/b1`–`b6`、`test/system.test.js` | system：reproducibility… |
