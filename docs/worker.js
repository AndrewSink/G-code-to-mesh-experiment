/**
 * worker.js  -  Web Worker for G-code -> voxel -> Marching Cubes -> STL
 *
 * Receives:
 *   { type: 'process', payload: { gcodeBuffer: ArrayBuffer,
 *                                  voxelSize: number,
 *                                  gridSize: number,
 *                                  flipNormals: boolean } }
 *   gcodeBuffer is transferred (zero-copy) from the main thread.
 *
 * Sends back:
 *   { type: 'progress', stage, pct }          (multiple)
 *   { type: 'result',   payload: { vertsBuffer, facesBuffer, stlBuffer, stats } }
 *   { type: 'error',    message }
 */

import { marchingCubes } from './marching-cubes.js';

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = function (e) {
  const { type, payload } = e.data;
  if (type !== 'process') return;

  try {
    const { gcodeBuffer, voxelSize, gridSize, flipNormals } = payload;
    const t0 = performance.now();

    // ------------------------------------------------------------------ 1. Parse
    post('progress', { stage: 'parsing', pct: 0, detail: 'Reading G-code...' });
    const { pointData, pointCount, rawMinBound, rawMaxBound } =
      parseGcode(gcodeBuffer, (pct) =>
        post('progress', { stage: 'parsing', pct, detail: 'Parsing G-code...' }));

    const t1 = performance.now();
    post('progress', { stage: 'parsing', pct: 100,
      detail: `Parsed ${pointCount.toLocaleString()} points (${((t1-t0)/1000).toFixed(1)}s)` });

    // ------------------------------------------------------------------ 2. Voxelize
    post('progress', { stage: 'voxelizing', pct: 0, detail: 'Building voxel grid...' });
    const { voxels, paddedMin, scales } =
      buildVoxelGrid(pointData, pointCount, voxelSize, gridSize, (pct) =>
        post('progress', { stage: 'voxelizing', pct, detail: 'Voxelizing...' }));

    const t2 = performance.now();
    post('progress', { stage: 'voxelizing', pct: 100,
      detail: `Voxelized ${gridSize}^3 grid (${((t2-t1)/1000).toFixed(1)}s)` });

    // ------------------------------------------------------------------ 3. Marching Cubes
    post('progress', { stage: 'marching', pct: 0, detail: 'Running Marching Cubes...' });
    let { verts, faces } = marchingCubes(voxels, gridSize, (pct) =>
      post('progress', { stage: 'marching', pct, detail: 'Marching Cubes...' }));

    // Scale vertices from grid space back to world space.
    // Uses raw (unpadded) bounds to match Python voxels_to_stl lines 113-115.
    scaleVerts(verts, rawMinBound, rawMaxBound, gridSize);

    // Flip normals by reversing face winding (matches Python flip_normals=True)
    if (flipNormals) flipFaceWinding(faces);

    const t3 = performance.now();
    const triCount = faces.length / 3;
    post('progress', { stage: 'marching', pct: 100,
      detail: `Generated ${triCount.toLocaleString()} triangles (${((t3-t2)/1000).toFixed(1)}s)` });

    // ------------------------------------------------------------------ 4. Binary STL
    const stlBuffer = buildBinarySTL(verts, faces);

    const totalMs = Math.round(t3 - t0);
    const stats = { pointCount, triCount, timeMs: totalMs };

    // Transfer large typed arrays to main thread (zero-copy)
    self.postMessage(
      { type: 'result', payload: { vertsBuffer: verts, facesBuffer: faces, stlBuffer, stats } },
      [verts.buffer, faces.buffer, stlBuffer]
    );

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

function post(type, extra) {
  self.postMessage({ type, ...extra });
}

// ---------------------------------------------------------------------------
// G-code parser  (port of parse_gcode() in gcode-to-stl.py)
// ---------------------------------------------------------------------------

function parseGcode(gcodeBuffer, progressCb) {
  const bytes = new Uint8Array(gcodeBuffer);
  const len = bytes.length;

  // Point accumulator (Float32Array with doubling strategy)
  let ptCap = 500_000;
  let pointData = new Float32Array(ptCap * 3);
  let pointCount = 0;

  function growPoints() {
    const next = new Float32Array(ptCap * 2 * 3);
    next.set(pointData);
    pointData = next;
    ptCap *= 2;
  }

  function pushPoint(x, y, z) {
    if (pointCount >= ptCap) growPoints();
    const i = pointCount * 3;
    pointData[i] = x; pointData[i+1] = y; pointData[i+2] = z;
    pointCount++;
  }

  // State
  let currentZ = 0;
  let lastX = 0, lastY = 0, lastZ = 0;
  let hasLast = false;
  let parsePerimeter = false;
  let parseInfill = false;
  let firstSolidInfill = true;
  // extrusionWidth parsed from gcode but not used in the voxel pipeline
  // layerHeight used for interpolation density
  const layerHeight = 0.2;

  // Scan line by line without allocating strings where possible.
  // Decode line bytes -> string only when the line looks relevant.
  let lineStart = 0;
  let lineNum = 0;

  // TextDecoder for extracting line strings (reused)
  const decoder = new TextDecoder('utf-8', { fatal: false });

  for (let i = 0; i <= len; i++) {
    const ch = (i < len) ? bytes[i] : 0x0a;  // treat EOF as newline
    if (ch !== 0x0a) continue;

    // We have a line: bytes[lineStart .. i)
    const lineLen = i - lineStart;
    if (lineLen === 0) { lineStart = i + 1; lineNum++; continue; }

    const firstByte = bytes[lineStart];

    // Fast-path: skip lines that can't be relevant
    // Relevant first bytes: ';' (comment) or 'G' (movement)
    if (firstByte !== 0x3b /* ; */ && firstByte !== 0x47 /* G */) {
      lineStart = i + 1; lineNum++;
      if (lineNum % 20000 === 0) progressCb(i / len * 100);
      continue;
    }

    // Decode only lines starting with ';' or 'G'
    const line = decoder.decode(bytes.subarray(lineStart, i)).trimEnd();
    lineStart = i + 1;
    lineNum++;

    if (lineNum % 20000 === 0) progressCb(i / len * 100);

    // ---- Comment lines ----
    if (line.charAt(0) === ';') {
      if (line.includes(';AFTER_LAYER_CHANGE')) {
        // skip
      } else if (line.startsWith(';Z:')) {
        currentZ = parseFloat(line.slice(3));
      } else if (line.startsWith('; external perimeters extrusion width')) {
        // e.g. "; external perimeters extrusion width = 0.45mm"
        const eq = line.indexOf('=');
        if (eq !== -1) {
          // strip trailing "mm" and parse
          const valStr = line.slice(eq + 1).trim().replace(/mm$/, '');
          // divide by 2 as in Python
          // (not consumed downstream in voxel pipeline, but kept for fidelity)
          // extrusionWidth = parseFloat(valStr) / 2;
        }
      } else if (line.startsWith(';TYPE:External perimeter')) {
        parsePerimeter = true;
        parseInfill = false;
      } else if (line.startsWith(';TYPE:Solid infill')) {
        if (firstSolidInfill) {
          parseInfill = true;
          firstSolidInfill = false;
          parsePerimeter = false;
        } else {
          parseInfill = false;
          parsePerimeter = false;
        }
      } else if (line.startsWith(';TYPE:') && (parsePerimeter || parseInfill)) {
        parsePerimeter = false;
        parseInfill = false;
      }
      continue;
    }

    // ---- G1 movement lines ----
    if (!(parsePerimeter || parseInfill)) continue;
    if (!line.startsWith('G1')) continue;
    if (!line.includes(' E')) continue;  // only extruding moves

    // Parse X, Y, E from the line
    let x = null, y = null;
    const parts = line.split(' ');
    for (const part of parts) {
      if (part.length < 2) continue;
      const fc = part.charAt(0);
      if (fc === 'X') x = parseFloat(part.slice(1));
      else if (fc === 'Y') y = parseFloat(part.slice(1));
    }

    if (x === null || y === null) continue;

    const z = currentZ;

    if (hasLast && (x !== lastX || y !== lastY)) {
      const dx = x - lastX;
      const dy = y - lastY;
      const dist = Math.sqrt(dx*dx + dy*dy);

      if (dist > layerHeight) {
        const numPts = Math.floor(dist / layerHeight) + 1;
        for (let t = 0; t < numPts; t++) {
          const frac = (numPts === 1) ? 0 : t / (numPts - 1);
          pushPoint(
            lastX + dx * frac,
            lastY + dy * frac,
            lastZ + (z - lastZ) * frac
          );
        }
      } else {
        pushPoint(x, y, z);
      }
    }

    lastX = x; lastY = y; lastZ = z;
    hasLast = true;
  }

  // Compute raw (unpadded) bounding box for use in vertex scaling
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pointCount; i++) {
    const px = pointData[i*3], py = pointData[i*3+1], pz = pointData[i*3+2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }

  return {
    pointData: pointData.slice(0, pointCount * 3),
    pointCount,
    rawMinBound: [minX, minY, minZ],
    rawMaxBound: [maxX, maxY, maxZ],
  };
}

// ---------------------------------------------------------------------------
// Voxelizer  (port of point_cloud_to_voxels() in gcode-to-stl.py)
// ---------------------------------------------------------------------------

function buildVoxelGrid(pointData, pointCount, voxelSize, G, progressCb) {
  // Compute padded bounds for grid mapping (matching Python lines 95-97)
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pointCount; i++) {
    const px = pointData[i*3], py = pointData[i*3+1], pz = pointData[i*3+2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }

  const paddedMinX = minX - voxelSize;
  const paddedMinY = minY - voxelSize;
  const paddedMinZ = minZ - voxelSize;
  const paddedMaxX = maxX + voxelSize;
  const paddedMaxY = maxY + voxelSize;
  const paddedMaxZ = maxZ + voxelSize;

  const scaleX = (paddedMaxX - paddedMinX) / G;
  const scaleY = (paddedMaxY - paddedMinY) / G;
  const scaleZ = (paddedMaxZ - paddedMinZ) / G;

  const G2 = G * G;
  const voxels = new Uint8Array(G * G2);  // G^3

  for (let i = 0; i < pointCount; i++) {
    const px = pointData[i*3], py = pointData[i*3+1], pz = pointData[i*3+2];
    const ix = Math.min(G - 1, Math.max(0, Math.floor((px - paddedMinX) / scaleX)));
    const iy = Math.min(G - 1, Math.max(0, Math.floor((py - paddedMinY) / scaleY)));
    const iz = Math.min(G - 1, Math.max(0, Math.floor((pz - paddedMinZ) / scaleZ)));
    voxels[ix * G2 + iy * G + iz] = 1;

    if (i % 100_000 === 0) progressCb(i / pointCount * 100);
  }

  return {
    voxels,
    paddedMin: [paddedMinX, paddedMinY, paddedMinZ],
    scales: [scaleX, scaleY, scaleZ],
  };
}

// ---------------------------------------------------------------------------
// Scale vertices from grid space back to world space
// Uses unpadded rawMinBound / rawMaxBound, matching Python voxels_to_stl lines 113-115
// ---------------------------------------------------------------------------

function scaleVerts(verts, rawMin, rawMax, G) {
  const sx = (rawMax[0] - rawMin[0]) / G;
  const sy = (rawMax[1] - rawMin[1]) / G;
  const sz = (rawMax[2] - rawMin[2]) / G;
  for (let i = 0; i < verts.length; i += 3) {
    verts[i]   = verts[i]   * sx + rawMin[0];
    verts[i+1] = verts[i+1] * sy + rawMin[1];
    verts[i+2] = verts[i+2] * sz + rawMin[2];
  }
}

// ---------------------------------------------------------------------------
// Flip face winding order (reverses normals, matching Python flip_normals=True)
// ---------------------------------------------------------------------------

function flipFaceWinding(faces) {
  for (let i = 0; i < faces.length; i += 3) {
    const tmp = faces[i+1];
    faces[i+1] = faces[i+2];
    faces[i+2] = tmp;
  }
}

// ---------------------------------------------------------------------------
// Binary STL encoder
// Header (80 bytes) + tri count (4 bytes) + N * 50 bytes per triangle
// ---------------------------------------------------------------------------

function buildBinarySTL(verts, faces) {
  const triCount = faces.length / 3;
  const buffer = new ArrayBuffer(80 + 4 + triCount * 50);
  const view = new DataView(buffer);

  // Write "G-code to Mesh" in the header
  const headerStr = 'G-code to Mesh Web App';
  for (let ci = 0; ci < headerStr.length && ci < 80; ci++) {
    view.setUint8(ci, headerStr.charCodeAt(ci));
  }

  let off = 80;
  view.setUint32(off, triCount, true);
  off += 4;

  for (let t = 0; t < triCount; t++) {
    const ai = faces[t*3]   * 3;
    const bi = faces[t*3+1] * 3;
    const ci = faces[t*3+2] * 3;

    const ax = verts[ai], ay = verts[ai+1], az = verts[ai+2];
    const bx = verts[bi], by = verts[bi+1], bz = verts[bi+2];
    const cx = verts[ci], cy = verts[ci+1], cz = verts[ci+2];

    // Face normal (cross product of two edges)
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    let nx = uy*vz - uz*vy;
    let ny = uz*vx - ux*vz;
    let nz = ux*vy - uy*vx;
    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    view.setFloat32(off, nx, true); off += 4;
    view.setFloat32(off, ny, true); off += 4;
    view.setFloat32(off, nz, true); off += 4;

    view.setFloat32(off, ax, true); off += 4;
    view.setFloat32(off, ay, true); off += 4;
    view.setFloat32(off, az, true); off += 4;
    view.setFloat32(off, bx, true); off += 4;
    view.setFloat32(off, by, true); off += 4;
    view.setFloat32(off, bz, true); off += 4;
    view.setFloat32(off, cx, true); off += 4;
    view.setFloat32(off, cy, true); off += 4;
    view.setFloat32(off, cz, true); off += 4;

    view.setUint16(off, 0, true); off += 2;
  }

  return buffer;
}
