# Smart In-Cabin Energy & Incident Automation System

智慧車載電力與事件自動化模擬系統。

## 執行方式

需求：Node.js 20 以上。

```bash
npm install
npm start
```

- 中控儀表＋TA 模擬操作台：http://localhost:3000/
- 區域與設備配置：http://localhost:3000/config.html

更換連接埠：`PORT=8080 npm start`（Windows PowerShell：`$env:PORT=8080; npm start`）

自動化測試：

```bash
npm test
```

TA 驗收步驟請看 [docs/TA_GUIDE.md](docs/TA_GUIDE.md)，提案逐條對照請看 [docs/REQUIREMENTS_TRACE.md](docs/REQUIREMENTS_TRACE.md)。

## 專案結構

```
server.js                 Express 伺服器、REST API、SSE 即時推送、模擬時鐘、日誌匯出
src/engine/Engine.js      事件邏輯核心：動作分派、狀態推導、日誌、情境、配置 CRUD
src/engine/rules.js       規則：撞擊、救護車、盲區、低里程、舒適度、警示優先順序、系統／分區等級
src/engine/powerManager.js 電力預算與負載管理（卸載、降載、延後啟動、恢復）
src/engine/deviceTypes.js 設備類型與耗電模型
src/config/defaultVehicle.json 內建初始資料：系統參數、區域、設備拓撲、環境
src/config/stations.json  內建加油站 POI（id / name / lat / lng）
src/config/*.js           載入上述 JSON 並提供距離計算
public/                   前端（儀表、eCall 通話視窗、TA 操作台、配置頁）
test/                     各行為的自動化測試（node:test）
docs/PROPOSAL.md          提案逐字轉錄（功能需求依據）
docs/TA_GUIDE.md          TA 驗收操作步驟與預期結果
docs/REQUIREMENTS_TRACE.md 提案逐條對照：實作位置、測試、畫面驗證方式
```

## 六大行為對照

| 行為 | 觸發 | 連鎖反應 |
|---|---|---|
| 1 前／後撞擊 | `impact { g, direction: front \| rear }`，g ≥ 4.0 且該側至少一顆碰撞傳感器正常（無傳感器或全部故障則不偵測） | 系統等級升為 `CRITICAL_EMERGENCY`（頁首顯示並寫入日誌）；儀表紅色警告並標記碰撞方位；全部記錄器 EMERGENCY_LOCK，受撞擊側記錄器優先 UPLOADING（10 秒）；eCall 通話視窗 10 秒倒數，可選擇撥打 119 或 110（`selectEcall`）或取消誤觸；倒數結束未選擇則撥 119 並通報 110；CONNECTED 時傳送 GPS 與撞擊方向；P2／P3 與音響強制關閉 |
| 2 救護車 | `siren { active, direction }`，且音訊傳感器正常（故障或未配置則不偵測） | 音響 MUTED（保留原音量）、儀表顯示「[方位] 有救護車，請注意避讓」、笛聲結束自動恢復 |
| 3 盲區 | 盲區雷達 `DETECTED` ＋ 同側方向燈 `ACTIVE` | 該側後視鏡 LED FLASHING、中控蜂鳴器持續警示音；僅有車未打燈 → LED 恆亮、不鳴響；關燈或車輛離開立即解除 |
| 4 低里程 | 行車電腦回報里程 ≤ 30 km（≤ 10 km 為紅色 CRITICAL_RANGE；回升至 > 35 km 才解除） | 以里程 × 0.9 篩選可抵達加油站，依距離排序顯示站名、距離、預估抵達消耗；可設定或取消導航；目標超出範圍時自動取消 |
| 5 電力超載 | 管理前需求負載率 > 100% | P3 關閉 → P2 座椅加熱逐檔降至 0（後座→副駕→駕駛） → P1 空調逐檔降至 1（除霧不關） → P0 永不卸載；容量回升反向恢復、解除 DEFERRED |
| 6 車外溫度 | `setAmbient { celsius }`（−20 ～ 45） | 自動模式依溫差調節空調檔位；≤ 3 °C 自動開除霧（180 W），> 5 °C 關閉；日誌記錄每次自動調節 |

狀態與等級：

