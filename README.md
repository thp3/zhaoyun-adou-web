# 趙雲與阿斗：純文字瀏覽器復刻

單人對本機 AI，靜態網站加瀏覽器本機存檔，不使用任何圖片。

## 指令

```bash
npm install
npm run dev        # 本機開發
npm test           # 規則與資料測試
npm run build      # 產出 dist/ 靜態網站
npm run extract    # 從原版對照資料重新產生 data/（預設來源 D:/gathergame，可加 --src）
```

## data/ 資料表（M0）

由 `tools/extract/extract.mjs` 產生，請勿手改；修正請改抽取腳本後重跑。

| 檔案 | 內容 |
|---|---|
| tokens.json | 24 種字牌（固定英文 id、繁體顯示字、AI 價值） |
| maps.json | 4 張 8×10 地圖，`kind[x][y]`：0 道路／1 可部署／2 待開墾；`camp[x][y]`：0 玩家／1 AI |
| deck.json | 108 張初始牌庫、征兵、教程注入 |
| units.json / generals.json | 普通兵、農民、12 武將、7 技能、經驗表 |
| waves.json | 20 波出兵、血量策略、12 Boss |
| ai.json | AI 決策間隔、補助、評分參數 |
| items.json / buffs.json | 25 道具、20 buff |
| weapons.json / ranks.json | 44 武器＋4 預設、54 段位與對手生成 |
| economy.json | 體力、結算金幣、開局資金 |
| legacy/constants.json | 原版常數原樣保留，僅供查證 |
| manifest.json | 來源檔 SHA-256 與數量 |

遊戲只透過 `src/data/index.ts` 取資料；啟動時用 zod 驗證，壞資料會停在錯誤頁。
