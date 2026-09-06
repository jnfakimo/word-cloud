'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { PUBLIC_WEATHER_SERVICE, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/config';
import { createWeatherReader } from '@/lib/weather-api';
// 版面微調集中在 web/lib/weather-map-tuning.ts，那支檔案不含邏輯，可直接改數字。
import { COAST_MARGIN, MARKER_MIN_GAP, COUNTY_MARGIN_OFFSET, COUNTY_MARKER_POSITIONS } from '@/lib/weather-map-tuning';

type Row = Record<string, any>;
type MapCountyShape = {
  id: string;
  county: string;
  centerX: number;
  centerY: number;
  path: string;
  title: string;
};


const COUNTIES = ['基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣'];

const MAIN_ISLAND_VIEWBOX = '220 185 450 610';
const MARKER_POSITIONS: Record<string, [number, number]> = {
  '基隆市': [525, 268],
  '臺北市': [478, 256],
  '新北市': [431, 264],
  '桃園市': [384, 281],
  '新竹市': [342, 311],
  '新竹縣': [308, 349],
  '苗栗縣': [278, 400],
  '臺中市': [278, 455],
  '彰化縣': [278, 511],
  '雲林縣': [278, 566],
  '嘉義市': [278, 621],
  '嘉義縣': [295, 672],
  '臺南市': [342, 698],
  '高雄市': [401, 715],
  '屏東縣': [486, 689],
  '臺東縣': [546, 647],
  '花蓮縣': [593, 545],
  '宜蘭縣': [597, 404],
  '南投縣': [452, 468]
};
// 圖示離海岸線的固定間距（外層座標）。距離是以台灣輪廓為基準量出來的，
// 不是相對畫布的比例——沿岸每個圖示與陸地的空隙才會一致。

// 找不到輪廓時（地圖還沒渲染完）的退路：沿用原本的外圍座標插值。
const MARKER_PULL = 0.72;
const MAP_SCALE = 0.65;
const MAP_TX = 180;
const MAP_TY = 140;


/**
 * 從縣市中心沿「離島中心」的方向往外走，直到離開陸地為止，再加上固定邊距。
 * 判定是否還在陸地上用 SVG 的 isPointInFill()，量的是真正的輪廓而不是外框，
 * 所以西部平直海岸與東部山線都能得到一致的空隙。
 */
function coastAnchor(
  paths: SVGGeometryElement[],
  centerLocal: [number, number],
  originLocal: [number, number],
  extraMargin = 0,
): [number, number] {
  const dx = centerLocal[0] - originLocal[0];
  const dy = centerLocal[1] - originLocal[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const onLand = (x: number, y: number) => {
    const point = new DOMPoint(x, y);
    return paths.some(path => { try { return path.isPointInFill(point); } catch { return false; } });
  };
  const STEP = 4;
  const MAX = 400;
  let travelled = 0;
  // 先走出陸地。中心點理論上一定在陸地上，但離島或破碎海岸可能一開始就在外面。
  while (travelled < MAX && onLand(centerLocal[0] + ux * travelled, centerLocal[1] + uy * travelled)) {
    travelled += STEP;
  }
  const margin = (COAST_MARGIN + extraMargin) / MAP_SCALE; // 邊距以外層座標定義，換算回地圖本身的座標系
  return [centerLocal[0] + ux * (travelled + margin), centerLocal[1] + uy * (travelled + margin)];
}

/**
 * 把圖示往各自的縣市中心拉近，再用簡單的鬆弛法把過近的推開。
 * 推開時兩點各退一半，方向沿著連線，所以整體排列仍保持原本的方位關係。
 */
function layoutMarkers(points: Array<{ name: string; x: number; y: number; manual?: boolean }>) {
  for (let round = 0; round < 60; round += 1) {
    let adjusted = false;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        const distance = Math.hypot(dx, dy) || 0.001;
        if (distance >= MARKER_MIN_GAP) continue;
        const ux = dx / distance;
        const uy = dy / distance;
        const gap = MARKER_MIN_GAP - distance;
        if (points[i].manual && points[j].manual) continue;
        if (points[i].manual) {
          points[j].x += ux * gap; points[j].y += uy * gap;
        } else if (points[j].manual) {
          points[i].x -= ux * gap; points[i].y -= uy * gap;
        } else {
          const push = gap / 2;
          points[i].x -= ux * push; points[i].y -= uy * push;
          points[j].x += ux * push; points[j].y += uy * push;
        }
        adjusted = true;
      }
    }
    if (!adjusted) break;
  }
  return new Map(points.map(point => [point.name, point]));
}

