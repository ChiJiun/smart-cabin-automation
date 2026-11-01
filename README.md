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

更換連接埠：`PORT=8080 npm start`

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
src/config/               預設車輛配置、加油站 POI
public/                   前端（儀表、TA 操作台、配置頁）
test/                     各行為的自動化測試
```

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

`/api/actions` 支援的 `type`：`impact`、`cancelEcall`、`clearIncident`、`siren`、`blindSpot`、`turnSignal`、`setRange`、`navigate`、`setCapacity`、`setAlternatorFault`、`setAmbient`、`setDevice`、`setFault`、`clock`、`reset`、`factoryReset`、`scenario`。
