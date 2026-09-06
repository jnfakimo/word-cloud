'use client';

// SYS-06 整合標記系統 = V1 `b1_integrated_marker_system.html` 的移植。
//
// 這是一頁全螢幕的圖形編輯器，刻意不套 AppShell：V1 有自己的 topbar，側邊面板、
// 工具列與 HUD 都是絕對定位貼齊視窗邊緣，塞進 250px 側欄的版面裡會擠壞。
// AGENTS.md 也把這類固定 #topbar 的工具頁（b1plan／floor3d／本頁／guardpatrol3d）
// 標為刻意不掛品牌列。
//
// 與 V1 的差異三處，都是 V2 環境使然：
// 1. 平面圖來源一律走 floor_models 的 image_path（Supabase Storage 私有桶短效網址）。V1 另有
//    plans/*.dzi 的靜態備援，但那是相對於 /Inspection/system 的路徑，在 /Inspection/v2
//    底下會 404；而且 modeler 上傳的每一層都會寫 floor_models，備援實際上用不到。
// 2. OpenSeadragon 以動態 import 載入，不進其他頁面的初始 bundle。
// 3. 巡邏點三色狀態改用 web/lib/patrol-status.ts（V1 的 patrolstatus.js 移植）。
//
// 保留 V1 的核心作法：四個樓層一次全部載入同一個 OSD world，切樓層只改透明度，
// 因此縮放與視角在切層時不會重置，也不必重新下載圖磚。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './structuremap-markerboard.css';
import './structuremap-pin.css';
import { MARKET_ID } from '@/lib/config';
import { signFloorPlanVariants, type FloorPlanUrls } from '@/lib/floorplan-storage';
import { STRUCTUREMAP_ROUTES } from '@/lib/structuremap-routes';
import { canonicalFloor, floorOrder } from '@/lib/floor';
import { errorMessage } from '@/components/admin/shared';
import {
  computePatrolStatus, invalidatePatrolMarkers, PATROL_COLORS, type PatrolState,
} from '@/lib/patrol-status';
import { getSupabase, invokeAppApi } from '@/lib/supabase';
import type { Profile } from '@/types/app';
import { preparePlanObjectUrl } from './floor-stack-3d';
import { StructuremapTopbarActions } from './structuremap-topbar-actions';

type Props = { profile: Profile };
type MarkerKind = 'equipment' | 'space' | 'patrol' | 'repair' | 'note';
type Marker = {
  marker_id: string; floor_id: string; x: number; y: number;
  kind: MarkerKind; label: string; note: string | null; color: string | null;
  equipment_id: string | null; space_id: string | null; repair_id: string | null;
};
type Equipment = { equipment_id: string; name: string; location: string | null };
type Space = { space_id: string; floor: string; space_name: string };
type Repair = { request_id: string; req_no: string | null; fault_type: string | null; fault_desc: string | null; status: string };
// lightUrl／techUrl 是 3D建模系統上傳時就重畫好的成品圖，有值就直接開。
type FloorSource = { id: string; label: string; url: string; lightUrl: string; techUrl: string; index: number | null };
type PendingLink = { kind: MarkerKind; id: string; label: string };

const KIND: Record<MarkerKind, { c: string; n: string }> = {
  equipment: { c: '#00d4ff', n: '設備' },
  space: { c: '#00ff9d', n: '空間' },
  patrol: { c: '#c77dff', n: '巡邏點' },
  repair: { c: '#ff5470', n: '報修點' },
  note: { c: '#ffb300', n: '一般' },
};
const KIND_ORDER: MarkerKind[] = ['equipment', 'space', 'patrol', 'repair', 'note'];

const LIST_SOURCES = [
  ['markers', '本層標記'], ['equipment', '設備清單'],
  ['space', '空間清單（區域位置）'], ['patrol', '巡邏點標示'], ['repair', '報修案件'],
] as const;
type ListSource = (typeof LIST_SOURCES)[number][0];

const STAT_LABEL: Record<string, string> = {
  pending: '待處理', dispatched: '已派工', processing: '處理中',
  accepted: '已受理', repairing: '維修中',
};
const CLOSED_REPAIR = ['done', 'closed', 'completed', '已完成', '已結案'];

function translateError(error: unknown) {
  const message = error instanceof Error ? error.message
    : (typeof error === 'object' && error !== null && 'message' in error)
      ? String((error as Record<string, unknown>).message) : String(error || '');
  if (!message) return '未知錯誤';
  if (message.includes('duplicate key value')) return '資料重複，請確認是否已存在';
  if (message.includes('null value in column')) return '必填欄位不可空白';
  if (/violates row-level security|permission denied/.test(message)) return '無操作權限';
  if (message.includes('JWT expired')) return '登入已過期，請重新整理頁面';
  if (message.includes('relation') && message.includes('does not exist')) return '資料表不存在，請確認資料庫設定';
  if (/Failed to fetch|NetworkError|Load failed/.test(message)) return '網路連線失敗，請稍後再試';
  return '操作失敗，請稍後再試或聯絡系統管理員';
}

