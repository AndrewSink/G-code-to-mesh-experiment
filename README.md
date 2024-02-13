# .gcode to .STL Mesh Converter

This project provides a Python script that converts .gcode files into STL files, focusing specifically on capturing points along the outer contour of the print, avoiding internal toolpaths. 

This is particularly useful for 3D printing applications where you need to create a 3D model from G-code for visualization, analysis, or printing.

Continuing the work from [Josef Prusa's original idea](https://twitter.com/josefprusa/status/1756725962153292136)!

![render2](https://github.com/AndrewSink/G-code-to-mesh-experiment/assets/46334898/2f4d40d0-af93-4270-85cc-c1190e4544be)

## Install Dependencies
pip install numpy scikit-image numpy-stl trimesh
