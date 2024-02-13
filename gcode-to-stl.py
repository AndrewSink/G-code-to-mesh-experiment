import math
import numpy as np
from skimage.measure import marching_cubes
from stl import mesh
import trimesh




def interpolate_points(start, end, num_points):
    return [(start[0] + (end[0] - start[0]) * t / (num_points - 1), 
             start[1] + (end[1] - start[1]) * t / (num_points - 1), 
             start[2] + (end[2] - start[2]) * t / (num_points - 1)) for t in range(num_points)]


def calculate_normal(p1, p2):
    # Calculate direction vector
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    # Rotate -90 degrees to get outward normal (clockwise)
    normal_x, normal_y = dy, -dx
    # Normalize the normal vector
    length = math.sqrt(normal_x**2 + normal_y**2)
    if length == 0:  # Avoid division by zero
        return 0, 0, 0
    return normal_x / length, normal_y / length, 0

def parse_gcode(gcode_path, extrusion_width, layer_height):
    points = []
    normals = []
    current_z = 0
    last_position = None
    first_solid_infill = True
    parse_perimeter = False
    parse_infill = False

    with open(gcode_path, 'r') as file:
        for line in file:
            if ';AFTER_LAYER_CHANGE' in line:
                continue
            elif line.startswith(';Z:'):
                current_z = float(line.split(':')[1].strip())
            elif line.startswith('; external perimeters extrusion width'):
                extrusion_width = float(line.split('=')[-1].strip()[:-2]) / 2
            elif line.startswith(';TYPE:External perimeter'):
                parse_perimeter = True
            elif line.startswith(';TYPE:Solid infill') and first_solid_infill:
                parse_infill = True
                first_solid_infill = False
            elif line.startswith(';TYPE:') and (parse_perimeter or parse_infill):
                parse_perimeter = False
                parse_infill = False
            elif (parse_perimeter or parse_infill) and 'G1' in line and ' E' in line:
                parts = line.split()
                x = y = e = None
                for part in parts:
                    if part.startswith('X'):
                        x = float(part[1:])
                    elif part.startswith('Y'):
                        y = float(part[1:])
                    elif part.startswith('E'):
                        e = float(part[1:])
                if x is not None and y is not None and e is not None:
                    current_position = (x, y, current_z)
                    if last_position and (x != last_position[0] or y != last_position[1]):
                        distance = math.sqrt((x - last_position[0]) ** 2 + (y - last_position[1]) ** 2)
                        if distance > layer_height:
                            num_points = int(distance / layer_height) + 1
                            interpolated_points = interpolate_points(last_position, current_position, num_points)
                            for point in interpolated_points:
                                points.append(point)
                                if parse_infill:
                                    normals.append((0, 0, -1))
                                else:
                                    normal = calculate_normal(last_position, point)
                                    normals.append(normal)
                        else:
                            points.append(current_position)
                            if parse_infill:
                                normals.append((0, 0, -1))
                            else:
                                normal = calculate_normal(last_position, current_position)
                                normals.append(normal)
                    last_position = current_position

    return points, normals

def save_to_xyz_with_normals(points, normals, output_path):
     with open(output_path, 'w') as file:
        for point, normal in zip(points, normals):
            file.write(f"{point[0]} {point[1]} {point[2]} {normal[0]} {normal[1]} {normal[2]}\n")
            
def point_cloud_to_voxels(points, voxel_size=0.1, grid_size=100):
    """
    Convert a point cloud to a voxel grid.
    """
    # Create an empty voxel grid
    voxels = np.zeros((grid_size, grid_size, grid_size))
    min_bound = np.min(points, axis=0) - voxel_size
    max_bound = np.max(points, axis=0) + voxel_size
    scales = (max_bound - min_bound) / grid_size
    indices = ((points - min_bound) / scales).astype(int)
    for index in indices:
        voxels[index[0], index[1], index[2]] = 1
    return voxels

def voxels_to_stl(voxels, points, stl_file_name, flip_normals=True):
    """
    Convert a voxel grid to an STL file using the Marching Cubes algorithm, ensuring the output matches the original scale.

    :param voxels: Voxel grid as a 3D numpy array.
    :param points: Original point cloud used to create the voxel grid.
    :param stl_file_name: Name of the output STL file.
    :param flip_normals: Whether to flip the normals of the triangles.
    """
    # Calculate the scale factors based on the point cloud dimensions and the voxel grid
    min_bound = np.min(points, axis=0)
    max_bound = np.max(points, axis=0)
    scales = (max_bound - min_bound) / np.array(voxels.shape)

    verts, faces, _, _ = marching_cubes(voxels)
    
    # Scale vertices back to the original point cloud dimensions
    verts = verts * scales + min_bound

    stl_mesh = mesh.Mesh(np.zeros(faces.shape[0], dtype=mesh.Mesh.dtype))

    if flip_normals:
        # Reverse the order of vertices for each face to flip normals
        faces = faces[:, ::-1]

    for i, f in enumerate(faces):
        for j in range(3):
            stl_mesh.vectors[i][j] = verts[f[j], :]

    stl_mesh.save(stl_file_name)

# Example usage

gcode_path = 'bust.gcode' #add your gcode file here: "your_gcode_here.gcode"
output_path = 'point_cloud.xyz'
extrusion_width = 0.45
layer_height = 0.2

points, normals = parse_gcode(gcode_path, extrusion_width, layer_height)
save_to_xyz_with_normals(points, normals, output_path)

# Convert the point cloud to a voxel grid and export as STL
# Note: Convert `points` to a numpy array for processing
points_np = np.array(points)
voxel_grid = point_cloud_to_voxels(points_np)
voxels_to_stl(voxel_grid, points_np, 'output_mesh.stl', flip_normals=True)