const LEFT_TEMP_COUNTIES = new Set(['苗栗縣', '臺中市', '彰化縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣']);

const readWeather = createWeatherReader({ url: `${SUPABASE_URL}/functions/v1/cwa-weather`, anonKey: SUPABASE_ANON_KEY }, PUBLIC_WEATHER_SERVICE);

// Helpers
const localTime = (value: unknown) => {
  if (!value) return '時間未提供';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};
const num = (value: unknown, digits = 0) => (value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—');

function weatherIcon(text: string, code?: string) {
  const value = String(text || '') + ' ' + String(code || '');
  if (/雷|閃電|雷雨/.test(value)) return '⛈️';
  if (/雪|冰雹/.test(value)) return '❄️';
  if (/雨|陣雨|降雨/.test(value)) return /晴/.test(value) ? '🌦️' : '🌧️';
  if (/霧|霾/.test(value)) return '🌫️';
  if (/陰/.test(value)) return '☁️';
  if (/雲/.test(value)) return /晴/.test(value) ? '🌤️' : '🌥️';
  if (/晴/.test(value)) return '☀️';
  return '🌡️';
}

export function WeatherWidget() {
  const [summary, setSummary] = useState<Row | null>(null);
  const [towns, setTowns] = useState<Row[]>([]);
  const [county, setCounty] = useState('臺北市');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [townError, setTownError] = useState('');
  const [townBusy, setTownBusy] = useState(false);
  // SVG is parsed into a narrow, typed set of React attributes. Keeping raw
  // markup out of state avoids an injection sink if the asset is replaced.
  const [mapShapes, setMapShapes] = useState<MapCountyShape[]>([]);
  const [countyCenters, setCountyCenters] = useState<Record<string, [number, number]>>({});
  // 依台灣輪廓量出的自動落點；有手動定位時由 COUNTY_MARKER_POSITIONS 優先取用。
  const [coastSpots, setCoastSpots] = useState<Record<string, [number, number]>>({});
  const mapGroupRef = useRef<SVGGElement>(null);
  const [townsOpen, setTownsOpen] = useState(false);

  const loadMap = useCallback(async () => {
    try {
      const res = await fetch('/Inspection/v2/taiwan-counties.svg');
      if (res.ok) {
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'image/svg+xml');
        
        const SCALE = 0.65;
        const TX = 180;
        const TY = 140;

        if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
          throw new Error('Invalid Taiwan county SVG');
        }

        const centers: Record<string, [number, number]> = {};
        const shapes: MapCountyShape[] = [];
        doc.querySelectorAll('path.county').forEach((el, index) => {
          const c = el.getAttribute('data-county');
          const cx = el.getAttribute('data-cx');
          const cy = el.getAttribute('data-cy');
          const path = el.getAttribute('d');
          const centerX = Number(cx);
          const centerY = Number(cy);
          if (c && path && Number.isFinite(centerX) && Number.isFinite(centerY)) {
            // Normalize "台" to "臺" just in case the SVG uses "台"
            const canonicalName = c.replace('台', '臺');
            centers[canonicalName] = [
              centerX * SCALE + TX,
              centerY * SCALE + TY
            ];
            shapes.push({
              id: 'county-shape-' + index,
              county: canonicalName,
              centerX,
              centerY,
              path,
              title: el.querySelector('title')?.textContent || canonicalName,
            });
          }
        });
        if (!shapes.length) throw new Error('Taiwan county SVG has no county paths');
        setCountyCenters(centers);
        setMapShapes(shapes);
      }
    } catch (err) {
      console.error('Map loading failed', err);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const payload = await readWeather<Row>('summary');
      setSummary(payload);
    } catch (e: any) {
      setError(e.message || '天氣資料載入失敗');
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    void loadMap(); void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 600_000);
    return () => window.clearInterval(timer);
  }, [loadMap, load]);
  
  useEffect(() => {
    let active = true;
    setTowns([]); setTownError(''); setTownBusy(false);
    if (townsOpen && county) {
      setTownBusy(true);
      const loadTowns = async () => {
        try {
          const payload = await readWeather<Row>('town', county);
          if (active) setTowns(payload.towns || []);
        } catch (e) {
          if (active) setTownError(e instanceof Error ? e.message : '鄉鎮預報載入失敗');
        } finally { if (active) setTownBusy(false); }
      };
      void loadTowns();
    }
    return () => { active = false; };
  }, [county, townsOpen]);

  useEffect(() => {
    const group = mapGroupRef.current;
    const names = Object.keys(countyCenters);
    if (!group || !mapShapes.length || !names.length) return;
    const paths = Array.from(group.querySelectorAll('.county')) as SVGGeometryElement[];
    if (!paths.length) return;
    const toLocal = ([x, y]: [number, number]): [number, number] =>
      [(x - MAP_TX) / MAP_SCALE, (y - MAP_TY) / MAP_SCALE];
    const locals = names.map(name => toLocal(countyCenters[name]));
    // 以所有縣市中心的平均當島中心，決定每個圖示要往哪個方向離開陸地。
    const origin: [number, number] = [
      locals.reduce((sum, point) => sum + point[0], 0) / locals.length,
      locals.reduce((sum, point) => sum + point[1], 0) / locals.length,
    ];
    const spots: Record<string, [number, number]> = {};
    names.forEach((name, index) => {
      const [lx, ly] = coastAnchor(paths, locals[index], origin, COUNTY_MARGIN_OFFSET[name] || 0);
      spots[name] = [lx * MAP_SCALE + MAP_TX, ly * MAP_SCALE + MAP_TY];
    });
    setCoastSpots(spots);
  }, [mapShapes, countyCenters]);

  if (busy && !summary) return <p className="empty">正在取得中央氣象署資料…</p>;
  if (error && !summary) return <div role="status"><p className="empty">{error}</p><button className="secondary-btn" onClick={() => void load()} disabled={busy}>重新取得氣象</button></div>;

  const current: Row = (summary?.counties || []).find((row: Row) => row.county.replace('台', '臺') === county) || {};
  const stem = county.replace(/[市縣]$/, '');
  const countyAlerts: Row[] = (summary?.alerts || []).filter((alert: Row) =>
    (alert.areas || []).some((area: unknown) => String(area).includes(stem)));

  return (
    <div className="weather-widget" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {/* 地圖區域 */}
      <div className="weather-map-container" style={{ flex: '1 1 400px', position: 'relative', minHeight: '650px', background: 'var(--panel2)', borderRadius: '12px', overflow: 'hidden' }}>
        <svg viewBox={MAIN_ISLAND_VIEWBOX} style={{ width: '100%', height: '100%', display: 'block' }}>
          
          {/* 注入台灣地圖路徑，設定樣式 */}
          <style>{`
            .weather-map-container svg .county {
              fill: var(--line);
              stroke: var(--dim);
              stroke-width: 1px;
              transition: fill 0.2s;
            }
            .weather-map-container svg .county.selected {
              fill: rgba(34, 211, 238, 0.4);
              stroke: var(--cyan);
              stroke-width: 2px;
            }
            .weather-map-container svg .county:hover {
              fill: rgba(34, 211, 238, 0.2);
            }
          `}</style>
          {/* 地圖路徑由 React 安全地建立，並用 data-county 屬性選擇器點亮選取的縣市。
              縣市名同時比對「臺」與「台」兩種寫法，SVG 用哪一種都吃得到。
              county 只可能是 COUNTIES 裡的固定值，這裡再擋一次，避免任何外部字串
              被插進樣式表。 */}
          {COUNTIES.includes(county) && <style>{`
            .weather-map-container svg .county[data-county="${county}"],
            .weather-map-container svg .county[data-county="${county.replace('臺', '台')}"] {
              fill: color-mix(in srgb, var(--cyan) 42%, transparent);
              stroke: var(--cyan);
              stroke-width: 2px;
            }
          `}</style>}
          
          <g ref={mapGroupRef} transform="translate(180, 140) scale(0.65)" fillRule="evenodd">
            {mapShapes.map(shape => (
              <path
                key={shape.id}
                className="county"
                data-county={shape.county}
                data-cx={shape.centerX}
                data-cy={shape.centerY}
                d={shape.path}
              >
                <title>{shape.title}</title>
              </path>
            ))}
          </g>

          <g className="weather-marker-layer">
            {(() => {
            const placed = layoutMarkers(COUNTIES.flatMap(name => {
              const center = countyCenters[name];
              const outer = COUNTY_MARKER_POSITIONS[name] || MARKER_POSITIONS[name];
              if (!center || !outer) return [];
              const manual = COUNTY_MARKER_POSITIONS[name];
              const anchored = manual || coastSpots[name];
              return [anchored
                ? { name, x: anchored[0], y: anchored[1], manual: Boolean(manual) }
                : {
                  name,
                  x: center[0] + (outer[0] - center[0]) * MARKER_PULL,
                  y: center[1] + (outer[1] - center[1]) * MARKER_PULL,
                }];
            }));
            return COUNTIES.map(name => {
              const data = (summary?.counties || []).find((r: Row) => r.county.replace('台', '臺') === name) || {};
              const pos = COUNTY_MARKER_POSITIONS[name] || MARKER_POSITIONS[name];
              const cx = countyCenters[name];
              if (!pos || !cx) return null;
              
              const isLeft = LEFT_TEMP_COUNTIES.has(name);
              const isSelected = name === county;
              // 位置已於 layoutMarkers 統一算好：先往縣市中心拉近，再把過近的推開。
              const spot = placed.get(name);
              if (!spot) return null;
              const mx = spot.x;
              const my = spot.y;
              
              return (
                <g key={name} onClick={() => setCounty(name)} style={{ cursor: 'pointer', outline: 'none' }} tabIndex={0}>
                  {/* 圖示與氣溫卡 */}
                  <g transform={`translate(${mx} ${my})`}>
                    <circle r={isSelected ? "20" : "17"} fill={isSelected ? "var(--cyan)" : "var(--panel)"} stroke="var(--cyan)" strokeWidth={isSelected ? "0" : "1.5"} opacity={isSelected ? "1" : "0.9"} />
                    <text y="-1" textAnchor="middle" dominantBaseline="central" fontSize={isSelected ? "18px" : "16px"}>
                      {weatherIcon(data.weather, data.weatherCode)}
                    </text>
                    <text 
                      y={isLeft ? "1" : "26"} 
                      x={isLeft ? "-26" : "0"} 
                      textAnchor={isLeft ? "end" : "middle"} 
                      dominantBaseline="central" 
                      fontSize="13px" 
                      fontWeight="400" 
                      fill="var(--text-hi)" 
                      style={{ textShadow: '0 1px 2px rgba(255,255,255,0.9)', letterSpacing: '0.02em' }}
                    >
                      {data.temperature ? Math.round(Number(data.temperature)) + '°' : ''}
                    </text>
                  </g>
                </g>
              );
            });
            })()}
          </g>
        </svg>
        <div style={{ 
          position: 'absolute', 
          bottom: '24px', 
          right: '24px', 
          background: 'color-mix(in srgb, var(--panel) 90%, transparent)',
          backdropFilter: 'blur(4px)',
          border: '1px solid var(--line)',
          padding: '8px 16px', 
          borderRadius: '20px', 
          color: 'var(--text)', 
          fontSize: '13px',
          fontWeight: '500',
          boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          pointerEvents: 'none'
        }}>
          <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: 'var(--cyan)' }}></span>
          點擊地圖或周圍圖示可切換縣市
        </div>
      </div>

      {/* 資訊區域 */}
      <div className="weather-info-container" style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && <p className="inline-message" role="status">更新失敗，目前保留上次資料：{error}</p>}
        {summary?.sourceWarnings?.length > 0 && <p className="inline-message" role="status">部分氣象資料暫缺，請以中央氣象署最新公告為準。</p>}
        
        {/* 全區警報 */}
        <div className="weather-bulletins">
          {(summary?.bulletins || []).map((item: Row) => (
            <span key={String(item.key)} className={`weather-bulletin ${item.status}`} style={{ display: 'block', marginBottom: '8px', padding: '8px', background: 'var(--panel2)', borderRadius: '4px', borderLeft: '3px solid var(--amber)' }}>
              <b style={{ color: 'var(--text-hi)' }}>{String(item.label)}</b> {String(item.title)}
              {item.status !== 'clear' && item.issuedAt ? <small style={{ marginLeft: '8px', color: 'var(--dim)' }}>{localTime(item.issuedAt)}</small> : null}
            </span>
          ))}
        </div>

        <div className="weather-controls" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={county} onChange={e => setCounty(e.target.value)} style={{ padding: '8px 12px', borderRadius: '6px', background: 'var(--panel2)', color: 'var(--text-hi)', border: '1px solid var(--border)' }}>
            {COUNTIES.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <button onClick={() => void load()} disabled={busy} className="secondary-btn" style={{ padding: '8px 16px', borderRadius: '6px', background: 'var(--panel2)', color: 'var(--text-hi)', border: '1px solid var(--border)', cursor: 'pointer' }}>
            {busy ? '更新中…' : '重新取得'}
          </button>
          <button onClick={() => setTownsOpen(!townsOpen)} className="secondary-btn" style={{ padding: '8px 16px', borderRadius: '6px', background: 'rgba(34, 211, 238, 0.1)', color: 'var(--cyan)', border: '1px solid var(--cyan)', cursor: 'pointer' }}>
            {townsOpen ? '隱藏鄉鎮預報' : '顯示鄉鎮預報'}
          </button>
        </div>
        
        <div style={{ fontSize: '13px', color: 'var(--dim)' }}>
          {summary?.updatedAt ? `更新時間：${localTime(summary.updatedAt)}` : ''} {summary?.stale ? '【快取資料】' : ''}
          {summary?.usingFallback && <span> · 使用備援氣象服務</span>}
        </div>

        {/* 主要天氣卡片 */}
        <div style={{ background: 'var(--panel2)', borderRadius: '12px', padding: '24px', border: '1px solid var(--border)' }}>
          <h3 style={{ margin: '0 0 20px 0', color: 'var(--cyan)', fontSize: '28px', borderBottom: '1px solid var(--border-hi)', paddingBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span>{county}</span>
            <span style={{ color: 'var(--text-hi)', fontSize: '22px' }}>{current.weather || '—'}</span>
            <span style={{ fontSize: '32px', marginLeft: 'auto' }}>{weatherIcon(current.weather, current.weatherCode)}</span>
          </h3>
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', margin: 0 }}>
            <div>
              <dt style={{ color: 'var(--dim)', fontSize: '14px', marginBottom: '8px' }}>目前溫度</dt>
              <dd style={{ margin: 0, fontSize: '32px', fontWeight: 'bold', color: 'var(--cyan)' }}>{num(current.temperature, 1)}<small style={{ fontSize: '20px' }}>°C</small></dd>
            </div>
            <div>
              <dt style={{ color: 'var(--dim)', fontSize: '14px', marginBottom: '8px' }}>今日高／低</dt>
              <dd style={{ margin: 0, fontSize: '22px', color: 'var(--text-hi)' }}>{num(current.maxTemperature)} / {num(current.minTemperature)}°C</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--dim)', fontSize: '14px', marginBottom: '8px' }}>相對濕度</dt>
              <dd style={{ margin: 0, fontSize: '22px', color: 'var(--text-hi)' }}>{num(current.humidity)}%</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--dim)', fontSize: '14px', marginBottom: '8px' }}>降雨機率</dt>
              <dd style={{ margin: 0, fontSize: '22px', color: 'var(--text-hi)' }}>{num(current.rainProbability)}%</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--dim)', fontSize: '14px', marginBottom: '8px' }}>風速</dt>
              <dd style={{ margin: 0, fontSize: '22px', color: 'var(--text-hi)' }}>{num(current.windSpeed, 1)} m/s</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--dim)', fontSize: '14px', marginBottom: '8px' }}>降雨量</dt>
              <dd style={{ margin: 0, fontSize: '22px', color: 'var(--text-hi)' }}>{num(current.rainfall, 1)} mm</dd>
            </div>
          </dl>
        </div>

        {/* 該縣市警報 */}
        {countyAlerts.length > 0 && (
          <div className="weather-alerts" style={{ background: 'rgba(255,59,59,0.1)', borderLeft: '4px solid var(--red)', padding: '16px', borderRadius: '4px' }}>
            {countyAlerts.map((alert: Row, index: number) => (
              <p key={index} style={{ margin: index === 0 ? '0 0 8px 0' : '8px 0', color: 'var(--red)' }}>
                <b>{String(alert.title || '氣象警特報')}</b><br/>
                <small style={{ color: 'var(--text-hi)' }}>{alert.content ? String(alert.content) : '請注意安全'}</small>
              </p>
            ))}
          </div>
        )}

        {/* 鄉鎮市區列表 */}
        {townsOpen && (
          <div className="responsive-table" style={{ maxHeight: '500px', overflowY: 'auto', background: 'var(--panel2)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            {townBusy && <p role="status">正在取得鄉鎮預報…</p>}
            {townError && <p role="status">{townError}</p>}
            {!townBusy && !townError && !towns.length && <p>目前無鄉鎮預報資料。</p>}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '15px' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--panel)', zIndex: 10 }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: '12px', color: 'var(--dim)', borderBottom: '1px solid var(--border-hi)' }}>鄉鎮</th>
                  <th style={{ textAlign: 'left', padding: '12px', color: 'var(--dim)', borderBottom: '1px solid var(--border-hi)' }}>天氣</th>
                  <th style={{ padding: '12px', textAlign: 'center', color: 'var(--dim)', borderBottom: '1px solid var(--border-hi)' }}>溫度</th>
                  <th style={{ padding: '12px', textAlign: 'center', color: 'var(--dim)', borderBottom: '1px solid var(--border-hi)' }}>降雨</th>
                  <th style={{ padding: '12px', textAlign: 'center', color: 'var(--dim)', borderBottom: '1px solid var(--border-hi)' }}>濕度</th>
                </tr>
              </thead>
              <tbody>
                {towns.map((town, i) => (
                  <tr key={String(town.town)} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                    <td style={{ padding: '12px', color: 'var(--text-hi)' }}><strong>{String(town.town)}</strong></td>
                    <td style={{ padding: '12px', color: 'var(--text-hi)' }}>{weatherIcon(town.weather, town.weatherCode)} {town.weather || '—'}</td>
                    <td style={{ padding: '12px', textAlign: 'center', color: 'var(--text-hi)' }}>{num(town.temperature)}°C</td>
                    <td style={{ padding: '12px', textAlign: 'center', color: 'var(--text-hi)' }}>{num(town.rainProbability)}%</td>
                    <td style={{ padding: '12px', textAlign: 'center', color: 'var(--text-hi)' }}>{num(town.humidity)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!towns.length && <p style={{ padding: '24px', textAlign: 'center', color: 'var(--dim)' }}>載入中或無資料…</p>}
          </div>
        )}

      </div>
    </div>
  );
}
