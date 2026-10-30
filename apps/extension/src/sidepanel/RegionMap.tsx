// Approximate area of a photo's GPS tag, drawn from a few OpenStreetMap tiles. Nothing is requested
// until the user asks: tile requests tell the tile server which area is being looked at (D-036).
// The coordinates are already rounded to ~11 km by the engine, and the zoom can't show a street.
import { useState } from "react";
import type { GpsSummary } from "@redactguard/core/schemas";

const ZOOM = 9;
const TILE = 256;
const WIDTH = 348;
const HEIGHT = 180;
/** Matches the ~11 km rounding: the circle says "somewhere around here", not a pin. */
const AREA_RADIUS_M = 8000;

/** Web Mercator: a coordinate's position in pixels on the whole-world map at ZOOM. */
function worldPixel(lat: number, lon: number): { x: number; y: number } {
  const scale = TILE * 2 ** ZOOM;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

export function RegionMap({ gps }: { gps: GpsSummary }) {
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <div className="mt-2 rounded-md border border-rule px-3 py-2.5">
        <button onClick={() => setShown(true)}
          className="font-medium text-ink underline decoration-rule underline-offset-2 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          Show approximate area on a map
        </button>
        <p className="mt-0.5 text-[12px] text-muted">Loads map images from OpenStreetMap. They see which area you view, not your file.</p>
      </div>
    );
  }

  const n = 2 ** ZOOM;
  const c = worldPixel(gps.coarseLat, gps.coarseLon);
  const left = c.x - WIDTH / 2;
  const top = c.y - HEIGHT / 2;
  const tiles: { key: string; src: string; x: number; y: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + HEIGHT) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + WIDTH) / TILE); tx++) {
      const wrapped = ((tx % n) + n) % n;
      tiles.push({ key: `${tx}/${ty}`, src: `https://tile.openstreetmap.org/${ZOOM}/${wrapped}/${ty}.png`, x: tx * TILE - left, y: ty * TILE - top });
    }
  }
  const metresPerPixel = (156543.03392 * Math.cos((gps.coarseLat * Math.PI) / 180)) / n;
  const r = AREA_RADIUS_M / metresPerPixel;

  return (
    <figure className="mt-2">
      <div className="relative overflow-hidden rounded-md border border-rule bg-wash" style={{ width: "100%", maxWidth: WIDTH, height: HEIGHT }}
        role="img" aria-label={`Map of the area around ${gps.coarseLat.toFixed(1)}, ${gps.coarseLon.toFixed(1)}`}>
        {tiles.map((t) => (
          <img key={t.key} src={t.src} alt="" width={TILE} height={TILE} referrerPolicy="no-referrer" draggable={false}
            className="absolute max-w-none select-none" style={{ left: t.x, top: t.y }} />
        ))}
        <span className="absolute rounded-full border-2 border-stop bg-stop/15"
          style={{ left: WIDTH / 2 - r, top: HEIGHT / 2 - r, width: r * 2, height: r * 2 }} />
      </div>
      <figcaption className="mt-1 text-[12px] text-muted">
        Somewhere in this area, to about 10 km. The exact point stays on your device and is removed when you clean the file. Map © OpenStreetMap contributors.
      </figcaption>
    </figure>
  );
}
