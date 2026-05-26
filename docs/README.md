# G-code to Mesh - Web App

Browser-based port of `gcode-to-stl.py`. Runs entirely client-side - no server, no build step.

## Usage

1. Serve the `web/` directory over HTTP (required for ES module workers):
   ```
   python -m http.server 8080
   ```
   Then open `http://localhost:8080/web/` in a browser.

2. Drop a `.gcode` file onto the drop zone (or click to browse).

3. Adjust settings if desired:
   - **Voxel padding** - margin added around the point cloud bounds (default 0.1 mm)
   - **Grid size** - voxel grid resolution (default 100; higher = finer mesh, slower)
   - **Flip normals** - reverses face winding (matches Python default `flip_normals=True`)

4. Click **Process**. Progress is shown for each stage: parsing, voxelizing, meshing.

5. Inspect the mesh in the 3D viewer (left-drag: rotate, scroll: zoom, right-drag: pan).

6. Click **Export STL** to download the result.

## Files

| File | Purpose |
|------|---------|
| `index.html` | UI (Tailwind CSS via CDN), three.js scene, worker controller |
| `worker.js` | Web Worker: G-code parser, voxelizer, binary STL encoder |
| `marching-cubes.js` | Standard Lorensen-Cline MC with edge/tri lookup tables |

## Pipeline

Same four stages as the Python script:

1. **Parse G-code** - extracts external perimeter and first solid-infill toolpaths
2. **Voxelize** - maps points into a 3D binary grid (`Uint8Array`)
3. **Marching Cubes** - extracts the iso-surface at level 0.5
4. **Export** - encodes binary STL; three.js renders with `computeVertexNormals()`

Heavy computation runs in a Web Worker to keep the UI responsive.
