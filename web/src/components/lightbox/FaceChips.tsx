/**
 * 灯箱详情里的「人物」区：这张图里有谁，以及单张误检的脸怎么改派 / 移除。
 *
 * 之前人脸只做了「按人看全部照片」，反向的「这张照片里有谁」没有出口，
 * 误检也没法修 —— 接口早就有了（/api/images/:id/faces），这里把它接上。
 * 没有人脸时整块不渲染，不占高度也不显示空状态。
 *
 * 被人脸质量门槛自动排除的脸（模糊 / 过小 / 后脑勺）也会显示，带「已排除」标记，
 * 点「收录」即可找回：自动判错时用户永远有手动出口，不必去改代码或重扫。
 * 「不够清晰」是另一档——照常显示、照常算进人物，只是不会当选封面。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, BASE, quiet } from '../../api';
import type { FacePerson } from '../../api';
import Select from '../Select';

type Face = {
  id: number;
  personId: number | null;
  name: string;
  box: number[];
  score: number;
  quality: number;
  hidden: boolean;
  soft: boolean;
};

type Props = {
  imageId: number;
  onToast?: (msg: string, kind?: 'info' | 'error') => void;
};

export default function FaceChips({ imageId, onToast }: Props) {
  const [faces, setFaces] = useState<Face[]>([]);
  const [persons, setPersons] = useState<FacePerson[]>([]);
  const [personsTotal, setPersonsTotal] = useState(0);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(0);
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFaces([]);
    api
      .imageFaces(imageId)
      .then((r) => {
        if (!cancelled) setFaces(r.faces);
      })
      .catch(quiet);
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  // 人物下拉先拉一页；人物上千时靠搜索框按名字/编号查，而不是静默只给前 200 个
  useEffect(() => {
    api
      .facePersons({ limit: 200 })
      .then((r) => {
        setPersons(r.persons);
        setPersonsTotal(r.total ?? r.persons.length);
      })
      .catch(quiet);
  }, []);

  useEffect(() => {
    const needle = q.trim();
    if (!needle) return;
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      api
        .facePersons({ q: needle, limit: 50 })
        .then((r) => {
          setPersons(r.persons);
          setPersonsTotal(r.total ?? r.persons.length);
        })
        .catch(quiet);
    }, 250);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [q]);

  // 当前这张图里的人所在的选项必须始终在列表里，否则下拉会显示成空值
  const options = useMemo(() => {
    const map = new Map<number, FacePerson>();
    for (const p of persons) map.set(p.id, p);
    for (const f of faces) {
      if (f.personId != null && !map.has(f.personId)) {
        map.set(f.personId, { id: f.personId, name: f.name, count: 0, coverFaceId: null });
      }
    }
    return [...map.values()];
  }, [persons, faces]);

  if (!faces.length) return null;

  const reassign = async (face: Face, target: string) => {
    setBusy(face.id);
    try {
      const personId = target === '' ? null : Number(target);
      const r = await api.faceAssign(face.id, personId);
      const name = options.find((p) => p.id === r.personId)?.name || '';
      // 手动归到某个人 = 明确要收录：隐藏标记一起清掉
      setFaces((prev) => prev.map((f) => (f.id === face.id ? { ...f, personId: r.personId, name, hidden: false } : f)));
      onToast?.(target === '' ? '已单独成新人物' : `已改派到「${name || `人物 #${r.personId}`}」`);
    } catch (err) {
      onToast?.(`改派失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(0);
    }
  };

  const setHidden = async (face: Face, hidden: boolean) => {
    setBusy(face.id);
    try {
      await api.faceSetHidden(face.id, hidden);
      setFaces((prev) => prev.map((f) => (f.id === face.id ? { ...f, hidden } : f)));
      onToast?.(hidden ? '已排除这张脸（不显示、不参与聚类）' : '已收录这张脸');
    } catch (err) {
      onToast?.(`操作失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(0);
    }
  };

  const remove = async (face: Face) => {
    setBusy(face.id);
    try {
      await api.faceDelete(face.id);
      setFaces((prev) => prev.filter((f) => f.id !== face.id));
      onToast?.('已移除这张人脸（图片本身不受影响）');
    } catch (err) {
      onToast?.(`移除失败：${(err as Error).message}`, 'error');
    } finally {
      setBusy(0);
    }
  };

  return (
    <section className="lb-group">
      <h5>人物</h5>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={personsTotal > options.length ? `查找人物（共 ${personsTotal} 个）` : '查找人物'}
          title="输入名字或编号查找，避免下拉里只有前 200 个人物"
          // 定高必须同时把上下内边距收掉：.input 自带 9px，加上 height 后内容区只剩个位数，
          // 字会被上下切一半
          style={{ height: 28, padding: '0 10px', fontSize: 12 }}
        />
        {faces.map((f) => {
          // 阈值由服务端给出（hidden=已排除，soft=质量偏低），界面不再抄魔法数字
          const lowQuality = f.hidden || f.soft;
          // 下拉本身就显示当前归属，再单独放一列名字只是白占宽度 —— 窄面板里挤出这句话的头号原因
          const label = f.name || (f.personId ? `人物 #${f.personId}` : '未归类');
          return (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: f.hidden ? 0.6 : 1 }}>
              <img
                src={`${BASE}/api/face/crop/${f.id}?size=64`}
                alt={label}
                loading="lazy"
                style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'cover', background: '#111', flex: '0 0 auto' }}
              />
              {lowQuality && (
                <span
                  title={`质量分 ${f.quality.toFixed(2)}${
                    f.hidden ? '（已被自动排除：模糊/过小/非正脸）' : '（不够清晰：照常显示，但不会当选封面）'
                  }`}
                  style={{
                    fontSize: 10.5,
                    padding: '1px 5px',
                    borderRadius: 5,
                    background: f.hidden ? 'rgba(229,72,77,.14)' : 'rgba(245,166,35,.16)',
                    color: f.hidden ? 'var(--err, #e5484d)' : 'var(--warn, #b7791f)',
                    flex: '0 0 auto',
                  }}
                >
                  {f.hidden ? '已排除' : '不够清晰'}
                </span>
              )}
              {/*
                用自绘下拉而不是原生 <select>：这一格在四列布局里只有一百多像素，
                原生下拉会把「人物 #1290 ·126」连同箭头一起挤扁；自绘的弹层最小 200px
                且带搜索框（库里上千个人物时尤其需要），触发按钮上的文字超长才用省略号。
              */}
              <Select
                value={f.personId ?? ''}
                onChange={(v) => void reassign(f, v)}
                disabled={busy === f.id}
                title={`改派给别的人物（当前：${label}）`}
                style={{ height: 28, padding: '0 8px', fontSize: 12, flex: 1, minWidth: 0 }}
              >
                <option value="">单独成新人物</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || `人物 #${p.id}`}
                    {p.count ? ` ·${p.count}` : ''}
                  </option>
                ))}
              </Select>
              {f.hidden ? (
                <button className="mini" disabled={busy === f.id} title="这张其实是人脸，手动收录" onClick={() => void setHidden(f, false)}>
                  收录
                </button>
              ) : (
                <button
                  className="mini"
                  disabled={busy === f.id}
                  title="不是人脸 / 不想参与聚类"
                  onClick={() => void setHidden(f, true)}
                >
                  排除
                </button>
              )}
              <button className="mini" disabled={busy === f.id} title="从这个人脸记录里彻底删除" onClick={() => void remove(f)}>
                移除
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