export function MarkerBoardModule({ profile }: Props) {
  const [floors, setFloors] = useState<FloorSource[]>([]);
  const [curFloor, setCurFloor] = useState('');
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [repairs, setRepairs] = useState<Repair[]>([]);
  const [patrolStatus, setPatrolStatus] = useState<Map<string, PatrolState>>(new Map());

  const [progress, setProgress] = useState<{ pct: number; msg: string } | null>({ pct: 8, msg: '初始化…' });
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPinned, setPanelPinned] = useState(false);
  const [listSource, setListSource] = useState<ListSource>('markers');
  const [query, setQuery] = useState('');
  const [placeStatus, setPlaceStatus] = useState('');
  const [placeMode, setPlaceMode] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [zoomPct, setZoomPct] = useState(100);
  const [viewerGeneration, setViewerGeneration] = useState(0);
  const [theme, setTheme] = useState<'light' | 'tech'>(() =>
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'tech'
      ? 'tech' : 'light');

  const [editor, setEditor] = useState<{
    id: string | null; x: number; y: number; floorId: string; kind: MarkerKind;
    equipmentId: string; spaceId: string; repairId: string;
    label: string; note: string; message: string;
  } | null>(null);
  const [detail, setDetail] = useState<{ marker: Marker; left: number; top: number } | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const navigatorHostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const overlaysRef = useRef<Map<string, HTMLElement>>(new Map());
  const placeModeRef = useRef(placeMode);
  const pendingLinkRef = useRef<PendingLink | null>(null);
  const detailIdRef = useRef<string | null>(null);
  const deepLinkRef = useRef<string | null>(null);
  const curFloorRef = useRef(curFloor);

  useEffect(() => { placeModeRef.current = placeMode; }, [placeMode]);
  useEffect(() => { detailIdRef.current = detail?.marker.marker_id ?? null; }, [detail]);
  useEffect(() => { curFloorRef.current = curFloor; }, [curFloor]);
  useEffect(() => {
    const syncTheme = () => setTheme(
      document.documentElement.getAttribute('data-theme') === 'tech' ? 'tech' : 'light');
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  /* ──────────────── 資料 ──────────────── */

  const loadData = useCallback(async () => {
    const client = getSupabase();
    const [markerResult, equipmentResult, spaceResult, repairResult] = await Promise.all([
      client.from('plan_markers').select('*').eq('status', 'active'),
      client.from('equipment').select('equipment_id,name,location').limit(1000),
      client.from('floor_spaces').select('space_id,floor,space_name')
        .eq('market_id', MARKET_ID).eq('status', 'active').limit(1000),
      client.from('repair_requests').select('request_id,req_no,fault_type,fault_desc,status')
        .order('created_at', { ascending: false }).limit(500),
    ]);
    const failure = markerResult.error || equipmentResult.error || spaceResult.error || repairResult.error;
    if (failure) {
      console.warn('loadData partial failure', {
        markers: markerResult.error, equipment: equipmentResult.error,
        spaces: spaceResult.error, repairs: repairResult.error,
      });
      window.alert('部分資料載入失敗，畫面可能不完整，請重新整理頁面。');
    }
    setMarkers((markerResult.data || []).map(row => ({
      ...(row as Marker), floor_id: canonicalFloor(row.floor_id),
    })));
    setEquipment((equipmentResult.data || []) as Equipment[]);
    setSpaces((spaceResult.data || []).map(row => ({
      ...(row as Space), floor: canonicalFloor(row.floor),
    })));
    setRepairs(((repairResult.data || []) as Repair[]).filter(row => !CLOSED_REPAIR.includes(row.status)));
    // patrol_shifts 尚未建表時靜默略過，圖釘維持原色。
    try {
      const result = await computePatrolStatus(client);
      setPatrolStatus(result.map);
    } catch { /* 保持原色 */ }
  }, []);

  // 樓層來源：floor_models。V1 另有靜態 .dzi 備援，V2 用不到（見檔頭說明）。
  useEffect(() => {
    let disposed = false;
    (async () => {
      setProgress({ pct: 12, msg: '讀取樓層模型…' });
      const { data, error } = await getSupabase().from('floor_models').select('*');
      if (disposed) return;
      if (error) console.warn('floor_models query failed', error);
      const sourceRows = (data || [])
        .filter(row => row.image_path)
      // 與平面圖、3D 共用同一支：拿得到 light/、tech/ 成品圖就直接開，省掉逐像素重畫。
      let variants = new Map<string, FloorPlanUrls>();
      try {
        variants = await signFloorPlanVariants(sourceRows.map(row => String(row.image_path)), getSupabase());
      } catch (signError) {
        if (!disposed) setProgress({ pct: 100, msg: `樓層圖連結產生失敗：${errorMessage(signError, '請重新登入後再試')}` });
      }
      const list = sourceRows
        .map(row => {
          const urls = variants.get(String(row.image_path));
          return {
            id: canonicalFloor(row.floor_id), label: String(row.name || canonicalFloor(row.floor_id)),
            url: urls?.raw || '', lightUrl: urls?.light || '', techUrl: urls?.tech || '',
            index: null as number | null,
          };
        })
        .filter(row => row.url || row.lightUrl || row.techUrl)
        .sort((a, b) => floorOrder(a.id) - floorOrder(b.id));
      if (disposed) return;
      setFloors(list);
      if (!list.length) setProgress({ pct: 100, msg: '尚未建立任何樓層模型' });
    })();
    return () => { disposed = true; };
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  /* ──────────────── OpenSeadragon ──────────────── */

  useEffect(() => {
    if (!floors.length || !hostRef.current) return;
    let disposed = false;
    let viewer: any = null;
    const preparedUrls: string[] = [];
    floors.forEach(floor => { floor.index = null; });
    (async () => {
      // 3D建模系統輸出的 PNG 將青色線條烘在檔案內。整合標記系統必須與平面模型圖、
      // 3D模型圖共用同一份預處理：一般版重畫為黑線，科技版保留青色但濾掉光暈。
      const OpenSeadragon = (await import('openseadragon')).default;
      if (disposed || !hostRef.current || !navigatorHostRef.current) return;
      // OpenSeadragon.destroy() 在圖像仍於背景解碼時可能留下舊 canvas；主題快速切換後，
      // 殘留的透明畫布會蓋住新 viewer。重建前統一清空 host，確保永遠只有一套畫布。
      hostRef.current.replaceChildren();
      // OSD.destroy() 會移除 navigator element；不可把 React 擁有的容器交給它。
      // 每次重建只交出可拋棄的子元素，切換主題後外層 ref 仍然有效。
      const navigatorElement = document.createElement('div');
      navigatorElement.className = 'mb-nav-content';
      navigatorHostRef.current.replaceChildren(navigatorElement);
      const token = (name: string, fallback: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      viewer = OpenSeadragon({
        element: hostRef.current, prefixUrl: '',
        showNavigationControl: false, showNavigator: true, navigatorElement,
        navigatorAutoFade: false,
        navigatorBackground: token('--bg', '#020b18'),
        navigatorBorderColor: token('--line', '#173952'),
        navigatorDisplayRegionColor: token('--cyan', '#00d4ff'),
        minZoomLevel: 0.2, maxZoomPixelRatio: 4, zoomPerScroll: 1.3,
        animationTime: 0.5, springStiffness: 7,
        panHorizontal: true, panVertical: true, constrainDuringPan: false,
        visibilityRatio: 0, crossOriginPolicy: 'Anonymous',
        gestureSettingsMouse: { flickEnabled: true, flickMomentum: 0.4 },
      });
      viewerRef.current = viewer;

      const syncHud = () => {
        if (!viewer.viewport) return;
        setZoomPct(Math.round(viewer.viewport.getZoom(true) / viewer.viewport.getHomeZoom() * 100));
      };
      viewer.addHandler('zoom', syncHud);
      viewer.addHandler('animation', syncHud);
      viewer.addHandler('animation', () => {
        // 平移時讓詳細彈窗跟著圖釘走，與 V1 相同。
        const id = detailIdRef.current;
        if (!id) return;
        const el = overlaysRef.current.get(id);
        if (el) setDetail(prev => (prev ? { ...prev, ...anchorOf(el) } : prev));
      });
      viewer.addHandler('canvas-click', (event: any) => {
        if (event.originalEvent?.target?.closest?.('.mb-pin')) return; // 點圖釘交給圖釘自己
        if (placeModeRef.current) {
          if (!event.quick) return;                                    // 放置模式忽略拖曳
          const point = viewer.viewport.pointFromPixel(event.position);
          const link = pendingLinkRef.current;
          pendingLinkRef.current = null;
          openCreate(point.x, point.y, link);
          return;
        }
        if (event.quick) {
          setDetail(null);
          setPanelPinned(pinned => { if (!pinned) setPanelOpen(false); return pinned; });
        }
      });

      const initialFloor = curFloorRef.current || floors[0].id;
      if (!curFloorRef.current) {
        curFloorRef.current = initialFloor;
        setCurFloor(initialFloor);
      }
      const orderedFloors = [
        floors.find(floor => floor.id === initialFloor) || floors[0],
        ...floors.filter(floor => floor.id !== initialFloor),
      ];
      const addPreparedFloor = async (floor: FloorSource, foreground: boolean) => {
        if (disposed) return;
        if (foreground || floor.id === curFloorRef.current) {
          setProgress({
            pct: foreground ? 18 : 55,
            msg: theme === 'light' ? `轉換${floor.label}為黑線圖…` : `整理${floor.label}科技版線條…`,
          });
        }
        // 成品圖存在就直接用，不必下載原圖再逐像素重畫（也就不必產生／釋放 blob）。
        const prerendered = theme === 'light' ? floor.lightUrl : floor.techUrl;
        const prepared = prerendered ? null : await preparePlanObjectUrl(floor.url, theme);
        if (disposed) {
          if (prepared) URL.revokeObjectURL(prepared);
          return;
        }
        if (prepared) preparedUrls.push(prepared);
        const source = prerendered || prepared || floor.url;
        await new Promise<void>(resolve => viewer.addTiledImage({
          tileSource: { type: 'image', url: source }, x: 0, y: 0, width: 1, opacity: 0,
          success: (event: any) => {
            // 主題切換可能在背景樓層解碼期間發生；舊 viewer 的延遲回呼不可再改寫
            // 新 viewer 共用的樓層索引與載入狀態，否則新圖會被錯誤索引切成透明。
            if (disposed || viewerRef.current !== viewer) { resolve(); return; }
            floor.index = viewer.world.getIndexOfItem(event.item);
            if (floor.id === curFloorRef.current) {
              event.item.setOpacity(1);
              setProgress(null);
              // 主題切換會重建 viewer；即使資料沒變，也要重新掛回圖釘覆蓋層。
              setViewerGeneration(value => value + 1);
            }
            resolve();
          },
          error: () => {
            if (disposed || viewerRef.current !== viewer) { resolve(); return; }
            if (floor.id === curFloorRef.current) {
              setProgress({ pct: 100, msg: `${floor.label}平面圖載入失敗，請重新整理頁面` });
            }
            resolve();
          },
        }));
      };

      // 目前樓層先完成並解除載入遮罩，其餘樓層在背景逐張轉換，避免首次進頁等待七層。
      for (let index = 0; index < orderedFloors.length; index += 1) {
        await addPreparedFloor(orderedFloors[index], index === 0);
      }
    })().catch(error => {
      if (disposed) return;
      console.error('markerboard viewer initialization failed', error);
      setProgress({ pct: 100, msg: `圖臺載入失敗：${errorMessage(error, '請重新整理頁面後再試')}` });
    });
    return () => {
      disposed = true;
      if (viewerRef.current === viewer) viewerRef.current = null;
      try { viewer?.destroy(); } catch { /* viewer 可能仍在非同步建立中 */ }
      overlaysRef.current.clear();
      floors.forEach(floor => { floor.index = null; });
      preparedUrls.forEach(url => URL.revokeObjectURL(url));
    };
    // openCreate 於下方定義且不依賴變動狀態，刻意不列入相依。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floors, theme]);

  // 切樓層：只改透明度，視角與縮放保持不變。
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !curFloor) return;
    let available = false;
    floors.forEach(floor => {
      if (floor.index == null) return;
      const item = viewer.world.getItemAt(floor.index);
      if (item) {
        item.setOpacity(floor.id === curFloor ? 1 : 0);
        if (floor.id === curFloor) available = true;
      }
    });
    if (!available) {
      const floor = floors.find(item => item.id === curFloor);
      setProgress({ pct: 55, msg: `正在準備${floor?.label || curFloor}平面圖…` });
    } else setProgress(null);
    setDetail(null);
  }, [curFloor, floors]);

  const markerColor = useCallback((marker: Marker) => {
    if (marker.kind === 'patrol' && patrolStatus.has(marker.marker_id)) {
      return PATROL_COLORS[patrolStatus.get(marker.marker_id)!];
    }
    return marker.color || KIND[marker.kind]?.c || KIND.note.c;
  }, [patrolStatus]);

  const anchorOf = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    let left = rect.right + 10;
    let top = rect.top - 10;
    if (left + 250 > window.innerWidth) left = rect.left - 260;
    if (top + 160 > window.innerHeight) top = window.innerHeight - 170;
    const minLeft = document.body.classList.contains('mb-panel-open') ? 306 : 14;
    if (left < minLeft) left = minLeft;
    if (top < 56) top = 56;
    return { left, top };
  };

  // 重建圖釘覆蓋層。plan_markers 的 x／y 是 0–1 的相對座標。
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let OpenSeadragonRef: any = null;
    let cancelled = false;
    (async () => {
      OpenSeadragonRef = (await import('openseadragon')).default;
      if (cancelled) return;
      overlaysRef.current.forEach(el => { try { viewer.removeOverlay(el); } catch { /* 忽略 */ } });
      overlaysRef.current.clear();
      markers.filter(marker => marker.floor_id === curFloor).forEach(marker => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `mb-pin${showLabels ? ' show-lab' : ''}${detailIdRef.current === marker.marker_id ? ' on' : ''}`;
        el.dataset.id = marker.marker_id;
        const dot = document.createElement('span');
        dot.className = 'mb-pdot';
        dot.style.background = markerColor(marker);
        const lab = document.createElement('span');
        lab.className = 'mb-plab';
        lab.textContent = marker.label;
        el.append(dot, lab);
        el.addEventListener('click', event => {
          event.stopPropagation();
          setDetail({ marker, ...anchorOf(el) });
        });
        try {
          viewer.addOverlay({
            element: el, location: new OpenSeadragonRef.Point(marker.x, marker.y),
            placement: OpenSeadragonRef.Placement.CENTER, checkResize: false,
          });
          overlaysRef.current.set(marker.marker_id, el);
        } catch { /* viewer 尚未就緒時略過，下一次重建會補上 */ }
      });
    })();
    return () => { cancelled = true; };
  }, [markers, curFloor, showLabels, markerColor, viewerGeneration]);

  // 深連結 ?marker=：資料與圖磚都就緒後才跳。
  useEffect(() => {
    if (deepLinkRef.current === 'done' || !markers.length || !floors.length) return;
    const id = new URLSearchParams(location.search).get('marker');
    if (!id) { deepLinkRef.current = 'done'; return; }
    const target = markers.find(marker => marker.marker_id === id);
    if (!target) { deepLinkRef.current = 'done'; return; }
    deepLinkRef.current = 'done';
    setCurFloor(target.floor_id);
    window.setTimeout(() => focusMarker(target), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, floors]);

  const focusMarker = async (marker: Marker) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (marker.floor_id !== curFloor) setCurFloor(marker.floor_id);
    const OpenSeadragon = (await import('openseadragon')).default;
    viewer.viewport.panTo(new OpenSeadragon.Point(marker.x, marker.y));
    viewer.viewport.zoomTo(Math.max(viewer.viewport.getZoom(), viewer.viewport.getHomeZoom() * 3));
    viewer.viewport.applyConstraints();
    window.setTimeout(() => {
      const el = overlaysRef.current.get(marker.marker_id);
      if (el) setDetail({ marker, ...anchorOf(el) });
    }, 420);
  };

  /* ──────────────── 新增／編輯 ──────────────── */

  function openCreate(x: number, y: number, link: PendingLink | null) {
    setEditor({
      id: null, x, y, floorId: curFloor,
      kind: link?.kind || 'note',
      equipmentId: link?.kind === 'equipment' ? link.id : '',
      spaceId: link?.kind === 'space' ? link.id : '',
      repairId: link?.kind === 'repair' ? link.id : '',
      label: link?.label || '', note: '', message: '',
    });
  }

  const openEdit = (marker: Marker) => setEditor({
    id: marker.marker_id, x: marker.x, y: marker.y, floorId: marker.floor_id,
    kind: marker.kind || 'note',
    equipmentId: marker.equipment_id || '', spaceId: marker.space_id || '', repairId: marker.repair_id || '',
    label: marker.label || '', note: marker.note || '', message: '',
  });

  const saveMarker = async () => {
    if (!editor) return;
    const label = editor.label.trim();
    if (!label) { setEditor({ ...editor, message: '請輸入標記名稱' }); return; }
    const payload = {
      floor_id: editor.floorId, x: editor.x, y: editor.y, kind: editor.kind, label,
      equipment_id: editor.kind === 'equipment' ? (editor.equipmentId || null) : null,
      space_id: editor.kind === 'space' ? (editor.spaceId || null) : null,
      repair_id: editor.kind === 'repair' ? (editor.repairId || null) : null,
      note: editor.note.trim() || null,
    };
    try {
      await invokeAppApi('marker_save', editor.id
        ? { kind: 'save', marker_id: editor.id, payload }
        : { kind: 'save', payload });
    } catch (error) { setEditor({ ...editor, message: `儲存失敗：${translateError(error)}` }); return; }
    invalidatePatrolMarkers();
    setEditor(null);
    await loadData();
  };

  const deleteMarker = async (markerId: string, fromEditor: boolean) => {
    if (!window.confirm('確定停用此標記？歷史資料會永久保留。')) return;
    try {
      await invokeAppApi('marker_save', { kind: 'deactivate', marker_id: markerId });
    } catch (error) {
      const text = `停用失敗：${translateError(error)}`;
      if (fromEditor && editor) setEditor({ ...editor, message: text }); else window.alert(text);
      return;
    }
    invalidatePatrolMarkers();
    setEditor(null);
    setDetail(null);
    await loadData();
  };

  /* ──────────────── 側邊面板清單 ──────────────── */

  const floorMarkers = useMemo(
    () => markers.filter(marker => marker.floor_id === curFloor), [markers, curFloor]);
  const placedEquipment = useMemo(
    () => new Set(markers.map(marker => marker.equipment_id).filter(Boolean) as string[]), [markers]);
  const placedSpaces = useMemo(
    () => new Set(markers.map(marker => marker.space_id).filter(Boolean) as string[]), [markers]);
  const placedRepairs = useMemo(
    () => new Set(markers.map(marker => marker.repair_id).filter(Boolean) as string[]), [markers]);

  const matches = (text: unknown) => {
    const q = query.trim().toLowerCase();
    return !q || String(text || '').toLowerCase().includes(q);
  };
  const keepByPlaced = (placed: boolean) =>
    !placeStatus || (placeStatus === 'placed' ? placed : !placed);

  const startPlaceLinked = (link: PendingLink) => {
    pendingLinkRef.current = link;
    setPlaceMode(true);
    if (!panelPinned) setPanelOpen(false);
  };

  const panelRows = useMemo(() => {
    if (listSource === 'markers' || listSource === 'patrol') {
      const base = listSource === 'patrol' ? floorMarkers.filter(m => m.kind === 'patrol') : floorMarkers;
      const list = placeStatus === 'unplaced' ? [] : base.filter(m => matches(m.label) || matches(m.note));
      return { total: base.length, items: list.map(marker => ({
        key: marker.marker_id, color: markerColor(marker), name: marker.label,
        tag: KIND[marker.kind]?.n || '', onClick: () => void focusMarker(marker),
      })) };
    }
    if (listSource === 'equipment') {
      const base = equipment.filter(item => matches(item.name) || matches(item.location));
      const list = base.filter(item => keepByPlaced(placedEquipment.has(item.equipment_id)));
      return { total: equipment.length, items: list.map(item => ({
        key: item.equipment_id, color: KIND.equipment.c, name: item.name,
        tag: placedEquipment.has(item.equipment_id) ? '已設置' : '未設置',
        onClick: () => startPlaceLinked({ kind: 'equipment', id: item.equipment_id, label: item.name }),
      })) };
    }
    if (listSource === 'space') {
      const current = canonicalFloor(curFloor);
      const base = spaces
        .filter(item => matches(item.space_name) || matches(item.floor))
        .sort((a, b) => (canonicalFloor(a.floor) === current ? 0 : 1) - (canonicalFloor(b.floor) === current ? 0 : 1)
          || floorOrder(a.floor) - floorOrder(b.floor)
          || a.space_name.localeCompare(b.space_name, 'zh-Hant'));
      const list = base.filter(item => keepByPlaced(placedSpaces.has(item.space_id)));
      return { total: spaces.length, items: list.map(item => ({
        key: item.space_id, color: KIND.space.c, name: `${item.floor} · ${item.space_name}`,
        tag: placedSpaces.has(item.space_id) ? '已設置' : '未設置',
        onClick: () => startPlaceLinked({ kind: 'space', id: item.space_id, label: item.space_name }),
      })) };
    }
    const base = repairs.filter(item => matches(item.req_no) || matches(item.fault_type) || matches(item.fault_desc));
    const list = base.filter(item => keepByPlaced(placedRepairs.has(item.request_id)));
    return { total: repairs.length, items: list.map(item => ({
      key: item.request_id, color: KIND.repair.c,
      name: `${item.req_no ? `${item.req_no} ` : ''}${item.fault_type ? `[${item.fault_type}] ` : ''}${String(item.fault_desc || '').replace(/\n/g, ' ').slice(0, 24)}`,
      tag: STAT_LABEL[item.status] || item.status || '其他',
      onClick: () => startPlaceLinked({
        kind: 'repair', id: item.request_id, label: `${item.req_no || ''} ${item.fault_type || ''}`.trim(),
      }),
    })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSource, floorMarkers, equipment, spaces, repairs, query, placeStatus,
    placedEquipment, placedSpaces, placedRepairs, curFloor, markerColor]);

  /* ──────────────── 工具與快捷鍵 ──────────────── */

  const zoomBy = (factor: number) => {
    const viewer = viewerRef.current;
    if (!viewer?.viewport) return;
    viewer.viewport.zoomBy(factor);
    viewer.viewport.applyConstraints();
  };
  const setRot = useCallback((degrees: number) => {
    const viewer = viewerRef.current;
    setRotation(degrees);
    if (viewer?.viewport) viewer.viewport.setRotation(((degrees % 360) + 360) % 360);
  }, []);
  const goHome = () => {
    viewerRef.current?.viewport?.goHome();
    setRot(0);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === '+' || event.key === '=') zoomBy(1.4);
      else if (event.key === '-') zoomBy(0.71);
      else if (event.key === '[') setRot(rotation - 15);
      else if (event.key === ']') setRot(rotation + 15);
      else if (event.key === '0') goHome();
      else if (/^[1-9]$/.test(event.key)) {
        const target = floors.find(floor => floor.id === `${event.key}F`);
        if (target) setCurFloor(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, floors, setRot]);

  // 面板開闔狀態掛在 body，讓詳細彈窗的最小左邊界能沿用 V1 的判斷。
  useEffect(() => {
    document.body.classList.toggle('mb-panel-open', panelOpen);
    return () => document.body.classList.remove('mb-panel-open');
  }, [panelOpen]);

  const currentLabel = floors.find(floor => floor.id === curFloor)?.label || curFloor || '—';
  const canWrite = profile.allowed_systems.includes('*') || profile.allowed_systems.includes('structuremap');

  return <div className={`mb-root${panelOpen ? ' panel-open' : ''}${panelPinned ? ' panel-pinned' : ''}`}>
    {progress && <div className="mb-loading">
      <div className="ld-t">載入整合標記系統…</div>
      <div className="ld-bar"><div className="ld-fill" style={{ width: `${progress.pct}%` }} /></div>
      <div className="ld-m">{progress.msg}</div>
    </div>}

    <div className="mb-topbar">
      <span className="tb-logo">臺北農產公司 第一果菜市場</span>
      <span className="tb-sep" />
      <span className="tb-title">整合標記系統</span>
      <span className="tb-space" />
      <StructuremapTopbarActions planeHref={STRUCTUREMAP_ROUTES.floor3d} label="切換3D圖" />
      <button className="mb-panel-toggle" onClick={() => setPanelOpen(open => !open)}>☰ 標記選單</button>
    </div>

    <aside className="mb-panel" aria-label="標記選單">
      <div className="pn-head">
        <div>
          <div className="pn-title">整合標記</div>
          <div className="pn-sub">{currentLabel}</div>
        </div>
        <button className={`mb-btn${panelPinned ? ' on' : ''}`}
          onClick={() => { setPanelPinned(p => { if (!p) setPanelOpen(true); return !p; }); }}>
          {panelPinned ? '📌 已釘住' : '📌 釘住'}
        </button>
        <button className="mb-btn" onClick={() => { setPanelOpen(false); setPanelPinned(false); }}>✕ 隱藏</button>
      </div>

      <div className="pn-tools">
        <button className={`mb-btn place${placeMode ? ' on' : ''}`} disabled={!canWrite}
          onClick={() => {
            setPlaceMode(mode => {
              if (mode) pendingLinkRef.current = null;
              return !mode;
            });
          }}>
          {placeMode ? '✓ 放置中（點圖新增 / 再按退出）' : '＋ 放置標記模式'}
        </button>
        {!canWrite && <p className="pn-empty">目前角色沒有設備圖臺的寫入權限，僅能檢視。</p>}

        <select value={listSource} onChange={event => setListSource(event.target.value as ListSource)}
          aria-label="清單來源">
          {LIST_SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={placeStatus} onChange={event => setPlaceStatus(event.target.value)}
          aria-label="設置狀態篩選">
          <option value="">全部設置狀態</option>
          <option value="placed">已設置</option>
          <option value="unplaced">未設置</option>
        </select>
        <input value={query} onChange={event => setQuery(event.target.value)}
          placeholder="搜尋名稱或備註…" aria-label="搜尋" />
      </div>

      <div className="pn-list">
        {panelRows.items.length ? panelRows.items.map(row => (
          <button className="mk-item" key={row.key} onClick={row.onClick}>
            <span className="cdot" style={{ background: row.color }} />
            <span className="mk-name">{row.name}</span>
            <span className="mk-kind">{row.tag}</span>
          </button>
        )) : <div className="pn-empty">
          此樓層尚無標記。<br />可從「設備清單／空間清單」點選項目放置，或按「放置標記模式」自訂新增。
        </div>}
      </div>

      <div className="pn-count">
        {listSource === 'markers' || listSource === 'patrol' ? '本層標記' : '項目'}：{panelRows.total} 個
        {panelRows.items.length !== panelRows.total && `（篩選後 ${panelRows.items.length}）`}
      </div>
      <div className="pn-legend">
        {KIND_ORDER.map(kind => <span key={kind}>
          <i style={{ background: KIND[kind].c }} />{KIND[kind].n}
        </span>)}
      </div>
    </aside>

    <div className="mb-osd" ref={hostRef} />
    <div className="mb-nav" ref={navigatorHostRef} />

    {placeMode && <div className="mb-placehint">
      {pendingLinkRef.current ? '點選平面圖放置此項目' : '點選平面圖任一位置放置標記　·　再按一次退出放置模式'}
    </div>}

    <div className="mb-floors">
      <select value={curFloor} onChange={event => setCurFloor(event.target.value)} aria-label="選擇樓層">
        {floors.map(floor => <option key={floor.id} value={floor.id}>{floor.label}</option>)}
      </select>
    </div>

    <div className="mb-tools">
      <button className="tbtn" onClick={() => zoomBy(1.4)} title="放大">＋</button>
      <button className="tbtn" onClick={() => zoomBy(0.71)} title="縮小">－</button>
      <button className="tbtn" onClick={() => setRot(rotation - 15)} title="逆時針旋轉">↺</button>
      <button className="tbtn" onClick={() => setRot(rotation + 15)} title="順時針旋轉">↻</button>
      <button className={`tbtn${showLabels ? ' on' : ''}`} onClick={() => setShowLabels(v => !v)} title="顯示標籤">🏷</button>
      <button className="tbtn" onClick={goHome} title="回到全圖">⊡</button>
      <button className="tbtn" onClick={() => viewerRef.current?.setFullScreen(!viewerRef.current?.isFullPage())} title="全螢幕">⛶</button>
    </div>

    {/* 提示與 HUD 併成一列：HUD 寬度會隨縮放百分比變動，各自絕對定位會互相疊到。 */}
    <div className="mb-bottomright">
      <div className="mb-mousehint">🖱 滾輪：縮放　拖曳：平移　雙擊：放大</div>
      <div className="mb-hud">
        <span className="h-t">{currentLabel}</span>
        <span>{zoomPct}%</span>
        <span>{((rotation % 360) + 360) % 360}°</span>
      </div>
    </div>

    {detail && <div className="mb-detail" style={{ left: detail.left, top: detail.top }}>
      <div className="dt-head">
        <span className="cdot" style={{ background: markerColor(detail.marker) }} />
        <span className="dt-name">{detail.marker.label}</span>
        <button className="x" onClick={() => setDetail(null)} aria-label="關閉">✕</button>
      </div>
      <div className="dt-body">
        <div className="r">類型：<b>{KIND[detail.marker.kind]?.n || detail.marker.kind}</b></div>
        <div className="r">樓層：<b>{detail.marker.floor_id}</b></div>
        {detail.marker.equipment_id && (() => {
          const item = equipment.find(row => row.equipment_id === detail.marker.equipment_id);
          return item ? <div className="r">設備：<b>{item.name}</b></div> : null;
        })()}
        {detail.marker.space_id && (() => {
          const item = spaces.find(row => row.space_id === detail.marker.space_id);
          return item ? <div className="r">空間：<b>{item.floor} · {item.space_name}</b></div> : null;
        })()}
        {detail.marker.repair_id && (() => {
          const item = repairs.find(row => row.request_id === detail.marker.repair_id);
          return item ? <div className="r">報修：<b>{`${item.req_no || ''} ${item.fault_type || ''}`.trim()}</b></div> : null;
        })()}
        {detail.marker.note && <div className="r">備註：<b>{detail.marker.note}</b></div>}
      </div>
      {canWrite && <div className="dt-acts">
        <button className="mb-btn" onClick={() => { const marker = detail.marker; setDetail(null); openEdit(marker); }}>編輯</button>
        <button className="mb-btn danger" onClick={() => void deleteMarker(detail.marker.marker_id, false)}>停用</button>
      </div>}
    </div>}

    {editor && <div className="mb-modal-bg" role="dialog" aria-modal="true"
      onMouseDown={event => { if (event.target === event.currentTarget) setEditor(null); }}>
      <div className="mb-modal">
        <div className="md-head">
          <span className="mt">{editor.id ? `編輯標記（${editor.floorId}）` : `新增標記（${editor.floorId}）`}</span>
          <button className="x" onClick={() => setEditor(null)} aria-label="關閉">✕</button>
        </div>
        <div className="md-body">
          <div className="fld">
            <label>標記類型</label>
            <div className="kind-row">
              {KIND_ORDER.map(kind => <button key={kind}
                className={`kbtn${editor.kind === kind ? ' on' : ''}`}
                style={editor.kind === kind ? { background: KIND[kind].c, borderColor: KIND[kind].c } : undefined}
                onClick={() => setEditor({ ...editor, kind })}>{KIND[kind].n}</button>)}
            </div>
          </div>

          {editor.kind === 'equipment' && <div className="fld">
            <label htmlFor="mb-eqp">連結設備</label>
            <select id="mb-eqp" value={editor.equipmentId} onChange={event => {
              const id = event.target.value;
              const item = equipment.find(row => row.equipment_id === id);
              setEditor({ ...editor, equipmentId: id, label: editor.label.trim() || item?.name || '' });
            }}>
              <option value="">— 不連結 —</option>
              {groupBy(equipment, item => item.location || '未分類').map(([group, items]) =>
                <optgroup key={group} label={group}>
                  {items.map(item => <option key={item.equipment_id} value={item.equipment_id}>{item.name}</option>)}
                </optgroup>)}
            </select>
          </div>}

          {editor.kind === 'space' && <div className="fld">
            <label htmlFor="mb-space">連結空間</label>
            <select id="mb-space" value={editor.spaceId} onChange={event => {
              const id = event.target.value;
              const item = spaces.find(row => row.space_id === id);
              setEditor({ ...editor, spaceId: id, label: editor.label.trim() || item?.space_name || '' });
            }}>
              <option value="">— 不連結 —</option>
              {groupBy(spaces, item => item.floor,
                (a, b) => (canonicalFloor(a) === canonicalFloor(curFloor) ? 0 : 1) - (canonicalFloor(b) === canonicalFloor(curFloor) ? 0 : 1)
                  || a.localeCompare(b, 'zh-Hant')).map(([group, items]) =>
                <optgroup key={group} label={`${group}${canonicalFloor(group) === canonicalFloor(curFloor) ? '（本層）' : ''}`}>
                  {items.map(item => <option key={item.space_id} value={item.space_id}>{item.space_name}</option>)}
                </optgroup>)}
            </select>
          </div>}

          {editor.kind === 'repair' && <div className="fld">
            <label htmlFor="mb-repair">連結報修案件</label>
            <select id="mb-repair" value={editor.repairId}
              onChange={event => setEditor({ ...editor, repairId: event.target.value })}>
              <option value="">— 不連結 —</option>
              {groupBy(repairs, item => STAT_LABEL[item.status] || item.status || '其他').map(([group, items]) =>
                <optgroup key={group} label={group}>
                  {items.map(item => <option key={item.request_id} value={item.request_id}>
                    {`${item.req_no ? `${item.req_no} ` : ''}${item.fault_type ? `[${item.fault_type}] ` : ''}${String(item.fault_desc || '').replace(/\n/g, ' ').slice(0, 24)}`}
                  </option>)}
                </optgroup>)}
            </select>
          </div>}

          <div className="fld">
            <label htmlFor="mb-label">標記名稱</label>
            <input id="mb-label" value={editor.label}
              onChange={event => setEditor({ ...editor, label: event.target.value })} />
          </div>
          <div className="fld">
            <label htmlFor="mb-note">備註（選填）</label>
            <textarea id="mb-note" rows={2} value={editor.note}
              onChange={event => setEditor({ ...editor, note: event.target.value })} />
          </div>

          {editor.message && <div className="md-msg">{editor.message}</div>}
          <div className="md-actions">
            {editor.id && <button className="mb-btn danger"
              onClick={() => void deleteMarker(editor.id!, true)}>停用</button>}
            <button className="mb-btn primary" onClick={() => void saveMarker()}>儲存標記</button>
          </div>
        </div>
      </div>
    </div>}
  </div>;
}

/** 依 key 分組並排序群組名稱，用來組出 <optgroup>。 */
function groupBy<T>(rows: T[], keyOf: (row: T) => string, sortGroups?: (a: string, b: string) => number) {
  const map = new Map<string, T[]>();
  rows.forEach(row => {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  });
  return [...map.entries()].sort((a, b) =>
    sortGroups ? sortGroups(a[0], b[0]) : a[0].localeCompare(b[0], 'zh-Hant'));
}
