/** 底部状态栏：采集状态 / 统计 / 导入进度 / 打开保存目录（在文件夹里时打开当前文件夹）。 */
import type { Stats } from '../types';
import i18n from '../i18n';

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
        {crawling ? i18n.t('k8a61119d') : i18n.t('k87bb5bbc')}
      </span>
      <span>总图片 {stats?.total ?? 0}</span>
      <span>收藏 {stats?.favorite ?? 0}</span>
      {importing && <span>{i18n.t('k162a4d70')}</span>}
      <span className="spacer" />
      <button
        className="btn sm ghost"
        onClick={onOpenFolder}
        title={folderName ? i18n.t('k453e9f25', { p0: folderName }) : i18n.t('kdd7050b4')}
      >
        {folderName ? i18n.t('k9068f519') : i18n.t('ke13dba5b')}
      </button>
      {!isDesktop && <span>网页模式 http://localhost:3001</span>}
    </footer>
  );
}
