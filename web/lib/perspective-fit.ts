type Point3 = readonly [number, number, number];

/** Distance along the viewing direction that keeps every box corner in frame. */
export function perspectiveFitDistance({ min, max, target, direction, fov, aspect, margin = 1.15 }: {
  min: Point3; max: Point3; target: Point3; direction: Point3;
  fov: number; aspect: number; margin?: number;
}) {
  const length = Math.hypot(...direction);
  const back = direction.map(v => v / length);
  const horizontal = Math.hypot(back[0], back[2]);
  const right = horizontal > 0 ? [back[2] / horizontal, 0, -back[0] / horizontal] : [1, 0, 0];
  const up = [back[1] * right[2], back[2] * right[0] - back[0] * right[2], -back[1] * right[0]];
  const tanY = Math.tan(fov * Math.PI / 360);
  const tanX = tanY * aspect;
  let distance = 0;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const offset = [x - target[0], y - target[1], z - target[2]];
    const dot = (axis: number[]) => offset.reduce((sum, value, index) => sum + value * axis[index], 0);
    distance = Math.max(distance, dot(back) + margin * Math.max(Math.abs(dot(right)) / tanX, Math.abs(dot(up)) / tanY));
  }
  return Math.max(0.1, distance);
}
