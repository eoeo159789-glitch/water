/* 2020-2024 台灣有發布警報之颱風（含日期範圍，供快速篩選使用）
   資料來源：中央氣象署颱風資料庫「有發警報颱風列表」
   https://rdc28.cwa.gov.tw/TDB/public/warning_typhoon_list/
   （警報期間為發布至解除之台灣標準時間區間，這裡取其涵蓋之日期範圍） */
const TYPHOON_PERIODS = [
  { code: "202001", name_zh: "黃蜂", name_en: "VONGFONG", intensity: "輕度", start: "2020-05-16", end: "2020-05-17" },
  { code: "202004", name_zh: "哈格比", name_en: "HAGUPIT", intensity: "中度", start: "2020-08-02", end: "2020-08-03" },
  { code: "202006", name_zh: "米克拉", name_en: "MEKKHALA", intensity: "輕度", start: "2020-08-10", end: "2020-08-11" },
  { code: "202008", name_zh: "巴威", name_en: "BAVI", intensity: "輕度", start: "2020-08-22", end: "2020-08-22" },
  { code: "202020", name_zh: "閃電", name_en: "ATSANI", intensity: "輕度", start: "2020-11-05", end: "2020-11-07" },
  { code: "202103", name_zh: "彩雲", name_en: "CHOI-WAN", intensity: "輕度", start: "2021-06-03", end: "2021-06-04" },
  { code: "202106", name_zh: "烟花", name_en: "IN-FA", intensity: "中度", start: "2021-07-21", end: "2021-07-24" },
  { code: "202109", name_zh: "盧碧", name_en: "LUPIT", intensity: "輕度", start: "2021-08-04", end: "2021-08-05" },
  { code: "202114", name_zh: "璨樹", name_en: "CHANTHU", intensity: "強烈", start: "2021-09-10", end: "2021-09-13" },
  { code: "202118", name_zh: "圓規", name_en: "KOMPASU", intensity: "輕度", start: "2021-10-10", end: "2021-10-12" },
  { code: "202211", name_zh: "軒嵐諾", name_en: "HINNAMNOR", intensity: "強烈", start: "2022-09-02", end: "2022-09-04" },
  { code: "202212", name_zh: "梅花", name_en: "MUIFA", intensity: "中度", start: "2022-09-11", end: "2022-09-13" },
  { code: "202220", name_zh: "尼莎", name_en: "NESAT", intensity: "中度", start: "2022-10-15", end: "2022-10-16" },
  { code: "202302", name_zh: "瑪娃", name_en: "MAWAR", intensity: "中度", start: "2023-05-29", end: "2023-05-31" },
  { code: "202305", name_zh: "杜蘇芮", name_en: "DOKSURI", intensity: "中度", start: "2023-07-24", end: "2023-07-28" },
  { code: "202306", name_zh: "卡努", name_en: "KHANUN", intensity: "中度", start: "2023-08-01", end: "2023-08-04" },
  { code: "202309", name_zh: "蘇拉", name_en: "SAOLA", intensity: "強烈", start: "2023-08-28", end: "2023-08-31" },
  { code: "202311", name_zh: "海葵", name_en: "HAIKUI", intensity: "中度", start: "2023-09-01", end: "2023-09-05" },
  { code: "202314", name_zh: "小犬", name_en: "KOINU", intensity: "中度", start: "2023-10-02", end: "2023-10-06" },
  { code: "202403", name_zh: "凱米", name_en: "GAEMI", intensity: "強烈", start: "2024-07-22", end: "2024-07-26" },
  { code: "202418", name_zh: "山陀兒", name_en: "KRATHON", intensity: "強烈", start: "2024-09-29", end: "2024-10-04" },
  { code: "202421", name_zh: "康芮", name_en: "KONG-REY", intensity: "強烈", start: "2024-10-29", end: "2024-11-01" },
  { code: "202425", name_zh: "天兔", name_en: "USAGI", intensity: "中度", start: "2024-11-14", end: "2024-11-16" },
];

/* 2025 年以後的颱風：水利署水文年報尚未納入（本系統年報資料只到 2024），
   快選時改開「颱風事件雨量」模式，以中央氣象署颱風資料庫測站逐時資料繪製。
   日期為警報期間；未提供警報期間者取逐時資料期間。 */
const TYPHOON_PERIODS_CWA_ONLY = [
  { id: "2025DANAS", name_zh: "丹娜絲", name_en: "DANAS", start: "2025-07-05", end: "2025-07-07" },
  { id: "2025WIPHA", name_zh: "薇帕", name_en: "WIPHA", start: "2025-07-18", end: "2025-07-19" },
  { id: "2025PODUL", name_zh: "楊柳", name_en: "PODUL", start: "2025-08-12", end: "2025-08-14" },
  { id: "2025RAGASA", name_zh: "樺加沙", name_en: "RAGASA", start: "2025-09-21", end: "2025-09-23" },
  { id: "2025FUNG-WONG", name_zh: "鳳凰", name_en: "FUNG-WONG", start: "2025-11-10", end: "2025-11-12" },
  { id: "2026BAVI", name_zh: "巴威", name_en: "BAVI", start: "2026-07-09", end: "2026-07-12" },
  { id: "2026NOUL", name_zh: "紅霞", name_en: "NOUL", start: "2026-07-23", end: "2026-07-25" },
  { id: "2026DOLPHIN", name_zh: "白海豚", name_en: "DOLPHIN", start: "2026-08-07", end: "2026-08-09" },
  { id: "2026SAUDEL", name_zh: "沙德爾", name_en: "SAUDEL", start: "2026-08-27", end: "2026-08-28" },
];
