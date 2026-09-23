/* 2023-2024 台灣有發布警報之颱風（含日期範圍，供快速篩選使用）
   資料來源：中央氣象署颱風資料庫「有發警報颱風列表」
   https://rdc28.cwa.gov.tw/TDB/public/warning_typhoon_list/
   （警報期間為發布至解除之台灣標準時間區間，這裡取其涵蓋之日期範圍） */
const TYPHOON_PERIODS = [
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