- 設備狀態：`NORMAL`、`WARNING`、`EMERGENCY`、`STANDBY`、`SHED`、`DEFERRED`、`FAULT`。
- 分區狀態：取區內最嚴重的設備狀態（嚴重度 EMERGENCY > FAULT > WARNING > SHED > DEFERRED > NORMAL > STANDBY；空區為 STANDBY）。
- 系統等級：事故進行中為 `CRITICAL_EMERGENCY`；有紅色警示（盲區衝突、CRITICAL_RANGE、電力危急）為 `CRITICAL`；有黃色警示或安全設備（P0）故障為 `WARNING`；其餘為 `NORMAL`。

聽覺警示：頁首「警示音」按鈕開啟後，蜂鳴器發聲期間持續播放警示音，救護車與低里程提示出現時播放提示音。蜂鳴器在盲區變道衝突時鳴響；撞擊後也會在 eCall 倒數期間鳴響，提醒駕駛選擇撥打對象或取消，撥出或取消後停止。瀏覽器規定須由使用者點擊一次才能發聲，所以預設關閉。

設計決策（提案文字有解讀空間的部分）：

- 「受撞擊側優先執行 UPLOADING」解讀為：只有受撞擊側的記錄器上傳（10 秒），其餘記錄器進入 `EMERGENCY_LOCK` 鎖定保存、不上傳；受撞擊側記錄器故障或被移除時才改由另一台重新上傳。已上傳完成的影像不會因記錄器被移除而重傳。
- 「畫面提供選擇撥打 119 或 110」解讀為動作：選擇後立即撥打，不再等待剩餘倒數；未選擇則倒數結束自動撥打 119 並通報 110。
- 「倒數結束轉為 CONNECTED」：`ecallConnectS` 預設 0 秒（直接連線）；可在配置頁調高以模擬撥號延遲（期間狀態為 `CALLING`）。
- 倒數或撥號期間 eCall 模組故障 → 自動通報中斷（`FAULT`），模組修復後不會自動恢復通報，駕駛需手動撥打。
- 受撞擊側沒有任何可用的碰撞傳感器（全部故障或未配置）時，撞擊不會被偵測。
- 感測與輸出分開建模：盲區雷達負責偵測，後視鏡 LED 與蜂鳴器負責警示。雷達故障時該側盲區輔助失效；後視鏡 LED 或蜂鳴器故障時，其餘警示（儀表、另一種輸出）照常運作。
- 救護車笛聲屬於環境狀態：音訊傳感器故障期間不會偵測；笛聲仍在時修復傳感器，會立即偵測到並靜音。
- 低里程提示有遲滯：≤ 30 km 觸發，里程回升至 > 35 km 才解除，避免在門檻附近反覆出現又消失。推薦表與操作台都會寫出這條規則，門檻可在配置頁調整（`lowRangeKm`、`lowRangeClearKm`、`criticalRangeKm`）。
- 里程屬於車輛狀態，經由行車電腦（ECU）取得：ECU 故障或未配置時，儀表顯示「里程資訊無法取得」，不推薦加油站，也不能設定新的導航（已設定的目標保留）。修復或重新配置 ECU 後，立即依目前里程判斷。

## API 摘要

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/state` | 目前完整狀態 |
| GET | `/api/stream` | Server-Sent Events，狀態變化時推送 |
| POST | `/api/actions` | 觸發事件／操作，body 為 `{ "type": ..., ... }` |
| GET | `/api/log?format=json\|csv` | 匯出完整日誌（最多保留 2000 筆） |
| GET | `/api/config` | 區域、設備與系統參數 |
| POST / PUT / DELETE | `/api/zones[/:id]` | 區域 CRUD |
| POST / PUT / DELETE | `/api/devices[/:id]` | 設備 CRUD |
| PUT | `/api/settings` | 更新系統參數 |

`/api/actions` 支援的 `type`：`impact`（`g`、`direction`）、`selectEcall`（`service`: `119` / `110`）、`cancelEcall`、`clearIncident`、`siren`、`blindSpot`、`turnSignal`、`setRange`、`navigate`、`cancelNavigation`、`setCapacity`、`setAlternatorFault`、`setAmbient`、`setDevice`、`setFault`、`clock`（`pause` / `resume` / `step`）、`tick`、`reset`、`factoryReset`、`scenario`。
