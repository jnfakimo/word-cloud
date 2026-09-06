import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { perspectiveFitDistance } from './perspective-fit.ts';

test('actual Three.js projection keeps every floor corner inside portrait and landscape frames', () => {
  for (const [width, height] of [[320, 760], [375, 762], [812, 325], [1280, 720]]) {
    for (const [minY, maxY] of [[0, 9.6], [0, 0], [-4, 22], [6, 6]]) {
      for (const direction of [[9, 9, 12], [0.001, 1, 0], [-5, 3, -12]] as const) {
        for (const pan of [0, 3]) {
          const target = [pan, (minY + maxY) / 2 + pan, 0] as const;
          const camera = new PerspectiveCamera(45, width / height, 0.1, 2000);
          const distance = perspectiveFitDistance({ min: [-5, minY - 0.05, -3.5], max: [5, maxY + 0.3, 3.5], target, direction, fov: 45, aspect: camera.aspect });
          camera.position.fromArray(target).addScaledVector(new Vector3(...direction).normalize(), distance);
          camera.lookAt(new Vector3(...target));
          camera.updateMatrixWorld();
          for (const x of [-5, 5]) for (const y of [minY, maxY]) for (const z of [-3.5, 3.5]) {
            const projected = new Vector3(x, y, z).project(camera);
            assert.ok(Math.abs(projected.x) < 0.88 && Math.abs(projected.y) < 0.88,
              `clipped at ${width}x${height}: ${JSON.stringify(projected)}`);
            assert.ok(projected.z > -1 && projected.z < 1, 'outside clipping planes');
          }
        }
      }
    }
  }
});

test('portrait distance increases to account for the narrower horizontal field of view', () => {
  const box = { min: [-5, 0, -3.5] as const, max: [5, 9.6, 3.5] as const, target: [0, 4.8, 0] as const, direction: [9, 9, 12] as const, fov: 45 };
  assert.ok(perspectiveFitDistance({ ...box, aspect: 375 / 762 }) > perspectiveFitDistance({ ...box, aspect: 1280 / 720 }));
});
