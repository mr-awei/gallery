import { useEffect, useRef, useState } from 'react';
import type { ImageItem } from '../types';

interface Props {
  item: ImageItem;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
}

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/**
 * 3D 模型预览（Eagle 同款：拖一拖看结构）。
 * three.js 按需动态 import，只有真的打开 3D 素材才加载这块 chunk，不影响图库首屏。
 * 支持 glb / gltf / obj / stl / ply / fbx，缺失材质时补一套中性 PBR 材质。
 */
export default function ModelViewer({ item, onToast }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ext = extOf(item.title);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let teardown = () => {};

    setLoading(true);
    setError('');

    (async () => {
      const THREE = await import('three');
      const [{ OrbitControls }, { GLTFLoader }, { OBJLoader }, { STLLoader }, { PLYLoader }] = await Promise.all([
        import('three/examples/jsm/controls/OrbitControls.js'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/loaders/OBJLoader.js'),
        import('three/examples/jsm/loaders/STLLoader.js'),
        import('three/examples/jsm/loaders/PLYLoader.js'),
      ]);
      if (disposed) return;

      const width = host.clientWidth || 900;
      const height = host.clientHeight || 560;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(width, height);
      renderer.domElement.className = 'mv-3d-canvas';
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 100000);
      camera.position.set(2.4, 1.8, 3.2);

      scene.add(new THREE.HemisphereLight(0xffffff, 0x272733, 2.2));
      const key = new THREE.DirectionalLight(0xffffff, 2.1);
      key.position.set(3, 5, 4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x8fb4ff, 0.8);
      fill.position.set(-4, -2, -3);
      scene.add(fill);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.85;
      controls.zoomSpeed = 0.9;

      const fallbackMaterial = new THREE.MeshStandardMaterial({
        color: 0xb9bccb,
        roughness: 0.42,
        metalness: 0.25,
        side: THREE.DoubleSide,
      });

      const fit = (object: import('three').Object3D) => {
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const dist = maxDim * 1.9;
        camera.position.set(dist * 0.75, dist * 0.5, dist * 0.75);
        camera.near = maxDim / 200;
        camera.far = maxDim * 200;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      };

      const done = (object: import('three').Object3D) => {
        if (disposed) return;
        scene.add(object);
        fit(object);
        setLoading(false);
      };

      const fail = (err: unknown) => {
        if (disposed) return;
        const msg = (err as Error)?.message || String(err);
        setError(msg);
        setLoading(false);
        onToast?.(`3D 预览失败：${msg}`);
      };

      /* 无材质的几何体（stl/ply/obj）统一补中性材质，避免打开是纯黑 */
      const applyFallback = (root: import('three').Object3D) => {
        root.traverse((child) => {
          const mesh = child as import('three').Mesh;
          if (mesh.isMesh && !mesh.material) mesh.material = fallbackMaterial;
        });
      };

      const url = item.url;
      if (ext === 'glb' || ext === 'gltf') {
        new GLTFLoader().load(url, (gltf) => done(gltf.scene), undefined, fail);
      } else if (ext === 'obj') {
        new OBJLoader().load(
          url,
          (obj) => {
            applyFallback(obj);
            done(obj);
          },
          undefined,
          fail
        );
      } else if (ext === 'stl') {
        new STLLoader().load(
          url,
          (geo) => {
            const mesh = new THREE.Mesh(geo, fallbackMaterial);
            mesh.geometry.computeVertexNormals();
            done(mesh);
          },
          undefined,
          fail
        );
      } else if (ext === 'ply') {
        new PLYLoader().load(
          url,
          (geo) => {
            geo.computeVertexNormals();
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb9bccb, vertexColors: !!geo.getAttribute('color'), roughness: 0.5, side: THREE.DoubleSide }));
            done(mesh);
          },
          undefined,
          fail
        );
      } else if (ext === 'fbx') {
        const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
        new FBXLoader().load(url, (obj) => done(obj), undefined, fail);
      } else if (ext === '3ds') {
        const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js');
        new TDSLoader().load(url, (obj) => {
          applyFallback(obj);
          done(obj);
        }, undefined, fail);
      } else if (ext === 'dae') {
        const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
        new ColladaLoader().load(url, (dae) => {
          if (!dae) return fail(new Error('.dae 解析结果为空'));
          applyFallback(dae.scene);
          done(dae.scene);
        }, undefined, fail);
      } else {
        fail(new Error(`暂不支持 .${ext} 格式，可转成 glb / obj / fbx / stl / 3ds / dae 再入库`));
      }

      const onResize = () => {
        if (!host) return;
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(host);

      renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
      });

      teardown = () => {
        try {
          renderer.setAnimationLoop(null);
          ro.disconnect();
          controls.dispose();
          scene.traverse((obj) => {
            const mesh = obj as import('three').Mesh;
            if (mesh.isMesh) {
              mesh.geometry?.dispose?.();
              const mat = mesh.material;
              if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
              else mat?.dispose?.();
            }
          });
          renderer.dispose();
          renderer.domElement.remove();
        } catch {
          /* 卸载失败不影响主流程 */
        }
      };
    })().catch((err) => {
      if (disposed) return;
      setError((err as Error).message || '加载 3D 引擎失败');
      setLoading(false);
    });

    return () => {
      disposed = true;
      teardown();
    };
  }, [item.id, item.url, ext, onToast]);

  return (
    <div className="mv-3d" ref={hostRef}>
      {loading && <div className="mv-3d-tip">正在加载 3D 模型…</div>}
      {error && (
        <div className="mv-fallback mv-3d-error">
          <div className="mv-fallback-icon">🧊</div>
          <b>{item.title}</b>
          <p>{error}</p>
        </div>
      )}
      {!loading && !error && <div className="mv-3d-hint">拖动旋转 · 滚轮缩放 · 右键平移</div>}
    </div>
  );
}
