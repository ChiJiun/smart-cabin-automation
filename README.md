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

## 專案結構

```
server.js                 Express 伺服器、REST API、SSE 即時推送、模擬時鐘
src/engine/Engine.js      事件邏輯核心：動作分派、狀態推導、日誌、情境、配置 CRUD
src/engine/rules.js       規則：撞擊、救護車、盲區、低里程、舒適度、警示優先順序
src/engine/powerManager.js 電力預算與負載管理（卸載、降載、延後啟動、恢復）
src/engine/deviceTypes.js 設備類型與耗電模型
src/config/defaultVehicle.json 內建初始資料：系統參數、區域、設備拓撲、環境
src/config/stations.json  內建加油站 POI（id / name / lat / lng）
src/config/*.js           載入上述 JSON 並提供距離計算
public/                   前端（儀表、TA 操作台、配置頁）
test/                     各行為的自動化測試（node:test）
docs/PROPOSAL.md          提案逐字轉錄（功能需求依據）
```

## 六大行為對照

| 行為 | 觸發 | 連鎖反應 |
|---|---|---|
| 1 前／後撞擊 | `impact { g, direction: front \| rear }`，g ≥ 4.0 且該側至少一顆碰撞傳感器正常（無傳感器或全部故障則不偵測） | 儀表紅色警告並標記碰撞方向；全部記錄器 EMERGENCY_LOCK，受撞擊側記錄器優先 UPLOADING（10 秒）；eCall 10 秒倒數，可選擇撥打 119 或 110（`selectEcall`）或取消；倒數結束未選擇則撥 119 並通報 110；CONNECTED 時傳送 GPS 與撞擊方向；P2／P3 與音響強制關閉 |
| 2 救護車 | `siren { active, direction }` | 音響 MUTED（保留原音量）、儀表顯示方位、笛聲結束自動恢復 |
| 3 盲區 | 盲區 DETECTED ＋ 同側方向燈 | 該側後視鏡 LED FLASHING、蜂鳴器；僅有車未打燈 → LED 恆亮 |
| 4 低里程 | 里程 ≤ 30 km（≤ 10 km 為 CRITICAL_RANGE） | 以里程 × 0.9 篩選可抵達加油站，依距離排序並可設定導航 |
| 5 電力超載 | 需求 > 容量 | P3 關閉 → P2 座椅加熱逐檔降至 0（後座→副駕→駕駛） → P1 空調逐檔降至 1（除霧不關） → P0 永不卸載；容量回升反向恢復、解除 DEFERRED |
| 6 車外溫度 | `setAmbient { celsius }`（−20 ～ 45） | 自動模式依溫差調節空調檔位；≤ 3 °C 自動開除霧（180 W），> 5 °C 關閉；日誌記錄每次自動調節 |

設備狀態集合：`NORMAL`、`WARNING`、`EMERGENCY`、`STANDBY`、`SHED`、`DEFERRED`、`FAULT`。

行為 1 的設計決策（提案文字有解讀空間的部分）：

- 「受撞擊側優先執行 UPLOADING」解讀為：只有受撞擊側的記錄器上傳（10 秒），其餘記錄器進入 `EMERGENCY_LOCK` 鎖定保存、不上傳；受撞擊側記錄器故障或被移除時才改由另一台重新上傳。已上傳完成的影像不會因記錄器被移除而重傳。
- 「畫面提供選擇撥打 119 或 110」解讀為動作：選擇後立即撥打，不再等待剩餘倒數；未選擇則倒數結束自動撥打 119 並通報 110。
- 「倒數結束轉為 CONNECTED」：`ecallConnectS` 預設 0 秒（直接連線）；可在配置頁調高以模擬撥號延遲（期間狀態為 `CALLING`）。
- 倒數或撥號期間 eCall 模組故障 → 自動通報中斷（`FAULT`），模組修復後不會自動恢復通報，駕駛需手動撥打。
- 受撞擊側沒有任何可用的碰撞傳感器（全部故障或未配置）時，撞擊不會被偵測。

## API 摘要

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/state` | 目前完整狀態 |
| GET | `/api/stream` | Server-Sent Events，狀態變化時推送 |
| POST | `/api/actions` | 觸發事件／操作，body 為 `{ "type": ..., ... }` |
| GET | `/api/config` | 區域、設備與系統參數 |
| POST / PUT / DELETE | `/api/zones[/:id]` | 區域 CRUD |
| POST / PUT / DELETE | `/api/devices[/:id]` | 設備 CRUD |
| PUT | `/api/settings` | 更新系統參數 |

`/api/actions` 支援的 `type`：`impact`（`g`、`direction`）、`selectEcall`（`service`: `119` / `110`）、`cancelEcall`、`clearIncident`、`siren`、`blindSpot`、`turnSignal`、`setRange`、`navigate`、`setCapacity`、`setAlternatorFault`、`setAmbient`、`setDevice`、`setFault`、`clock`（`pause` / `resume` / `step`）、`tick`、`reset`、`factoryReset`、`scenario`。
