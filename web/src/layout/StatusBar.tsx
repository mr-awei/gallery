/** 底部状态栏：采集状态 / 统计 / 导入进度 / 打开保存目录（在文件夹里时打开当前文件夹）。 */
import type { Stats } from '../types';

interface Props {
  crawling: boolean;
  stats: Stats | null;
  importing: boolean;
  isDesktop: boolean;
  /** 当前所在文件夹名；为空表示在整库视图，按钮打开的是库根 */
  folderName?: string | null;
  onOpenFolder: () => void;
}

export default function StatusBar({ crawling, stats, importing, isDesktop, folderName, onOpenFolder }: Props) {
  return (
    <footer className="statusbar">
      <span>
        <i className={`dot${crawling ? ' busy' : ''}`} />
        {crawling ? '采集进行中' : '空闲'}
      </span>
      <span>总图片 {stats?.total ?? 0}</span>
      <span>收藏 {stats?.favorite ?? 0}</span>
      {importing && <span>本地素材导入中…</span>}
      <span className="spacer" />
      <button
        className="btn sm ghost"
        onClick={onOpenFolder}
        title={folderName ? `在资源管理器里打开「${folderName}」` : '在资源管理器里打开素材保存目录'}
      >
        {folderName ? '打开当前文件夹' : '打开保存文件夹'}
      </button>
      {!isDesktop && <span>网页模式 http://localhost:3001</span>}
    </footer>
  );
}
