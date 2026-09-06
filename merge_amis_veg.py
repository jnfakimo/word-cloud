#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
農產品批發市場交易行情 (AMIS) Excel 檔案高效合併腳本
1. 讀取 amis_downloads/veg/ 目錄下所有月度 .xls 檔案 (列 5 開始為數據)
2. 匯出 1：按年份產出 Excel (.xlsx) 檔案 (包含 110, 111, 112, 113, 114, 115 各年度獨立 Excel)
3. 匯出 2：全量整合 CSV 檔 (amis_veg_master_110-115.csv，附 BOM 避免中文亂碼，含 280萬+ 筆完整記錄)
"""

import os
import sys
import glob
import time
import xlrd
import pandas as pd

# 標準欄位名稱
COLUMN_HEADERS = [
    '日期', '市場', '產品', '上價', '中價', '下價',
    '平均價(元/公斤)', '價變動%', '交易量(公斤)', '量變動%', '備註'
]

def process_and_merge():
    input_dir = 'amis_downloads/veg'
    output_dir = 'amis_downloads'
    
    print("=" * 70, flush=True)
    print("  AMIS 行情全量資料庫 - 多檔高效合併作業", flush=True)
    print("=" * 70, flush=True)
    
    xls_files = sorted(glob.glob(os.path.join(input_dir, 'amis_veg_*.xls')))
    print(f"找到 {len(xls_files)} 個月份檔案待處理...\n", flush=True)
    
    if not xls_files:
        print("未找到任何 .xls 檔案！", flush=True)
        return

    all_years_data = {}
    total_records = 0

    for idx, filepath in enumerate(xls_files, 1):
        filename = os.path.basename(filepath)
        size_bytes = os.path.getsize(filepath)
        
        # 跳過未來/空資料檔 (小於 100KB)
        if size_bytes < 100000:
            print(f"[{idx}/{len(xls_files)}] 跳過無效檔: {filename} ({size_bytes} bytes)", flush=True)
            continue
            
        print(f"[{idx}/{len(xls_files)}] 正在解析: {filename} ({size_bytes/(1024*1024):.2f} MB) ...", flush=True)
        
        try:
            wb = xlrd.open_workbook(filepath)
            sheet = wb.sheet_by_index(0)
            
            # 從第 5 列 (index 5) 開始讀取資料列
            records = []
            for r in range(5, sheet.nrows):
                row_vals = [sheet.cell_value(r, c) for c in range(sheet.ncols)]
                
                # 第一欄為日期，判斷是否有值
                date_val = str(row_vals[0]).strip()
                if date_val and date_val != '':
                    # 截取對應標頭數量的欄位
                    records.append(row_vals[:len(COLUMN_HEADERS)])
                    
            if not records:
                print(f"  [提示] {filename} 無有效資料列", flush=True)
                continue
                
            # 建立 DataFrame
            df = pd.DataFrame(records, columns=COLUMN_HEADERS[:len(records[0])])
            
            # 解析年份 (例如 amis_veg_11001.xls -> 110)
            year_code = filename.split('_')[-1][:3]
            if year_code not in all_years_data:
                all_years_data[year_code] = []
                
            all_years_data[year_code].append(df)
            total_records += len(df)
            print(f"  [成功] 提取 {len(df):,} 筆紀錄", flush=True)
            
        except Exception as err:
            print(f"  [錯誤] 解析 {filename} 時失敗: {err}", flush=True)

    print("\n" + "=" * 70, flush=True)
    print(f"全月度檔案解析完成！總計提取 {total_records:,} 筆交易紀錄", flush=True)
    print("=" * 70 + "\n", flush=True)
    
    os.makedirs(output_dir, exist_ok=True)
    
    # 1. 匯出各年度 Excel 檔 (.xlsx)
    print(">>> 步驟 1/2: 匯出各年度獨立 Excel 檔案 (.xlsx) ...", flush=True)
    for year_code in sorted(all_years_data.keys()):
        df_year = pd.concat(all_years_data[year_code], ignore_index=True)
        xlsx_file = os.path.join(output_dir, f"amis_veg_year_{year_code}.xlsx")
        print(f"  - 正在寫入民國 {year_code} 年 Excel ({len(df_year):,} 筆) -> {os.path.basename(xlsx_file)} ...", flush=True)
        df_year.to_excel(xlsx_file, index=False, engine='openpyxl')
        xlsx_mb = os.path.getsize(xlsx_file) / (1024 * 1024)
        print(f"    [完成] {os.path.basename(xlsx_file)} ({xlsx_mb:.2f} MB)", flush=True)

    # 2. 匯出全量 5 年整合 CSV 檔
    print("\n>>> 步驟 2/2: 匯出全量 5 年整合 CSV 檔案 (amis_veg_master_110-115.csv) ...", flush=True)
    master_dfs = [df for df_list in all_years_data.values() for df in df_list]
    df_master = pd.concat(master_dfs, ignore_index=True)
    
    csv_file = os.path.join(output_dir, "amis_veg_master_110-115.csv")
    df_master.to_csv(csv_file, index=False, encoding='utf-8-sig')
    csv_mb = os.path.getsize(csv_file) / (1024 * 1024)
    
    print("\n" + "*" * 70, flush=True)
    print("  [全量資料整合成功]", flush=True)
    print(f"  檔案名稱: {os.path.basename(csv_file)}", flush=True)
    print(f"  檔案路徑: {os.path.abspath(csv_file)}", flush=True)
    print(f"  總交易筆數: {len(df_master):,} 筆", flush=True)
    print(f"  檔案總大小: {csv_mb:.2f} MB", flush=True)
    print("*" * 70 + "\n", flush=True)

if __name__ == '__main__':
    process_and_merge()
