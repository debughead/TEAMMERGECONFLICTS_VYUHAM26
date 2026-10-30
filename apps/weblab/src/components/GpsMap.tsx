// Region-level map of a photo's GPS tag. The engine only ever returns coordinates rounded to ~11 km,
// and tiles load at a zoom that can't pinpoint a house (tile requests reveal the area viewed).
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GpsSummary } from "@redactguard/core";

const REGION_ZOOM = 9;

export function GpsMap({ gps }: { gps: GpsSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const map = L.map(ref.current, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, maxZoom: REGION_ZOOM })
      .setView([gps.coarseLat, gps.coarseLon], REGION_ZOOM);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: REGION_ZOOM, attribution: "© OpenStreetMap" }).addTo(map);
    L.circle([gps.coarseLat, gps.coarseLon], { radius: 8000, color: "#dc2626" }).addTo(map);
    return () => { map.remove(); };
  }, [gps]);
  return (
    <div>
      <div ref={ref} className="h-56 w-full rounded-lg border border-slate-200" />
      <p className="mt-1 text-xs text-slate-500">Approximate area only. The exact location stays on your device and is removed when you clean the photo.</p>
    </div>
  );
}
