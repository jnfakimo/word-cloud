#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=============================================================================
農產品批發市場交易行情站 (AMIS) 自動化批量下載程式
目標網站：https://amis.afa.gov.tw/
查詢條件：
  - 日期範圍：民國 110年1月1日 至 115年9月5日 (110/01/01 ~ 115/09/05)
  - 市場選擇：全市場
  - 產品選擇：全部產品
  - 檔案格式：Excel (.xls)

注意事項：
  官方 AMIS 系統若單次查詢跨度過長（如一次查詢數年）會因資料量過大觸發伺服器逾時錯誤。
  本程式採用「自動按月分割批次下載」策略，可穩健完成全量資料獲取，並具備斷點續傳功能。
=============================================================================
"""

import os
import sys
import time
import calendar
import requests
from bs4 import BeautifulSoup

# 分類與對應網址
CATEGORY_MAP = {
    'veg': ('蔬菜', 'https://amis.afa.gov.tw/veg/VegProdDayTransInfo.aspx'),
    'fruit': ('水果', 'https://amis.afa.gov.tw/fruit/FruitProdDayTransInfo.aspx'),
    'flower': ('花卉', 'https://amis.afa.gov.tw/flower/FlowerProdDayTransInfo.aspx'),
}

def generate_month_intervals(start_roc_year, start_month, end_roc_year, end_month, end_day):
    """
    產生指定民國年月範圍的起訖日期清單
    傳回 format: [('110/01/01', '110/01/31', '11001'), ...]
    """
    intervals = []
    
    start_ad_year = start_roc_year + 1911
    end_ad_year = end_roc_year + 1911
    
    cur_y = start_ad_year
    cur_m = start_month
    
    while True:
        roc_y = cur_y - 1911
        
        # 該月第一天與最後一天
        first_day = 1
        _, last_day = calendar.monthrange(cur_y, cur_m)
        
        # 如果是結束的那個年份與月份，日期不可超過指定的 end_day
        if cur_y == end_ad_year and cur_m == end_month:
            last_day = min(last_day, end_day)
            
        s_date_str = f"{roc_y:03d}/{cur_m:02d}/{first_day:02d}"
        e_date_str = f"{roc_y:03d}/{cur_m:02d}/{last_day:02d}"
        suffix = f"{roc_y:03d}{cur_m:02d}"
        
        intervals.append((s_date_str, e_date_str, suffix))
        
        if cur_y == end_ad_year and cur_m == end_month:
            break
            
        cur_m += 1
        if cur_m > 12:
            cur_m = 1
            cur_y += 1
            
    return intervals

def download_single_month(session, page_url, s_date, e_date, output_path, max_retries=3):
    """
    對 AMIS 網站發送 POST 請求下載單一月份 Excel 檔 (.xls)
    """
    for attempt in range(1, max_retries + 1):
        try:
            # 1. 發送 GET 取得 ASP.NET 必要之 __VIEWSTATE、__EVENTVALIDATION
            res_get = session.get(page_url, timeout=30)
            if res_get.status_code != 200:
                print(f"   [警告] GET 狀態碼 {res_get.status_code}，嘗試第 {attempt} 次重試...", flush=True)
                time.sleep(2)
                continue
                
            soup = BeautifulSoup(res_get.text, 'html.parser')
            payload = {}
            for inp in soup.find_all('input'):
                name = inp.get('name')
                val = inp.get('value', '')
                if name:
                    payload[name] = val
                    
            # 2. 寫入查詢表單參數 (日期區間、全市場、全部產品)
            payload['ctl00$contentPlaceHolder$ucDateScope$rblDateScope'] = 'P'  # P = 日期區間
            payload['ctl00$contentPlaceHolder$txtSTransDate'] = s_date          # 起始日期 (例: 110/01/01)
            payload['ctl00$contentPlaceHolder$txtETransDate'] = e_date          # 結束日期 (例: 110/01/31)
            payload['ctl00$contentPlaceHolder$hfldMarketNo'] = ''               # 空值 = 全市場
            payload['ctl00$contentPlaceHolder$hfldProductNo'] = ''              # 空值 = 全部產品
            
            # 清除非 Excel 下載的提交按鈕 (如 查詢按鈕、ODS 按鈕)
            keys_to_remove = [k for k in payload.keys() if 'btnQuery' in k or 'btnOds' in k]
            for k in keys_to_remove:
                del payload[k]
                
            # 3. 發送 POST 下載 Excel
            res_post = session.post(page_url, data=payload, timeout=120)
            disp = res_post.headers.get('Content-Disposition', '')
            
            # 檢查傳回結果是否為有效 Excel (檔案大小 > 100KB)
            if res_post.status_code == 200 and 'attachment' in disp and len(res_post.content) > 100000:
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                with open(output_path, 'wb') as f:
                    f.write(res_post.content)
                mb_size = len(res_post.content) / (1024 * 1024)
                print(f"   [成功] {s_date} ~ {e_date} -> {os.path.basename(output_path)} ({mb_size:.2f} MB)", flush=True)
                return True
            else:
                print(f"   [重試 {attempt}/{max_retries}] 伺服器回應異常或無資料 (檔案大小: {len(res_post.content)} bytes)...", flush=True)
                time.sleep(3)
        except Exception as err:
            print(f"   [錯誤 {attempt}/{max_retries}] 連線異常: {err}", flush=True)
            time.sleep(3)
            
    return False

def run_amis_scraper(categories=['veg'], start_roc=(110, 1), end_roc=(115, 9, 5), output_dir='amis_downloads'):
    """
    AMIS 爬蟲主流程
    """
    print("=" * 70, flush=True)
    print("  農產品批發市場交易行情站 (AMIS) - 批量下載腳本", flush=True)
    print(f"  查詢區間: 民國 {start_roc[0]}年{start_roc[1]}月01日 至 {end_roc[0]}年{end_roc[1]}月{end_roc[2]:02d}日", flush=True)
    print("  市場條件: 全市場", flush=True)
    print("  產品條件: 全部產品", flush=True)
    print("=" * 70, flush=True)
    
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    })
    
    # 產生月份區間
    intervals = generate_month_intervals(
        start_roc_year=start_roc[0], start_month=start_roc[1],
        end_roc_year=end_roc[0], end_month=end_roc[1], end_day=end_roc[2]
    )
    
    print(f"\n共有 {len(intervals)} 個月份批次檔案待下載...\n", flush=True)
    
    for cat_key in categories:
        if cat_key not in CATEGORY_MAP:
            print(f"未知的分類代碼: {cat_key}", flush=True)
            continue
            
        cat_title, target_url = CATEGORY_MAP[cat_key]
        target_folder = os.path.join(output_dir, cat_key)
        
        print(f"\n>>> 開始處理【{cat_title}行情】下載任務 (儲存路徑: {target_folder})", flush=True)
        
        success_num = 0
        skip_num = 0
        failed_list = []
        
        for idx, (s_date, e_date, suffix) in enumerate(intervals, 1):
            file_name = f"amis_{cat_key}_{suffix}.xls"
            file_path = os.path.join(target_folder, file_name)
            
            # 斷點續傳：若檔案已存在且大小 > 100KB，自動跳過
            if os.path.exists(file_path) and os.path.getsize(file_path) > 100000:
                print(f"[{idx}/{len(intervals)}] 已有下載紀錄，自動跳過: {file_name}", flush=True)
                skip_num += 1
                success_num += 1
                continue
                
            print(f"[{idx}/{len(intervals)}] 下載中: {s_date} ~ {e_date} ...", flush=True)
            ok = download_single_month(session, target_url, s_date, e_date, file_path)
            
            if ok:
                success_num += 1
            else:
                failed_list.append((s_date, e_date, file_name))
                
            # 良好網路禮貌：每次下載間隔 1.5 秒
            time.sleep(1.5)
            
        print(f"\n【{cat_title}行情】下載完成！ 成功: {success_num} / 跳過: {skip_num} / 失敗: {len(failed_list)}", flush=True)
        if failed_list:
            print("以下月份下載失敗，可重新執行程式會自動重試：", flush=True)
            for item in failed_list:
                print(f"  - {item[0]} ~ {item[1]} ({item[2]})", flush=True)

if __name__ == '__main__':
    # 預設下載：蔬菜 (veg)；可調整為 ['veg', 'fruit', 'flower'] 下載全部
    run_amis_scraper(categories=['veg'])
